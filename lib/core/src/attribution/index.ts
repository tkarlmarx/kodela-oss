// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Universal attribution pipeline for Gap 15b.
 *
 * Determines which AI tool last wrote a set of files by running through a
 * prioritised list of detection layers. Each layer produces an attribution
 * result with a confidence score; the pipeline returns the first non-null
 * result and falls through gracefully to the next layer on failure.
 *
 * Security guardrails:
 *  - Only env vars from ALLOWED_ENV_VARS are ever read.
 *  - Process data is never stored — only PID/binary name is used.
 *  - Sidecar files are validated against a size limit before parsing.
 *  - No network calls are made anywhere in this module.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Confidence constants
// ---------------------------------------------------------------------------

export const ATTRIBUTION_CONFIDENCE = {
  KODELA_AGENT_ENV: 1.0,
  SIDECAR: 0.95,
  VSCODE_COMMAND: 0.9,
  /**
   * Gap 23 B2: Downgraded from 0.85 → 0.50.
   * An IDE environment variable being set is weak evidence compared to an
   * explicit KODELA_AGENT signal. The env says which IDE is open, not who
   * typed the code. This prevents the "env presence = certainty" false positive.
   */
  KNOWN_AGENT_ENV: 0.50,
  GIT_TRAILER: 0.75,
  PROCESS_ANCESTRY: 0.7,
  HEURISTIC: 0.5,
  NONE: 0.0,
} as const;

// ---------------------------------------------------------------------------
// Security: env var allowlist
// ---------------------------------------------------------------------------

/**
 * Only these env var names are ever read by the attribution pipeline.
 * Never read arbitrary env vars — this is an enterprise security requirement.
 */
const ALLOWED_ENV_VARS = new Set([
  "KODELA_AGENT",
  "CURSOR_TRACE_ID",
  "CURSOR_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "ANTHROPIC_SESSION_ID",
  "REPL_ID",
  "REPL_SLUG",
  "REPLIT_DEV_DOMAIN",
  "AIDER_MODEL",
  "AIDER_CHAT_ID",
  "CODEX_SESSION_ID",
  "OPENAI_SESSION_ID",
  "WINDSURF_SESSION_ID",
  "PLANDEX_SESSION_ID",
]);

function safeGetEnv(key: string): string | undefined {
  if (!ALLOWED_ENV_VARS.has(key)) return undefined;
  return process.env[key];
}

// ---------------------------------------------------------------------------
// Known agent env var → aiTool mapping
// ---------------------------------------------------------------------------

const AGENT_ENV_MAP: ReadonlyArray<{
  envVar: string;
  aiTool: string;
  isSessionId: boolean;
}> = [
  { envVar: "CURSOR_TRACE_ID", aiTool: "cursor", isSessionId: true },
  { envVar: "CURSOR_SESSION_ID", aiTool: "cursor", isSessionId: true },
  { envVar: "CLAUDE_SESSION_ID", aiTool: "claude-code", isSessionId: true },
  { envVar: "ANTHROPIC_SESSION_ID", aiTool: "claude-code", isSessionId: true },
  { envVar: "REPL_ID", aiTool: "replit-agent", isSessionId: true },
  { envVar: "REPLIT_DEV_DOMAIN", aiTool: "replit-agent", isSessionId: false },
  { envVar: "REPL_SLUG", aiTool: "replit-agent", isSessionId: false },
  { envVar: "AIDER_MODEL", aiTool: "aider", isSessionId: false },
  { envVar: "AIDER_CHAT_ID", aiTool: "aider", isSessionId: true },
  { envVar: "CODEX_SESSION_ID", aiTool: "codex", isSessionId: true },
  { envVar: "OPENAI_SESSION_ID", aiTool: "codex", isSessionId: true },
  { envVar: "WINDSURF_SESSION_ID", aiTool: "windsurf", isSessionId: true },
  { envVar: "PLANDEX_SESSION_ID", aiTool: "plandex", isSessionId: true },
];

