// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * MCP Context Layer — MCPContextEnvelope builder.
 *
 * `buildMCPEnvelope` assembles the full MCPContextEnvelope from a closed
 * KodelaSession and its linked ContextEntries, resolving the intent from the
 * highest available tier (T1 → T2 → T3 → T4 → T5).
 *
 * Output is written to `.kodela/sessions/<sessionId>.mcp.json`.
 */

import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { KodelaSession, ContextEntry } from "../schema/index.js";
import type { FileChangeContext, ActorBreakdown } from "../schema/session.schema.js";
import { readAssistantTurns } from "../sessions/manager.js";

const execFileAsync = promisify(execFile);

const SESSIONS_DIR = ".kodela/sessions";
const TICKET_RE = /\b([A-Z][A-Z0-9]+-[0-9]+)\b/;

// ── Schema definitions ────────────────────────────────────────────────────────

export const MCPActorSchema = z.object({
  tool: z.string(),
  model: z.string().optional(),
  author: z.string().optional(),
});

export const MCPIntentBlockSchema = z.object({
  userPrompt: z.string().optional(),
  aiReasoning: z.string().optional(),
  commitMessage: z.string().optional(),
  branchContext: z.string().optional(),
  linkedTicket: z.string().optional(),
  source: z.enum([
    "hook",
    "assistant-response",
    "commit-message",
    "reasoning-aggregate",
    "summary-aggregate",
    "structural-fallback",
  ]),
  confidence: z.number().min(0).max(1),
});

export const MCPFileChangeSchema = z.object({
  path: z.string(),
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
  intent: z.string(),
  risk: z.enum(["low", "medium", "high", "critical"]),
  // Per-file context fields (populated when kodela_annotate_file was called)
  whyChanged: z.string().optional(),
  problemSolved: z.string().optional(),
  aiReasoning: z.string().optional(),
  modifiedBy: z
    .object({
      source: z.enum(["ai", "human", "mixed"]),
      tool: z.string().nullable(),
      model: z.string().nullable(),
      author: z.string(),
    })
    .optional(),
  relatedFiles: z.array(z.string()).optional(),
  reviewRequired: z.boolean().optional(),
});

export const MCPContextEnvelopeSchema = z.object({
  schemaVersion: z.literal("1.0"),
  captureMethod: z.enum(["mcp", "watcher", "hybrid", "git"]),
  exportedAt: z.string().datetime(),

  actor: MCPActorSchema,
  intent: MCPIntentBlockSchema,

  changes: z.object({
    filesChanged: z.number().int().nonnegative(),
    linesAdded: z.number().int().nonnegative(),
    linesRemoved: z.number().int().nonnegative(),
    files: z.array(MCPFileChangeSchema),
    // Actor breakdown — populated when per-file context is complete
    actorBreakdown: z
      .object({
        ai: z.number().int().nonnegative(),
        human: z.number().int().nonnegative(),
        mixed: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  duration: z.number().nonnegative(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),

  risk: z.enum(["low", "medium", "high", "critical"]),
  reviewRequired: z.boolean(),
  humanVerified: z.boolean(),
  totalAnnotations: z.number().int().nonnegative(),
  avgConfidence: z.number().min(0).max(1),

  clusters: z.array(z.string()),
  sessionId: z.string(),
  handoffSummary: z.string(),

  /** True when every file in the session has per-file context via kodela_annotate_file. */
  perFileContextComplete: z.boolean().optional(),

  // ── Git-diff enforcement fields ─────────────────────────────────────────────
  /** Files detected as changed by git diff against the session baseline. */
  filesDetectedByGit: z.array(z.string()).optional(),
  /** Files excluded from enforcement by auto-exclude rules or .kodelaignore. */
  autoExcludedFiles: z.array(z.string()).optional(),
  /** True if session was force-closed despite missing annotations. */
  forceOverride: z.boolean().optional(),
  /** Reason provided when force-closing. */
  forceOverrideReason: z.string().optional(),
});

export type MCPContextEnvelope = z.infer<typeof MCPContextEnvelopeSchema>;
export type MCPFileChange = z.infer<typeof MCPFileChangeSchema>;
export type MCPIntentBlock = z.infer<typeof MCPIntentBlockSchema>;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function detectBranch(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C", repoRoot,
      "rev-parse", "--abbrev-ref", "HEAD",
    ]);
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

async function detectLatestCommitMessage(
  repoRoot: string,
  since: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C", repoRoot,
      "log",
      "--oneline",
      "--since",
      since,
      "--format=%s",
      "-5",
    ]);
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const meaningful = lines.find(
      (l) => l.length > 10 && !l.toLowerCase().startsWith("merge"),
    );
    return meaningful;
  } catch {
    return undefined;
  }
}