// ---------------------------------------------------------------------------
// Known agent process binary names → aiTool (process ancestry layer)
// ---------------------------------------------------------------------------

const AGENT_PROCESS_NAMES: ReadonlyArray<{ name: string; aiTool: string }> = [
  { name: "claude", aiTool: "claude-code" },
  { name: "aider", aiTool: "aider" },
  { name: "plandex", aiTool: "plandex" },
  { name: "codex", aiTool: "codex" },
  { name: "devin", aiTool: "devin" },
  { name: "openHands", aiTool: "openHands" },
];

// ---------------------------------------------------------------------------
// Git Co-authored-by → aiTool mapping
// ---------------------------------------------------------------------------

const GIT_COAUTHOR_MAP: ReadonlyArray<{
  pattern: RegExp;
  aiTool: string;
}> = [
  { pattern: /claude/i, aiTool: "claude-code" },
  { pattern: /copilot/i, aiTool: "copilot" },
  { pattern: /openai|codex/i, aiTool: "codex" },
  { pattern: /gemini/i, aiTool: "gemini-code-assist" },
  { pattern: /devin/i, aiTool: "devin" },
  { pattern: /codeium/i, aiTool: "codeium" },
  { pattern: /tabnine/i, aiTool: "tabnine" },
  { pattern: /amazon.?q|codewhisperer/i, aiTool: "amazon-q" },
];

// ---------------------------------------------------------------------------
// Intent filter: files/changes not worth annotating
// ---------------------------------------------------------------------------

const SKIP_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /[/\\]node_modules[/\\]/,
  /\.lock$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /poetry\.lock$/,
  /Cargo\.lock$/,
  /composer\.lock$/,
  /Gemfile\.lock$/,
  /[/\\]dist[/\\]/,
  /[/\\]build[/\\]/,
  /[/\\]coverage[/\\]/,
  /[/\\]\.next[/\\]/,
  /[/\\]\.nuxt[/\\]/,
  /\.tsbuildinfo$/,
  /\.generated\./,
  /\.pb\.go$/,
  /\.pb\.ts$/,
  /\.min\.(js|css)$/,
  /[/\\]__pycache__[/\\]/,
];

/**
 * Returns true when a file change is worth creating a ContextEntry for.
 * Filters out lock files, generated files, dist artefacts, and whitespace-only
 * changes that do not represent a real code decision.
 */
export function isMeaningfulChange(
  filePath: string,
  addedLines: number,
  removedLines: number,
  changeDensity: number,
): boolean {
  if (SKIP_PATH_PATTERNS.some((p) => p.test(filePath))) return false;
  if (addedLines === 0) return false;
  if (addedLines <= 1 && changeDensity < 0.05) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Attribution result type
// ---------------------------------------------------------------------------

export type AttributionSource =
  | "env"
  | "sidecar"
  | "known-env"
  | "git-trailer"
  | "process"
  | "heuristic"
  | "none";

export type AttributionResult = {
  aiTool: string | null;
  /** 0–1 confidence that aiTool is correct. Use ATTRIBUTION_CONFIDENCE constants. */
  attributionConfidence: number;
  /** Whether a higher-confidence source could upgrade this later. */
  canUpgradeAttribution: boolean;
  /** Session ID from the attribution source, if available. */
  sessionId?: string;
  /** Which detection layer produced this result. */
  source: AttributionSource;
  /** Tool-reported model version, if available via sidecar. */
  model?: string;
  /** Tool-reported rationale, if available via sidecar. */
  summary?: string;
  /** Tool-reported reasoning steps, if available via sidecar. */
  reasoning?: string[];
};

// ---------------------------------------------------------------------------
// Layer 1: KODELA_AGENT env var (confidence 1.0)
// ---------------------------------------------------------------------------

function detectFromKodelaAgent(): AttributionResult | null {
  const agent = safeGetEnv("KODELA_AGENT")?.trim();
  if (!agent) return null;
  return {
    aiTool: agent,
    attributionConfidence: ATTRIBUTION_CONFIDENCE.KODELA_AGENT_ENV,
    canUpgradeAttribution: false,
    source: "env",
  };
}

// ---------------------------------------------------------------------------
// Layer 2: .kodela/origin.json sidecar (confidence 0.95)
// ---------------------------------------------------------------------------

const SIDECAR_MAX_BYTES = 64 * 1024; // 64 KB hard limit

export type SidecarData = {
  aiTool?: string;
  model?: string;
  sessionId?: string;
  summary?: string;
  reasoning?: string[];
  tool?: string;
};

export async function readOriginSidecar(
  repoRoot: string,
): Promise<SidecarData | null> {
  const sidecarPath = path.join(repoRoot, ".kodela", "origin.json");
  try {
    const stat = await fs.stat(sidecarPath);
    if (stat.size > SIDECAR_MAX_BYTES) {
      process.stderr.write(
        `[kodela/attribution] Sidecar file exceeds ${SIDECAR_MAX_BYTES} bytes — ignoring.\n`,
      );
      return null;
    }
    const raw = await fs.readFile(sidecarPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const data: SidecarData = {};
    if (typeof parsed["tool"] === "string" && parsed["tool"])
      data.aiTool = parsed["tool"];
    if (typeof parsed["aiTool"] === "string" && parsed["aiTool"])
      data.aiTool = parsed["aiTool"];
    if (typeof parsed["model"] === "string" && parsed["model"])
      data.model = parsed["model"];
    if (typeof parsed["sessionId"] === "string" && parsed["sessionId"])
      data.sessionId = parsed["sessionId"];
    if (typeof parsed["summary"] === "string" && parsed["summary"])
      data.summary = parsed["summary"];
    if (
      Array.isArray(parsed["reasoning"]) &&
      (parsed["reasoning"] as unknown[]).every((r) => typeof r === "string")
    ) {
      data.reasoning = parsed["reasoning"] as string[];
    }

    await fs.unlink(sidecarPath).catch(() => {});
    return Object.keys(data).length > 0 ? data : null;
  } catch {
    return null;
  }
}

function detectFromSidecar(sidecar: SidecarData): AttributionResult | null {
  if (!sidecar.aiTool) return null;
  return {
    aiTool: sidecar.aiTool,
    attributionConfidence: ATTRIBUTION_CONFIDENCE.SIDECAR,
    canUpgradeAttribution: false,
    sessionId: sidecar.sessionId,
    model: sidecar.model,
    summary: sidecar.summary,
    reasoning: sidecar.reasoning,
    source: "sidecar",
  };
}

// ---------------------------------------------------------------------------
// Layer 3: Known agent env vars (confidence 0.85)
// ---------------------------------------------------------------------------

function detectFromKnownEnvVars(): AttributionResult | null {
  for (const { envVar, aiTool, isSessionId } of AGENT_ENV_MAP) {
    const val = safeGetEnv(envVar);
    if (val && val.trim()) {
      return {
        aiTool,
        attributionConfidence: ATTRIBUTION_CONFIDENCE.KNOWN_AGENT_ENV,
        canUpgradeAttribution: true,
        sessionId: isSessionId ? val.trim() : undefined,
        source: "known-env",
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer 4: Process ancestry — binary name only, never store args (confidence 0.7)
// ---------------------------------------------------------------------------

async function detectFromProcessAncestry(): Promise<AttributionResult | null> {
  try {
    let output: string;
    if (process.platform === "linux") {
      const ppid = process.ppid;
      const cmdlineRaw = await fs.readFile(
        `/proc/${ppid}/cmdline`,
        "utf-8",
      ).catch(() => "");
      output = cmdlineRaw.replace(/\x00/g, " ").trim();
    } else if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("ps", [
        "-o", "comm=",
        "-p", String(process.ppid),
      ]);
      output = stdout.trim();
    } else {
      return null;
    }

    const binaryName = path.basename(output.split(" ")[0] ?? "");
    for (const { name, aiTool } of AGENT_PROCESS_NAMES) {
      if (binaryName.toLowerCase().includes(name.toLowerCase())) {
        return {
          aiTool,
          attributionConfidence: ATTRIBUTION_CONFIDENCE.PROCESS_ANCESTRY,
          canUpgradeAttribution: true,
          source: "process",
        };
      }
    }
  } catch {
    // Not available on this platform — silently skip
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer 5: Git Co-authored-by trailer (confidence 0.75)
// ---------------------------------------------------------------------------

export async function detectFromGitTrailer(
  repoRoot: string,
): Promise<AttributionResult | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "-1", "--format=%B"],
      { cwd: repoRoot },
    );
    const body = stdout;

    const coauthorLines = body
      .split("\n")
      .filter((l) => /^co-authored-by:/i.test(l.trim()));

    for (const line of coauthorLines) {
      for (const { pattern, aiTool } of GIT_COAUTHOR_MAP) {
        if (pattern.test(line)) {
          return {
            aiTool,
            attributionConfidence: ATTRIBUTION_CONFIDENCE.GIT_TRAILER,
            canUpgradeAttribution: false,
            source: "git-trailer",
          };
        }
      }
    }

    const subject = body.split("\n")[0] ?? "";
    if (/^🤖|^\[ai\]|generated by/i.test(subject.trim())) {
      return {
        aiTool: null,
        attributionConfidence: ATTRIBUTION_CONFIDENCE.GIT_TRAILER,
        canUpgradeAttribution: true,
        source: "git-trailer",
      };
    }
  } catch {
    // git not available or not a git repo
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layer 6: Heuristics (confidence 0.5)
// ---------------------------------------------------------------------------

function detectFromHeuristics(
  addedLines: number,
  batchSize: number,
): AttributionResult | null {
  if (addedLines >= 50 || batchSize >= 3) {
    return {
      aiTool: null,
      attributionConfidence: ATTRIBUTION_CONFIDENCE.HEURISTIC,
      canUpgradeAttribution: true,
      source: "heuristic",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

export type AttributionPipelineOptions = {
  repoRoot: string;
  /** Pre-loaded sidecar data (avoids double-read when caller already read it). */
  sidecar?: SidecarData | null;
  /** Total lines added across the batch (for heuristic layer). */
  totalAddedLines?: number;
  /** Number of files in the batch (for heuristic layer). */
  batchSize?: number;
  /** Skip the git trailer layer (e.g. when no commit has been made yet). */
  skipGitTrailer?: boolean;
};

/**
 * Run the full attribution pipeline in layer priority order.
 * Never throws — returns `{ aiTool: null, confidence: 0, source: "none" }` on
 * any failure. Does not make network calls.
 */
export async function runAttributionPipeline(
  opts: AttributionPipelineOptions,
): Promise<AttributionResult> {
  const {
    repoRoot,
    sidecar,
    totalAddedLines = 0,
    batchSize = 1,
    skipGitTrailer = false,
  } = opts;

  // Layer 1: KODELA_AGENT env var
  const l1 = detectFromKodelaAgent();
  if (l1) return l1;

  // Layer 2: .kodela/origin.json sidecar
  const sidecarData = sidecar !== undefined ? sidecar : await readOriginSidecar(repoRoot);
  if (sidecarData) {
    const l2 = detectFromSidecar(sidecarData);
    if (l2) return l2;
  }

  // Layer 3: Known agent env vars
  const l3 = detectFromKnownEnvVars();
  if (l3) return l3;

  // Layer 4: Process ancestry
  const l4 = await detectFromProcessAncestry();
  if (l4) return l4;

  // Layer 5: Git commit Co-authored-by trailers
  if (!skipGitTrailer) {
    const l5 = await detectFromGitTrailer(repoRoot);
    if (l5) return l5;
  }

  // Layer 6: Heuristics
  const l6 = detectFromHeuristics(totalAddedLines, batchSize);
  if (l6) return l6;

  // Layer 7: No attribution — stub
  return {
    aiTool: null,
    attributionConfidence: ATTRIBUTION_CONFIDENCE.NONE,
    canUpgradeAttribution: true,
    source: "none",
  };
}

// ---------------------------------------------------------------------------
// Session model
// ---------------------------------------------------------------------------

export type AgentSession = {
  /** UUID for this session. */
  id: string;
  /** Attributed AI tool for this session, if known. */
  aiTool: string | undefined;
  /** When the session opened (Unix ms). */
  startedAt: number;
  /** When the last file change was recorded in this session (Unix ms). */
  lastActivityAt: number;
  /** Relative file paths touched in this session. */
  files: string[];
};

/**
 * Tracks agent sessions based on inactivity thresholds and agent changes.
 * A new session opens when:
 *  - No activity for `inactivityMs` (default 60 000 ms)
 *  - A different aiTool is detected for the incoming batch
 */
export class SessionTracker {
  private current: AgentSession | null = null;
  private readonly inactivityMs: number;

  constructor(inactivityMs: number = 60_000) {
    this.inactivityMs = inactivityMs;
  }

  /**
   * Record a batch of file changes attributed to `aiTool`.
   * Returns the session ID to embed in `origin.sessionId`.
   */
  record(
    files: string[],
    aiTool: string | undefined,
    now: number = Date.now(),
  ): string {
    const inactive =
      this.current !== null &&
      now - this.current.lastActivityAt > this.inactivityMs;

    const toolChanged =
      this.current !== null &&
      aiTool !== undefined &&
      this.current.aiTool !== undefined &&
      aiTool !== this.current.aiTool;

    if (this.current === null || inactive || toolChanged) {
      this.current = {
        id: crypto.randomUUID(),
        aiTool,
        startedAt: now,
        lastActivityAt: now,
        files: [...files],
      };
    } else {
      this.current.lastActivityAt = now;
      this.current.aiTool = this.current.aiTool ?? aiTool;
      for (const f of files) {
        if (!this.current.files.includes(f)) {
          this.current.files.push(f);
        }
      }
    }

    return this.current.id;
  }

  get(): AgentSession | null {
    return this.current;
  }
}

// ---------------------------------------------------------------------------
// Deduplication: time-window + contentHash
// ---------------------------------------------------------------------------

type DedupKey = string; // `${filePath}::${contentHash}`
type DedupEntry = { annotatedAt: number };

/**
 * Tracks recently annotated file+content combinations to prevent double-
 * creation when multiple triggers fire for the same logical change.
 */
export class AnnotationDeduplicator {
  private readonly cache = new Map<DedupKey, DedupEntry>();
  private readonly windowMs: number;

  constructor(windowMs: number = 30_000) {
    this.windowMs = windowMs;
  }

  isDuplicate(filePath: string, contentHash: string, now: number = Date.now()): boolean {
    const key: DedupKey = `${filePath}::${contentHash}`;
    const entry = this.cache.get(key);
    if (!entry) return false;
    return now - entry.annotatedAt < this.windowMs;
  }

  record(filePath: string, contentHash: string, now: number = Date.now()): void {
    const key: DedupKey = `${filePath}::${contentHash}`;
    this.cache.set(key, { annotatedAt: now });

    // Prune expired entries to avoid unbounded growth
    if (this.cache.size > 1000) {
      for (const [k, v] of this.cache) {
        if (now - v.annotatedAt >= this.windowMs) {
          this.cache.delete(k);
        }
      }
    }
  }
}