function extractTicket(text: string): string | undefined {
  const m = text.match(TICKET_RE);
  return m?.[1];
}

function riskLabel(risk: string): string {
  if (risk === "critical" || risk === "high") return "high";
  if (risk === "medium") return "medium";
  return "low";
}

function riskReason(files: string[]): string {
  const paths = files.join(" ").toLowerCase();
  if (/auth|oauth|jwt|session|password|token/.test(paths)) return "changes auth flow";
  if (/payment|billing|stripe|invoice/.test(paths)) return "modifies payment logic";
  if (/migration|schema|\.sql|drizzle/.test(paths)) return "database schema change";
  if (/api\/|routes\/|controller/.test(paths)) return "modifies API surface";
  return "low impact";
}

function buildHandoffSummary(
  primaryIntent: string,
  dominantChangeType: string,
  keyFiles: string[],
  risk: string,
  reviewRequired: boolean,
): string {
  const fileList = keyFiles.slice(0, 3).join(", ");
  const verb =
    dominantChangeType === "addition" ? "Added"
    : dominantChangeType === "refactor" ? "Refactored"
    : dominantChangeType === "fix" ? "Fixed"
    : dominantChangeType === "docs" ? "Documented"
    : "Modified";

  const rr = riskReason(keyFiles);
  let summary = `${primaryIntent}. ${verb} in ${fileList || "repository files"}.`;
  summary += ` Risk: ${risk} — ${rr}.`;
  if (reviewRequired) summary += " Review required before merge.";
  return summary;
}

function captureMethodFromEntries(entries: ContextEntry[]): "mcp" | "watcher" | "hybrid" {
  if (entries.length === 0) return "watcher";
  const mcpCount = entries.filter(
    (e) => (e.reasoning as { extractionMethod?: string } | undefined)?.extractionMethod === "mcp",
  ).length;
  if (mcpCount === entries.length) return "mcp";
  if (mcpCount > 0) return "hybrid";
  return "watcher";
}

// ── Main builder ──────────────────────────────────────────────────────────────

export type BuildMCPEnvelopeOptions = {
  /** Explicit commit message (supplied by kodela_session_end). */
  commitMessage?: string;
  /** Explicit outcome — persisted for audit but not in schema. */
  outcome?: "success" | "partial" | "abandoned";
  /** Pre-computed actor breakdown (from session close validation). */
  actorBreakdown?: ActorBreakdown;
  /** Whether every file in the session has per-file context. */
  perFileContextComplete?: boolean;
};

/**
 * Assemble an MCPContextEnvelope from a closed session and its entries.
 * Writes `.kodela/sessions/<sessionId>.mcp.json` and returns the envelope.
 */
export async function buildMCPEnvelope(
  repoRoot: string,
  session: KodelaSession,
  entries: ContextEntry[],
  opts: BuildMCPEnvelopeOptions = {},
): Promise<MCPContextEnvelope> {
  const now = new Date().toISOString();

  // ── T2: assistant turns ───────────────────────────────────────────────────
  const turns = await readAssistantTurns(repoRoot, session.id);
  const turnTexts = turns.map((t) => t.text);
  const bestTurn = turnTexts.find((t) => t.length > 40);

  // ── T3: commit message ────────────────────────────────────────────────────
  const commitMsg =
    opts.commitMessage ??
    (await detectLatestCommitMessage(repoRoot, session.startedAt));

  // ── Branch + ticket ───────────────────────────────────────────────────────
  const branch =
    session.branchContext ?? (await detectBranch(repoRoot));
  const ticket =
    session.linkedTicket ??
    (branch ? extractTicket(branch) : undefined) ??
    (commitMsg ? extractTicket(commitMsg) : undefined);

  // ── Intent tier resolution ────────────────────────────────────────────────
  let intentSource: MCPIntentBlock["source"];
  let confidence: number;
  let userPrompt: string | undefined;
  let aiReasoning: string | undefined;

  if (session.goal && session.goal.trim().length > 10) {
    // T1 — explicit user prompt from kodela_session_start or KODELA_GOAL
    intentSource = "hook";
    confidence = 0.93;
    userPrompt = session.goal;
    aiReasoning = bestTurn;
  } else if (bestTurn) {
    // T2 — assistant response turns
    intentSource = "assistant-response";
    confidence = 0.82;
    aiReasoning = bestTurn;
  } else if (commitMsg && commitMsg.length > 10) {
    // T3 — commit message
    intentSource = "commit-message";
    confidence = 0.72;
  } else if (entries.some((e) => e.summary?.intent && e.summary.intent.length > 20)) {
    // T4 — reasoning aggregate from entries
    intentSource = "reasoning-aggregate";
    confidence = 0.55;
  } else {
    // T5 — structural fallback
    intentSource = "structural-fallback";
    confidence = 0.30;
  }

  const intentBlock: MCPIntentBlock = {
    userPrompt,
    aiReasoning,
    commitMessage: commitMsg,
    branchContext: branch,
    linkedTicket: ticket,
    source: intentSource,
    confidence,
  };

  // ── Changes block ─────────────────────────────────────────────────────────
  const fileMap = new Map<
    string,
    { added: number; removed: number; intent: string; risk: string }
  >();

  for (const entry of entries) {
    const fp = entry.filePath;
    const cur = fileMap.get(fp) ?? { added: 0, removed: 0, intent: "", risk: "low" };
    cur.added += entry.rawContext?.linesAdded ?? 0;
    cur.removed += entry.rawContext?.linesRemoved ?? 0;
    if (!cur.intent && entry.summary?.intent) cur.intent = entry.summary.intent;
    if (entry.severity === "critical" || entry.severity === "high") cur.risk = entry.severity;
    else if (cur.risk !== "critical" && cur.risk !== "high" && entry.severity === "medium")
      cur.risk = "medium";
    fileMap.set(fp, cur);
  }

  // Build a lookup of per-file context from filesChangedDetail
  const perFileDetail = new Map<string, FileChangeContext>();
  for (const fc of session.filesChangedDetail ?? []) {
    perFileDetail.set(fc.path, fc);
  }

  const files: MCPFileChange[] = [...fileMap.entries()].map(([fp, d]) => {
    const detail = perFileDetail.get(fp);
    const base: MCPFileChange = {
      path: fp,
      linesAdded: d.added,
      linesRemoved: d.removed,
      intent: detail?.whyChanged ?? (d.intent || "Modified"),
      risk: (d.risk as MCPFileChange["risk"]) ?? "low",
    };
    if (detail) {
      base.whyChanged = detail.whyChanged;
      base.problemSolved = detail.problemSolved;
      if (detail.aiReasoning) base.aiReasoning = detail.aiReasoning;
      base.modifiedBy = {
        source: detail.modifiedBy.source,
        tool: detail.modifiedBy.tool,
        model: detail.modifiedBy.model,
        author: detail.modifiedBy.author,
      };
      if (detail.relatedFiles.length > 0) base.relatedFiles = detail.relatedFiles;
      base.reviewRequired = detail.reviewRequired;
    }
    return base;
  });

  // Also include files that have per-file detail but no entries yet
  for (const [fp, detail] of perFileDetail) {
    if (!fileMap.has(fp)) {
      files.push({
        path: fp,
        linesAdded: detail.linesAdded,
        linesRemoved: detail.linesRemoved,
        intent: detail.whyChanged,
        risk: detail.risk,
        whyChanged: detail.whyChanged,
        problemSolved: detail.problemSolved,
        aiReasoning: detail.aiReasoning,
        modifiedBy: {
          source: detail.modifiedBy.source,
          tool: detail.modifiedBy.tool,
          model: detail.modifiedBy.model,
          author: detail.modifiedBy.author,
        },
        relatedFiles: detail.relatedFiles.length > 0 ? detail.relatedFiles : undefined,
        reviewRequired: detail.reviewRequired,
      });
    }
  }

  const totalAdded = files.reduce((s, f) => s + f.linesAdded, 0);
  const totalRemoved = files.reduce((s, f) => s + f.linesRemoved, 0);

  // ── Dominant change type ──────────────────────────────────────────────────
  const changeTypeCounts = new Map<string, number>();
  for (const e of entries) {
    const ct = e.summary?.changeType ?? "modification";
    changeTypeCounts.set(ct, (changeTypeCounts.get(ct) ?? 0) + 1);
  }
  const dominantType =
    [...changeTypeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "modification";

  // ── Risk + review ─────────────────────────────────────────────────────────
  const risk = (session.aggregatedRisk ?? "low") as MCPContextEnvelope["risk"];
  const reviewRequired = risk === "high" || risk === "critical";

  // ── Average confidence ────────────────────────────────────────────────────
  const avgConfidence =
    entries.length > 0
      ? entries.reduce((s, e) => s + (e.confidence ?? 0), 0) / entries.length
      : 0;

  // ── Duration ─────────────────────────────────────────────────────────────
  const startMs = new Date(session.startedAt).getTime();
  const endMs = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
  const duration = Math.round((endMs - startMs) / 1000);

  // ── Primary intent text for handoff ──────────────────────────────────────
  const primaryIntent =
    userPrompt ??
    aiReasoning?.slice(0, 120) ??
    commitMsg ??
    entries.find((e) => e.summary?.intent)?.summary?.intent ??
    `Modified ${files.length} file${files.length !== 1 ? "s" : ""}`;

  // ── Key files (by lines changed) ──────────────────────────────────────────
  const keyFiles = [...files]
    .sort((a, b) => b.linesAdded + b.linesRemoved - (a.linesAdded + a.linesRemoved))
    .map((f) => f.path);

  // ── Actor ─────────────────────────────────────────────────────────────────
  const actor = {
    tool: session.actor?.tool ?? "unknown",
    model: session.actor?.model ?? session.model,
    author: session.actor?.author,
  };

  // ── Clusters ─────────────────────────────────────────────────────────────
  const clusters = [
    ...new Set(
      entries
        .map((e) => e.clusterId)
        .filter((c): c is string => typeof c === "string"),
    ),
  ];

  // ── Capture method ────────────────────────────────────────────────────────
  const captureMethod = captureMethodFromEntries(entries);

  const handoffSummary = buildHandoffSummary(
    primaryIntent,
    dominantType,
    keyFiles,
    riskLabel(risk),
    reviewRequired,
  );

  // ── Actor breakdown ───────────────────────────────────────────────────────
  const actorBreakdown = opts.actorBreakdown ?? (() => {
    const bd = { ai: 0, human: 0, mixed: 0 };
    for (const fc of session.filesChangedDetail ?? []) {
      bd[fc.modifiedBy.source] += 1;
    }
    return bd;
  })();

  const perFileContextComplete =
    opts.perFileContextComplete ??
    (session.filesChangedDetail !== undefined &&
      session.filesChangedDetail.length > 0 &&
      files.every((f) => f.whyChanged !== undefined));

  const envelope: MCPContextEnvelope = {
    schemaVersion: "1.0",
    captureMethod,
    exportedAt: now,
    actor,
    intent: intentBlock,
    changes: {
      filesChanged: files.length,
      linesAdded: totalAdded,
      linesRemoved: totalRemoved,
      files,
      actorBreakdown,
    },
    duration,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    risk,
    reviewRequired,
    humanVerified: false,
    totalAnnotations: entries.length,
    avgConfidence: Math.round(avgConfidence * 100) / 100,
    clusters,
    sessionId: session.id,
    handoffSummary,
    perFileContextComplete,
  };

  // ── Write to disk ─────────────────────────────────────────────────────────
  const safeId = session.id.replace(/[^a-zA-Z0-9-_]/g, "");
  const outPath = path.join(
    repoRoot,
    SESSIONS_DIR,
    `${safeId}.mcp.json`,
  );
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(envelope, null, 2), "utf-8");

  return envelope;
}

/**
 * Read an existing MCPContextEnvelope from disk.
 * Returns null when the file does not exist.
 */
export async function readMCPEnvelope(
  repoRoot: string,
  sessionId: string,
): Promise<MCPContextEnvelope | null> {
  const safeId = sessionId.replace(/[^a-zA-Z0-9-_]/g, "");
  const filePath = path.join(repoRoot, SESSIONS_DIR, `${safeId}.mcp.json`);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return MCPContextEnvelopeSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
