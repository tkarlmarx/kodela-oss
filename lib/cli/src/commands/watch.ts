// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startWatcher } from "@kodela/watcher";
import type { Watcher, BatchedEvent, WatcherOptions, ChangeEvent } from "@kodela/watcher";
import { heal } from "./heal-engine.js";
import type { HealEngineOptions, HealResult } from "./heal-engine.js";
import { runMemoryBank } from "./memory-bank.js";

// Auto-refresh the agent Memory Bank from the watch loop, throttled so a busy
// editor doesn't thrash the files. Module-level: the watcher is one process.
const MEMORY_BANK_THROTTLE_MS = 20_000;
let lastMemoryBankRefreshMs = 0;
import {
  formatEngineWatchBatchResult,
  formatWatchBatchResult,
} from "../output/formatters.js";
import type { WatchBatchResult, EngineWatchBatchResult } from "../output/formatters.js";
import type { KodelaConfig } from "../config/schema.js";
import {
  writeContextEntry,
  hashTokenStream,
  SCHEMA_VERSION,
  readOriginSidecar,
  runAttributionPipeline,
  isMeaningfulChange,
  SessionTracker,
  AnnotationDeduplicator,
  ubaScore,
  enrichEntry,
  describeChange,
  extractSymbols,
} from "@kodela/core";
import type { ContextEntry, UbaSignals } from "@kodela/core";
import { computeDiff } from "@kodela/diff";
import { isSensitivePath } from "../security/sensitive-paths.js";
import { patternToMatcher } from "../utils/pattern-matcher.js";
import { processDriftNotifications } from "./notify.js";
import { createDetectionEntry, appendDetectionLog } from "./detect-ai-change.js";
import {
  HEARTBEAT_INTERVAL_MS,
  cleanWatcherState,
  refreshWatcherHeartbeat,
  registerSupervisedWatcher,
} from "./watch-daemon.js";
import { CLI_VERSION } from "../config/loader.js";
import { scheduleExtraction, drainExtractionQueue } from "../hooks/queue.js";
import {
  appendAssistantTurn,
  appendUserTurn,
  startSession,
  linkEntryToSession,
  closeSession,
  synthesiseAndWriteSessionSummary,
  updateSessionActor,
  updateSessionIntent,
  updateSessionGitSnapshot,
} from "@kodela/core/sessions";
import type { AiLayerConfig } from "./ai-layer.js";
import { callForProposal } from "./ai-layer.js";
import { normalizeContext } from "@kodela/core";

export type { WatchBatchResult, EngineWatchBatchResult };
export type WatcherFactory = (opts: WatcherOptions) => Watcher;

const execFileAsync = promisify(execFile);

function normalizedAuthor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function readGitAuthor(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "user.name"], {
      cwd: repoRoot,
    });
    return normalizedAuthor(stdout);
  } catch {
    return undefined;
  }
}

async function resolveWatchAuthor(repoRoot: string): Promise<string> {
  const explicit =
    normalizedAuthor(process.env["KODELA_AUTHOR"])
    ?? normalizedAuthor(process.env["GIT_AUTHOR_NAME"])
    ?? normalizedAuthor(process.env["GIT_COMMITTER_NAME"]);
  if (explicit) return explicit;

  const gitAuthor = await readGitAuthor(repoRoot);
  return gitAuthor ?? "unknown";
}

async function readGitBranch(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
    });
    return normalizedAuthor(stdout);
  } catch {
    return undefined;
  }
}

async function readGitHeadCommit(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
    });
    return normalizedAuthor(stdout);
  } catch {
    return undefined;
  }
}

async function readGitHeadMessage(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["log", "-1", "--pretty=%s"], {
      cwd: repoRoot,
    });
    return normalizedAuthor(stdout);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Ignore-pattern helpers
// ---------------------------------------------------------------------------

/**
 * Parse a `.gitignore`-style file into an array of non-empty, non-comment
 * patterns.  Negation lines (`!`) are discarded — we never un-ignore things
 * that the outer IGNORED_DIRS list already blocks.
 */
async function parseIgnoreFile(filePath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("!"));
  } catch {
    return [];
  }
}

/**
 * Directories that are always skipped when walking the repo tree to
 * pre-populate prevContentMap.  These mirror the IGNORED_DIRS constant
 * in @kodela/watcher so the set of pre-populated files matches the set
 * the watcher actually monitors.
 */
const PREWALK_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".kodela",
  ".local",
  "dist",
  "build",
  ".pnpm-store",
  ".cache",
  "coverage",
  "__pycache__",
]);

/**
 * Build the full list of ignore functions to pass to the watcher, sourced from:
 *  1. `.gitignore` at repo root
 *  2. `.kodelaignore` at repo root (optional custom ignore file)
 *  3. `config.baseline.ignore_patterns` from `kodela.config.json`
 *
 * Results are de-duplicated and converted to matcher functions so chokidar
 * can apply them at directory-traversal time (prevents ENOSPC on large repos).
 */
async function buildWatchIgnored(
  repoRoot: string,
  config: KodelaConfig | undefined,
): Promise<Array<(p: string) => boolean>> {
  const [gitignorePatterns, kodelaignorePatterns] = await Promise.all([
    parseIgnoreFile(path.join(repoRoot, ".gitignore")),
    parseIgnoreFile(path.join(repoRoot, ".kodelaignore")),
  ]);

  const configPatterns: string[] = config?.baseline?.ignore_patterns ?? [];

  const allPatterns = [
    ...new Set([...gitignorePatterns, ...kodelaignorePatterns, ...configPatterns]),
  ];

  return allPatterns.map((p) => patternToMatcher(repoRoot, p));
}

/**
 * Injectable heal function — receives the raw watcher change events and engine
 * options, returns `{ updated, orphaned, uncertain }`.  Defaults to the
 * `heal()` export from `heal-engine.ts`.
 */
export type HealFn = (
  changes: ChangeEvent[],
  opts: HealEngineOptions,
) => Promise<HealResult>;

export { formatWatchBatchResult, formatEngineWatchBatchResult };

export type WatchOptions = {
  repoRoot: string;
  debounceMs?: number;
  dryRun?: boolean;
  debug?: boolean;
  /**
   * Loaded Kodela config.  When provided, `heal.ai_confidence_cap` and
   * `heal.rewrite_confidence_factor` override built-in defaults (0.6 / 0.85).
   * Falls back to the engine's built-in defaults when omitted.
   */
  config?: KodelaConfig;
  /**
   * Absolute path to the config file that was loaded, or `null` when no config
   * file was found.  When provided, `runWatch` logs a startup line so the user
   * can confirm which thresholds are active.
   */
  configPath?: string | null;
  /** Injectable watcher factory — defaults to `startWatcher`. Used in tests. */
  watcherFactory?: WatcherFactory;
  /** Injectable heal function — defaults to `heal` from heal-engine. Used in tests. */
  healFn?: HealFn;

  /**
   * Gap 15b — Zero-touch universal context capture.
   *
   * When true, the watcher not only heals existing entries but also
   * automatically creates new ContextEntry stubs for every meaningful
   * AI-written change detected, using the full 6-layer attribution pipeline.
   *
   * No user interaction required — works with any AI tool or agent.
   */
  autoAnnotate?: boolean;

  /**
   * Milliseconds to wait for a file's size to stop changing before reading
   * it for annotation.  Prevents reading partial writes from agents that
   * stream content to disk.  Default: 200 ms.
   */
  stabilizationMs?: number;

  /**
   * Session inactivity threshold in milliseconds.  If no files change for
   * longer than this, a new agent session is opened.  Default: 60 000 ms.
   */
  sessionInactivityMs?: number;

  /**
   * Gap 66 — when true, the watcher prints a one-line diagnostic for every
   * file it evaluates in auto-annotate mode, including skip reasons (UBA score,
   * deduplication, meaningful-change filter) and annotation confirmations.
   * Non-verbose mode (default) only emits a per-batch summary line.
   */
  verbose?: boolean;
};

type ActiveSessionRef = {
  id?: string;
};

export async function runWatch(
  opts: WatchOptions,
  stdout: NodeJS.WriteStream = process.stdout,
): Promise<Watcher> {
  const {
    repoRoot,
    debounceMs = 500,
    dryRun = false,
    debug = false,
    config,
    configPath,
    watcherFactory = startWatcher,
    healFn = heal,
    autoAnnotate = false,
    stabilizationMs = 200,
    sessionInactivityMs = 60_000,
    verbose = false,
  } = opts;

  const watchAuthor = await resolveWatchAuthor(repoRoot);

  stdout.write(`[watch] Starting\u2026 watching ${repoRoot}\n`);

  if (configPath != null) {
    stdout.write(`[watch] Loaded config from ${configPath}\n`);
  } else if (configPath === null) {
    stdout.write("[watch] No config file found \u2014 using defaults\n");
  }

  if (autoAnnotate) {
    stdout.write("[watch] Auto-annotate enabled \u2014 new entries will be created for AI changes\n");
  }

  // Build the ignore list from .gitignore, .kodelaignore and config patterns.
  const extraIgnored = await buildWatchIgnored(repoRoot, config);
  if (extraIgnored.length > 0) {
    stdout.write(`[watch] Loaded ${extraIgnored.length} ignore pattern(s) from .gitignore / .kodelaignore / config\n`);
  }

  const watcher = watcherFactory({ rootDir: repoRoot, debounceMs, ignored: extraIgnored });

  // ── [E.2] Sprint 1.2 — synthesis-worker sidecar ─────────────────────────
  // The MCP `kodela_session_end` tool enqueues synthesis events to
  // .kodela/synthesis-queue/pending/ on every session close, but pre-E.2 the
  // queue had no consumer in any production run path — events accumulated
  // and the IS-2 risk (default-on encryption depends on synthesis being
  // routine) couldn't close.  Solution: the watcher is already the
  // always-on daemon per repo, so spawn the synthesis loop alongside it.
  //
  // Run in-process (NOT a subprocess) because:
  //   - The watcher process is already long-lived + supervised
  //   - runWorker has its own try/catch loop, so a synthesis error doesn't
  //     kill the watcher
  //   - Avoids the cross-process IPC + pidfile complexity for a feature
  //     that's logically part of "the watcher daemon"
  // Escape hatch: `KODELA_DISABLE_SYNTHESIS_WORKER=1` skips the sidecar for
  // operators who want to run synthesis externally (e.g. cluster-wide pool).
  const synthesisEnabled =
    process.env["KODELA_DISABLE_SYNTHESIS_WORKER"] !== "1" &&
    Boolean(process.env["ANTHROPIC_API_KEY"] || process.env["OPENAI_API_KEY"]);
  if (synthesisEnabled) {
    const pollMs = Number(process.env["KODELA_SYNTHESIS_POLL_MS"]) || 5_000;
    stdout.write(
      `[watch] Synthesis sidecar enabled — polling every ${pollMs}ms (set KODELA_DISABLE_SYNTHESIS_WORKER=1 to disable)\n`,
    );
    // Fire-and-forget — runWorker is its own infinite loop with internal
    // error handling; if it throws the watcher logs + continues (worst case
    // synthesis is paused until the next watcher restart).
    void (async () => {
      try {
        // @workspace/synthesis-worker is an enterprise-only package, absent in
        // the Community Edition build. Keep the specifier opaque to tsc and the
        // bundler (typed `string`, not a literal) so CE compiles and bundles;
        // the env gate above and this try/catch handle it being missing at
        // runtime (CE logs "Synthesis sidecar failed" and the watcher continues).
        const synthesisWorkerPkg: string = "@workspace/synthesis-worker";
        const { runWorker } = (await import(synthesisWorkerPkg)) as {
          runWorker: (root: string, opts: { pollIntervalMs: number }) => Promise<void>;
        };
        await runWorker(repoRoot, { pollIntervalMs: pollMs });
      } catch (err) {
        stdout.write(
          `[watch] Synthesis sidecar failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    })();
  } else if (process.env["KODELA_DISABLE_SYNTHESIS_WORKER"] === "1") {
    stdout.write("[watch] Synthesis sidecar disabled by KODELA_DISABLE_SYNTHESIS_WORKER=1\n");
  } else {
    stdout.write(
      "[watch] Synthesis sidecar skipped — set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable LLM synthesis\n",
    );
  }

  // When started under a supervisor (launchd / systemd / schtasks) the env var
  // KODELA_WATCHER_SUPERVISED=1 is set in the unit file.  Self-register so
  // `kodela watch status` reports the supervised process the same way it
  // reports a `--detach` daemon, and so `kodela watch stop` can find the PID.
  if (process.env["KODELA_WATCHER_SUPERVISED"] === "1") {
    try {
      await registerSupervisedWatcher(repoRoot, CLI_VERSION);
      stdout.write("[watch] Supervised mode \u2014 registered watcher.pid + watcher.meta\n");
      const cleanup = (): void => {
        // Best-effort: remove the PID/meta files when the supervisor stops us.
        // The supervisor itself owns restart, so leaving stale files would
        // confuse `kodela watch status` for a heartbeat staleness window.
        void cleanWatcherState(repoRoot);
      };
      process.once("SIGTERM", cleanup);
      process.once("SIGINT", cleanup);
    } catch (err) {
      stdout.write(
        `[watch] Failed to register supervised metadata: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  /**
   * Shared content cache — allocated once per watcher lifetime.
   * Cleared at the start of every batch so stale on-disk content is
   * never used across debounce windows.
   */
  const contentCache = new Map<string, string>();

  /**
   * Auto-annotate state — persists across batches.
   * prevContentMap: last-known content of each file (keyed by absolute path).
   * sessionTracker: tracks agent session boundaries.
   * deduplicator: prevents double-annotation of the same content.
   */
  const prevContentMap = new Map<string, string>();
  const sessionTracker = new SessionTracker(sessionInactivityMs);
  const deduplicator = new AnnotationDeduplicator(30_000);
  /**
   * Gap 124 — Track which session IDs have been flushed to disk so
   * `startSession()` is called exactly once per session boundary.
   * Lives alongside sessionTracker across the full watcher lifetime.
   */
  const startedSessionIds = new Set<string>();
  const activeSessionRef: ActiveSessionRef = {};

  /**
   * Gap 58 — Spike detection state.
   * Separate from prevContentMap so the detection pass and the autoAnnotate
   * pass are fully independent (each maintains its own "last seen" snapshot).
   */
  const spikePrevContentMap = new Map<string, string>();
  /**
   * Gap 24 Phase D — Temporal signal tracking.
   * Tracks the timestamp of the last auto-annotate batch so we can compute
   * inter-batch gap (Signal B) for the UBA scoring engine.
   * value === 0 means no batch has run yet (first batch).
   */
  const lastBatchTimestampRef = { value: 0 };

  watcher.on("ready", () => {
    stdout.write("[watch] Ready \u2014 watching for changes\n");

    // Pre-populate prevContentMap so the first real change to any file
    // diffs against actual content rather than an empty string.  Without
    // this, autoAnnotate would treat every first-change as a giant
    // insertion and create spurious stubs on startup.
    void (async () => {
      let count = 0;
      async function walkAndPopulate(dir: string): Promise<void> {
        let entries: import("fs").Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        await Promise.all(
          entries.map(async (entry) => {
            const absPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (PREWALK_SKIP_DIRS.has(entry.name)) return;
              if (extraIgnored.some((fn) => fn(absPath))) return;
              await walkAndPopulate(absPath);
            } else if (entry.isFile()) {
              if (extraIgnored.some((fn) => fn(absPath))) return;
              try {
                const content = await fs.readFile(absPath, "utf-8");
                prevContentMap.set(absPath, content);
                spikePrevContentMap.set(absPath, content);
                count++;
              } catch {
                // Binary file or permission error — skip
              }
            }
          }),
        );
      }
      await walkAndPopulate(repoRoot);
      stdout.write(`[watch] Pre-populated prevContentMap for ${count} file(s)\n`);
    })();

    if (autoAnnotate) {
      // Gap 127 — log active reasoning mode at startup.
      const ambientKey =
        process.env["KODELA_AI_API_KEY"] ??
        process.env["OPENAI_API_KEY"] ??
        process.env["ANTHROPIC_API_KEY"];
      const configKey = config?.ai_provider?.api_key;
      const activeKey = configKey ?? ambientKey;
      const captureReasoningStartup =
        config?.origin?.capture_reasoning ?? Boolean(activeKey);

      if (captureReasoningStartup && activeKey) {
        const keySource = configKey
          ? "config"
          : process.env["KODELA_AI_API_KEY"]
            ? "KODELA_AI_API_KEY"
            : process.env["OPENAI_API_KEY"]
              ? "OPENAI_API_KEY"
              : "ANTHROPIC_API_KEY";
        const provider = config?.ai_provider?.provider ?? (
          process.env["ANTHROPIC_API_KEY"] && !process.env["OPENAI_API_KEY"]
            ? "anthropic"
            : "openai"
        );
        stdout.write(
          `[watch] Reasoning mode: AI (${provider}, key from ${keySource})\n`,
        );
      } else {
        stdout.write(
          "[watch] Reasoning mode: heuristic (no AI key found \u2014 set KODELA_AI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY to enable AI reasoning)\n",
        );
      }

      // Cold start: log the active attribution environment at startup.
      void runAttributionPipeline({ repoRoot, skipGitTrailer: true }).then((attr) => {
        if (attr.aiTool) {
          stdout.write(
            `[watch] Attribution cold-start: ${attr.aiTool} (confidence ${attr.attributionConfidence.toFixed(2)}, source: ${attr.source})\n`,
          );
        } else {
          stdout.write(
            "[watch] Attribution cold-start: no agent detected in environment \u2014 will use heuristics\n",
          );
        }
      });
    }
  });

  // Daemon heartbeat — refresh `.kodela/watcher.meta`'s `lastHeartbeat`
  // every HEARTBEAT_INTERVAL_MS so `kodela watch status` can detect a
  // degraded daemon (PID alive but loop blocked).  When the watcher is run
  // in the foreground (no meta file present) `refreshWatcherHeartbeat` is
  // a no-op, so this is safe to enable unconditionally.
  const heartbeatTimer = setInterval(() => {
    void refreshWatcherHeartbeat(repoRoot);
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive on the heartbeat timer alone.
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  // Fire one immediate refresh so the meta file's `lastHeartbeat` reflects
  // the actual ready timestamp (rather than the start-up timestamp written
  // by the parent).
  void refreshWatcherHeartbeat(repoRoot);

  watcher.on("batch", (batch: BatchedEvent) => {
    void handleBatch(
      batch,
      repoRoot,
      dryRun,
      debug,
      config,
      healFn,
      watchAuthor,
      contentCache,
      autoAnnotate,
      stabilizationMs,
      prevContentMap,
      sessionTracker,
      deduplicator,
      lastBatchTimestampRef,
      spikePrevContentMap,
      stdout,
      verbose,
      startedSessionIds,
      activeSessionRef,
    );
  });

  return watcher;
}

// ---------------------------------------------------------------------------
// Batch handler
// ---------------------------------------------------------------------------

async function handleBatch(
  batch: BatchedEvent,
  repoRoot: string,
  dryRun: boolean,
  debug: boolean,
  config: KodelaConfig | undefined,
  healFn: HealFn,
  watchAuthor: string,
  contentCache: Map<string, string>,
  autoAnnotate: boolean,
  stabilizationMs: number,
  prevContentMap: Map<string, string>,
  sessionTracker: SessionTracker,
  deduplicator: AnnotationDeduplicator,
  lastBatchTimestampRef: { value: number },
  spikePrevContentMap: Map<string, string>,
  stdout: NodeJS.WriteStream,
  verbose: boolean,
  startedSessionIds: Set<string>,
  activeSessionRef: ActiveSessionRef,
): Promise<void> {
  contentCache.clear();

  // Gap 24 Phase D — compute inter-batch gap for UBA Signal B (temporal).
  const now = Date.now();
  const interBatchGapMs = lastBatchTimestampRef.value > 0
    ? now - lastBatchTimestampRef.value
    : undefined;
  lastBatchTimestampRef.value = now;

  const relFilePaths = batch.events.map((e) =>
    path.relative(repoRoot, e.filePath).replace(/\\/g, "/"),
  );

  // Run heal (always).
  const start = Date.now();
  try {
    const result = await healFn(batch.events, {
      repoRoot,
      dryRun,
      debug,
      config: config?.heal ? config : undefined,
      contentCache,
      // Gap 43 — collect per-entry decisions so the notify module can detect
      // status transitions (mapped → uncertain / orphaned) and fire alerts.
      collectDecisions: true,
    });
    const durationMs = Date.now() - start;
    const batchResult: EngineWatchBatchResult = {
      filePaths: relFilePaths,
      updated: result.updated,
      orphaned: result.orphaned,
      uncertain: result.uncertain,
      dryRun,
      durationMs,
    };
    stdout.write(formatEngineWatchBatchResult(batchResult) + "\n");

    // Gap 43 — push-based drift notifications.
    if (!dryRun && result.decisions && result.decisions.length > 0) {
      void processDriftNotifications(
        result.decisions,
        repoRoot,
        config?.notify,
        process.stderr,
      ).catch(() => {
        // non-fatal — notification failure must never block the watch loop
      });
    }
  } catch (err) {
    stdout.write(
      `[watch] Error during heal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // Keep the agent Memory Bank current automatically — no developer command.
  // Throttled and fire-and-forget so it never blocks or breaks the watch loop;
  // runMemoryBank is idempotent (writes only when content actually changed).
  if (!dryRun && Date.now() - lastMemoryBankRefreshMs > MEMORY_BANK_THROTTLE_MS) {
    lastMemoryBankRefreshMs = Date.now();
    void runMemoryBank({ repoRoot }).catch(() => {
      // non-fatal — Memory Bank refresh must never disrupt capture.
    });
  }

  // Gap 58 Phase A — Spike detection pass (runs independently of autoAnnotate).
  // Detects large, likely-AI changes that have no covering ContextEntry and
  // either prompts the developer (TTY) or writes to detection-log.jsonl.
  if (!dryRun) {
    await handleSpikeDetection(batch, repoRoot, config, spikePrevContentMap, stdout);
  }

  // Auto-annotate pass (Gap 15b) — only when enabled.
  if (!autoAnnotate || dryRun) return;

  await handleAutoAnnotate(
    batch,
    repoRoot,
    config,
    watchAuthor,
    stabilizationMs,
    prevContentMap,
    sessionTracker,
    deduplicator,
    interBatchGapMs,
    stdout,
    verbose,
    startedSessionIds,
    activeSessionRef,
  );
}

// ---------------------------------------------------------------------------
// Auto-annotate: hunk-level attribution + entry creation (Gap 15b)
// ---------------------------------------------------------------------------

/**
 * Gap 75 — Scan backwards from `lineNumber` (1-based) through `content` and
 * return the nearest markdown heading, TypeScript/JavaScript top-level symbol
 * declaration, or `null` when nothing useful is found within 60 lines.
 *
 * Matches (in priority order):
 *   1. Markdown headings: `# …`, `## …`, etc.
 *   2. Exported / top-level TS/JS: `export function`, `export class`,
 *      `export const`, `export async function`, `function`, `class`.
 *   3. JSDoc block opener: `/** …`.
 */
function extractNearestHeading(content: string, lineNumber: number): string | null {
  const lines = content.split("\n");
  const start = Math.min(lineNumber - 1, lines.length - 1);
  const LOOK_BACK = 60;

  for (let i = start; i >= Math.max(0, start - LOOK_BACK); i--) {
    const line = lines[i]?.trimStart() ?? "";
    // Markdown headings
    if (/^#{1,6}\s+\S/.test(line)) {
      return line.replace(/^#{1,6}\s+/, "").trim().slice(0, 80);
    }
    // TS/JS top-level declarations
    const jsMatch = line.match(
      /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/,
    );
    if (jsMatch) return jsMatch[1] ?? null;
    // JSDoc block opener
    const jsdocMatch = line.match(/^\/\*\*\s*(.+)/);
    if (jsdocMatch) {
      const text = jsdocMatch[1]?.replace(/\*\/$/, "").trim();
      if (text && text.length > 3) return text.slice(0, 80);
    }
  }
  return null;
}

/**
 * Gap 75 — Build a meaningful auto-annotation note.
 *
 * Priority:
 *   1. First non-empty sentence from `summary` (AI tool / sidecar provided).
 *   2. Rich fallback: tool label + hunk/line counts + nearest symbol heading.
 *   3. Plain fallback when all signals are weak.
 */
function buildAutoNote(opts: {
  toolLabel: string | undefined;
  source: string;
  summary: string | undefined;
  hunkCount: number;
  totalLines: number;
  nearestHeading: string | null;
  filePath?: string;
  addedSymbols?: string[];
}): string {
  const { toolLabel, source, summary, hunkCount, totalLines, nearestHeading, filePath } = opts;

  // 1. Use the AI tool / sidecar summary if available.
  if (summary && summary.trim().length > 0) {
    const firstSentence = summary.trim().split(/(?<=[.!?])\s+/)[0] ?? summary.trim();
    const label = toolLabel ? `Auto-annotated (${toolLabel}): ` : "Auto-annotated: ";
    return (label + firstSentence).slice(0, 200);
  }

  // 2. Change-aware description — infers WHAT changed (added symbol, file role,
  //    nearest symbol) instead of a generic size template.
  if (filePath) {
    const label = toolLabel ? `Auto-annotated (${toolLabel}): ` : "Auto-annotated: ";
    const desc = describeChange({ filePath, addedSymbols: opts.addedSymbols, hunkCount, nearestHeading });
    return (label + desc).slice(0, 200);
  }

  // 3. Plain fallback when the file path isn't available.
  const toolPart = toolLabel ?? (source === "ai" ? "AI" : "unknown agent");
  const hunkPart = hunkCount === 1 ? "1 hunk" : `${hunkCount} hunks`;
  const linePart = totalLines === 1 ? "1 line" : `${totalLines} lines`;
  const locationPart = nearestHeading ? ` near \`${nearestHeading}\`` : "";
  return `Auto-annotated: ${toolPart} change — ${hunkPart}, ${linePart}${locationPart}`;
}

function buildWatchPromptText(goal: string | undefined, relPaths: string[]): string {
  const trimmedGoal = goal?.trim();
  if (trimmedGoal && trimmedGoal.length > 0) {
    return trimmedGoal;
  }

  if (relPaths.length === 0) {
    return "Auto-annotate this watcher batch and capture continuity context for handoff.";
  }

  const preview = relPaths.slice(0, 3).join(", ");
  const suffix = relPaths.length > 3 ? ` (+${relPaths.length - 3} more)` : "";
  return `Auto-annotate watcher batch for ${relPaths.length} file${relPaths.length === 1 ? "" : "s"}: ${preview}${suffix}.`;
}

function buildWatchResponseText(
  summary: string | undefined,
  reasoning: string,
  relPaths: string[],
): string {
  const trimmedSummary = summary?.trim();
  if (trimmedSummary && trimmedSummary.length > 0) {
    return trimmedSummary;
  }

  const trimmedReasoning = reasoning.trim();
  if (trimmedReasoning.length > 0) {
    return trimmedReasoning;
  }

  if (relPaths.length === 0) {
    return "Captured watcher activity and updated session metadata for continuity.";
  }

  const preview = relPaths.slice(0, 3).join(", ");
  const suffix = relPaths.length > 3 ? ` (+${relPaths.length - 3} more)` : "";
  return `Captured file activity for ${relPaths.length} file${relPaths.length === 1 ? "" : "s"}: ${preview}${suffix}.`;
}

/**
 * Gap 79 — Build a compact line-diff text from two file contents.
 *
 * Produces a prefix-annotated representation of changed lines (+/-) suitable
 * for pasting into an AI prompt asking for intent inference.  Lines that are
 * identical in both versions are omitted.  Output is capped at 200 diff lines
 * to keep queue entries a reasonable size.
 */
function buildDiffText(prevContent: string, afterContent: string): string {
  const oldLines = prevContent.split("\n");
  const newLines = afterContent.split("\n");
  const parts: string[] = [];
  const maxLine = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLine; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === undefined) {
      parts.push(`+ ${n ?? ""}`);
    } else if (n === undefined) {
      parts.push(`- ${o}`);
    } else if (o !== n) {
      parts.push(`- ${o}`);
      parts.push(`+ ${n}`);
    }
    if (parts.length >= 200) {
      parts.push("... (truncated)");
      break;
    }
  }
  return parts.join("\n");
}

async function callForProposalWithTimeout(
  diffText: string,
  opts: { config: AiLayerConfig; filePath: string },
  timeoutMs: number = 250,
): Promise<string | undefined> {
  const proposalPromise = callForProposal(diffText, opts)
    .then((proposal) => {
      const note = proposal.note?.trim();
      return note && note.length > 0 ? note : undefined;
    })
    .catch(() => undefined);

  const timeoutPromise = new Promise<undefined>((resolve) => {
    setTimeout(() => resolve(undefined), timeoutMs);
  });

  return Promise.race([proposalPromise, timeoutPromise]);
}

/** Wait for a file's size to stop changing (write stabilization). */
async function awaitWriteStabilization(
  absPath: string,
  stabilizationMs: number,
): Promise<boolean> {
  const POLL_INTERVAL = 50;
  const maxPolls = Math.ceil(stabilizationMs / POLL_INTERVAL);

  let lastSize = -1;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL));
    try {
      const stat = await fs.stat(absPath);
      if (stat.size === lastSize) return true;
      lastSize = stat.size;
    } catch {
      return false;
    }
  }
  return true;
}

async function handleAutoAnnotate(
  batch: BatchedEvent,
  repoRoot: string,
  config: KodelaConfig | undefined,
  watchAuthor: string,
  stabilizationMs: number,
  prevContentMap: Map<string, string>,
  sessionTracker: SessionTracker,
  deduplicator: AnnotationDeduplicator,
  interBatchGapMs: number | undefined,
  stdout: NodeJS.WriteStream,
  verbose: boolean,
  /** Gap 121 — tracks session IDs already flushed to disk this watcher run. */
  startedSessionIds: Set<string>,
  activeSessionRef: ActiveSessionRef,
): Promise<void> {
  const sensitivePatterns = config?.security?.sensitive_paths ?? [];
  // Gap 79 — default captureReasoning to true when an AI API key is available,
  // so intent inference is automatic without an explicit opt-in in the config.
  // Gap 127 — check ambient env vars (OPENAI_API_KEY, ANTHROPIC_API_KEY) as
  // ultimate fallbacks so users who already have these set get AI reasoning
  // without any additional Kodela-specific configuration.
  const captureReasoning =
    config?.origin?.capture_reasoning ??
    Boolean(
      config?.ai_provider?.api_key ??
      process.env["KODELA_AI_API_KEY"] ??
      process.env["OPENAI_API_KEY"] ??
      process.env["ANTHROPIC_API_KEY"],
    );

  // Gap 79 / Gap 127 — resolve AI config once per batch for extraction queue.
  // Falls back to ambient provider keys so users in Claude/OpenAI environments
  // get AI reasoning without having to copy keys into .kodela/config.yaml.
  const _aiApiKey =
    config?.ai_provider?.api_key ??
    process.env["KODELA_AI_API_KEY"] ??
    process.env["OPENAI_API_KEY"] ??
    process.env["ANTHROPIC_API_KEY"] ??
    "";
  const aiConfig: AiLayerConfig | undefined = _aiApiKey
    ? {
        provider: config?.ai_provider?.provider as AiLayerConfig["provider"],
        model: config?.ai_provider?.model,
        apiKey: _aiApiKey,
        baseUrl: config?.ai_provider?.base_url,
      }
    : undefined;

  // Only annotate file additions and modifications, not deletions.
  const relevantEvents = batch.events.filter(
    (e) => e.changeType === "create" || e.changeType === "modify",
  );
  if (relevantEvents.length === 0) return;

  // Gap 66 — per-batch counters for the summary line written at the end.
  let filesSeenCount = 0;
  let annotationsCreated = 0;
  let skippedCount = 0;

  // Read the sidecar once per batch (agent may have written one before or
  // during the debounce window).
  const sidecar = await readOriginSidecar(repoRoot);

  // Cache file contents for this debounce batch.
  const fileContents = new Map<string, string>();

  for (const event of relevantEvents) {
    // Write stabilization — wait for streaming writes to complete.
    await awaitWriteStabilization(event.filePath, stabilizationMs);

    try {
      const content = await fs.readFile(event.filePath, "utf-8");
      fileContents.set(event.filePath, content);
    } catch {
      // Binary file or read error — skip
    }
  }

  const meaningfulEvents = relevantEvents.filter((event) => {
    const afterContent = fileContents.get(event.filePath);
    if (!afterContent) return false;

    const relPath = path.relative(repoRoot, event.filePath).replace(/\\/g, "/");
    const lineCount = afterContent.split("\n").length;
    const prevContent = prevContentMap.get(event.filePath) ?? "";
    const linesAdded = Math.max(0, lineCount - prevContent.split("\n").length);
    const linesRemoved = Math.max(0, prevContent.split("\n").length - lineCount);

    if (!isMeaningfulChange(relPath, linesAdded, linesRemoved, 0.5)) {
      if (verbose) {
        stdout.write(`[watch] ${relPath} — skipped (not meaningful: lock/generated/trivial file)\n`);
      }
      skippedCount++;
      prevContentMap.set(event.filePath, afterContent);
      return false;
    }

    return true;
  });

  if (meaningfulEvents.length === 0) {
    stdout.write(
      `[watch] Batch processed: ${skippedCount} file(s) seen,` +
      ` ${annotationsCreated} annotated, ${skippedCount} skipped` +
      ` (${new Date().toISOString()})\n`,
    );
    return;
  }

  filesSeenCount = skippedCount;

  const meaningfulTotalAddedLines = meaningfulEvents.reduce((sum, event) => {
    const afterContent = fileContents.get(event.filePath);
    if (!afterContent) return sum;
    const prevContent = prevContentMap.get(event.filePath) ?? "";
    const linesAfter = afterContent.split("\n").length;
    const linesBefore = prevContent.split("\n").length;
    return sum + Math.max(0, linesAfter - linesBefore);
  }, 0);

  // Run attribution pipeline once for the meaningful subset of the batch.
  let attribution: Awaited<ReturnType<typeof runAttributionPipeline>>;
  try {
    attribution = await runAttributionPipeline({
      repoRoot,
      sidecar,
      totalAddedLines: meaningfulTotalAddedLines,
      batchSize: meaningfulEvents.length,
      skipGitTrailer: false,
    });
  } catch {
    attribution = {
      aiTool: process.env["KODELA_AGENT"]?.trim() || null,
      attributionConfidence: 0.5,
      canUpgradeAttribution: true,
      source: "heuristic",
      ...(process.env["KODELA_MODEL"]?.trim()
        ? { model: process.env["KODELA_MODEL"]!.trim() }
        : {}),
    };
  }

  // Compute session ID for this batch.
  const relPaths = meaningfulEvents.map((e) =>
    path.relative(repoRoot, e.filePath).replace(/\\/g, "/"),
  );
  const sessionId = sessionTracker.record(
    relPaths,
    attribution.aiTool ?? undefined,
    Date.now(),
  );

  const previousSessionId = activeSessionRef.id;

  const [gitBranch, gitHeadCommit, gitHeadMessage] = await Promise.all([
    readGitBranch(repoRoot),
    readGitHeadCommit(repoRoot),
    readGitHeadMessage(repoRoot),
  ]);
  const nowIso = new Date().toISOString();

  const actorTool =
    attribution.aiTool ??
    process.env["KODELA_AGENT"]?.trim() ??
    "unknown";
  const actorModel =
    attribution.model ??
    process.env["KODELA_MODEL"]?.trim() ??
    config?.ai_provider?.model;
  const sessionReasoning =
    captureReasoning
      ? (attribution.reasoning ?? sidecar?.reasoning ?? []).join(" ").trim()
      : "";

  let sessionInitialized = false;

  async function ensureSessionInitialized(): Promise<void> {
    if (sessionInitialized) return;

    const configuredGoal = process.env["KODELA_GOAL"]?.trim() || undefined;
    const watchPromptText = buildWatchPromptText(configuredGoal, relPaths);
    const watchResponseText = buildWatchResponseText(
      attribution.summary,
      sessionReasoning,
      relPaths,
    );

    if (previousSessionId && previousSessionId !== sessionId) {
      await closeSession(repoRoot, previousSessionId).catch(() => undefined);
      await synthesiseAndWriteSessionSummary(repoRoot, previousSessionId).catch(() => null);
    }
    activeSessionRef.id = sessionId;

    // Gap 121 — Write a KodelaSession file to disk the first time a new session
    // boundary is detected. KODELA_GOAL captures the user's stated intent so
    // dashboard and handoff output show a meaningful goal.
    if (!startedSessionIds.has(sessionId)) {
      startedSessionIds.add(sessionId);
      const sessionGoal = configuredGoal ?? watchPromptText;
      await startSession(repoRoot, sessionId, { goal: sessionGoal }).catch(() => undefined);

      await updateSessionGitSnapshot(repoRoot, sessionId, "start", {
        ...(gitBranch ? { branch: gitBranch } : {}),
        ...(gitHeadCommit ? { headCommit: gitHeadCommit } : {}),
        ...(watchAuthor !== "unknown" ? { author: watchAuthor } : {}),
        capturedAt: nowIso,
      }).catch(() => undefined);
    }

    await updateSessionActor(repoRoot, sessionId, {
      tool: actorTool,
      ...(actorModel ? { model: actorModel } : {}),
      ...(watchAuthor !== "unknown" ? { author: watchAuthor } : {}),
    }).catch(() => undefined);

    await updateSessionIntent(repoRoot, sessionId, {
      userPrompt: watchPromptText,
      ...(attribution.summary ? { synthesised: attribution.summary } : {}),
      ...(sessionReasoning ? { aiReasoning: sessionReasoning } : {}),
      ...(gitBranch ? { branchContext: gitBranch } : {}),
      ...(gitHeadMessage ? { commitMessage: gitHeadMessage } : {}),
      source: `watch-${attribution.source ?? "heuristic"}`,
      confidence: Math.min(1, Math.max(0, attribution.attributionConfidence ?? 0)),
    }).catch(() => undefined);

    const requestTurn = await appendUserTurn(
      repoRoot,
      sessionId,
      watchPromptText,
      { source: "watch-auto-annotate" },
    ).catch(() => null);

    await appendAssistantTurn(
      repoRoot,
      sessionId,
      watchResponseText,
      {
        source: "watch-auto-annotate",
        ...(requestTurn ? { promptId: requestTurn.id } : {}),
      },
    ).catch(() => null);

    await updateSessionGitSnapshot(repoRoot, sessionId, "end", {
      ...(gitBranch ? { branch: gitBranch } : {}),
      ...(gitHeadCommit ? { headCommit: gitHeadCommit } : {}),
      ...(watchAuthor !== "unknown" ? { author: watchAuthor } : {}),
      filesChanged: relPaths,
      diffStats: {
        workingTree: meaningfulEvents.length,
        total: meaningfulEvents.length,
      },
      capturedAt: nowIso,
    }).catch(() => undefined);

    sessionInitialized = true;
  }

  // Gap 23 / Gap 24 — Batch-level UBA signal components (shared across all files).
  // Signal E: environment — is the attribution from an explicit agent declaration
  // (KODELA_AGENT env var or .kodela/origin.json sidecar) or a weaker known-env?
  const isExplicitAgentSignal =
    attribution.source === "env" || attribution.source === "sidecar";
  const hasKnownEnvSignal =
    attribution.source !== "none" && attribution.source !== "heuristic";
  // Gap 23 Option 3 — human-first bias threshold.
  const minAutoAnnotateConfidence =
    config?.ai_detection?.min_auto_annotate_confidence ?? 0.7;

  for (const event of relevantEvents) {
    const relPath = path.relative(repoRoot, event.filePath).replace(/\\/g, "/");
    const afterContent = fileContents.get(event.filePath);
    if (!afterContent) continue;

    filesSeenCount++;

    // Intent filter (Gap 15b) — skip lock files, dist, generated, etc.
    const lineCount = afterContent.split("\n").length;
    const prevContent = prevContentMap.get(event.filePath) ?? "";
    const linesAdded = Math.max(0, lineCount - prevContent.split("\n").length);
    const linesRemoved = Math.max(0, prevContent.split("\n").length - lineCount);

    if (!isMeaningfulChange(relPath, linesAdded, linesRemoved, 0.5)) {
      if (verbose) {
        stdout.write(`[watch] ${relPath} — skipped (not meaningful: lock/generated/trivial file)\n`);
      }
      skippedCount++;
      // Update prev content so future batches diff correctly.
      prevContentMap.set(event.filePath, afterContent);
      continue;
    }

    const contentHash = hashTokenStream(afterContent);

    // Deduplication check (Gap 15b).
    if (deduplicator.isDuplicate(relPath, contentHash)) {
      if (verbose) {
        stdout.write(`[watch] ${relPath} — skipped (duplicate: content hash unchanged)\n`);
      }
      skippedCount++;
      prevContentMap.set(event.filePath, afterContent);
      continue;
    }

    // Security check — skip files that match sensitive path patterns entirely.
    // We update prevContentMap so future diffs stay accurate, but no entry
    // is written and nothing is logged to avoid leaking the file's existence.
    if (isSensitivePath(relPath, sensitivePatterns)) {
      stdout.write(`[watch] Skipped (sensitive path): ${relPath}\n`);
      skippedCount++;
      prevContentMap.set(event.filePath, afterContent);
      continue;
    }

    // Hunk-level diff against previous content (Gap 15b).
    const diffResult = computeDiff({
      oldContent: prevContent,
      newContent: afterContent,
    });

    // Collect added + modified hunks.
    const annotationHunks = [
      ...diffResult.added.map((h) => ({
        range: h.newRange ?? ([1, lineCount] as [number, number]),
        hash: h.contentHash ?? contentHash,
      })),
      ...diffResult.modified.map((h) => ({
        range: h.newRange ?? ([1, lineCount] as [number, number]),
        hash: h.contentHash ?? contentHash,
      })),
    ];

    // Fall back to whole-file entry when no hunks.
    const hunks =
      annotationHunks.length > 0
        ? annotationHunks
        : [{ range: [1, lineCount] as [number, number], hash: contentHash }];

    // Gap 24 Phase C+D — per-file UBA scoring using behavioral signals.
    // Signal D: structural change — does this file have a large contiguous block?
    const hasLargeContiguousBlock = annotationHunks.some(
      (h) => (h.range[1] - h.range[0] + 1) >= 20,
    );
    const ubaSignals: UbaSignals = {
      // Signal A: how many lines were added to this specific file?
      linesAdded,
      // Signal A/B: number of files in the batch (write event count).
      writeEventCount: meaningfulEvents.length,
      // Signal A/B: all changes arrived in a single debounce window.
      isSingleBatch: true,
      // Signal B: time since last annotation batch (undefined = first batch).
      interBatchGapMs,
      // Signal C: total files changed in this batch.
      fileCount: meaningfulEvents.length,
      // Signal D: structural — large single block replacement detected.
      hasLargeContiguousBlock,
      // Signal E: known AI IDE environment variable present.
      hasKnownEnvSignal,
      // Signal E: fully explicit agent declaration (KODELA_AGENT or sidecar).
      isExplicitAgentSignal,
    };

    const ubaResult = ubaScore(ubaSignals);

    // Gap 23 Option 3 — Human-first bias: downgrade "ai" to "unknown" when
    // confidence is below the configured threshold.
    let finalSource = ubaResult.source;
    let finalConfidence = ubaResult.confidence;
    let finalStatus = ubaResult.status;
    let finalReviewRequired = ubaResult.reviewRequired;

    if (finalSource === "ai" && finalConfidence < minAutoAnnotateConfidence) {
      finalSource = "unknown";
      finalStatus = "uncertain";
      finalReviewRequired = false;
    }

    // Gap 65 fix — Explicit agent signal overrides UBA "human" classification.
    // When the operator has declared KODELA_AGENT or dropped a .kodela/origin.json
    // sidecar, they are asserting authorship.  Respect that even for small changes
    // that the UBA engine classifies as human (because Signal A and C are weak for
    // targeted 1–20 line edits).  Promoting "human" → "unknown" here lets the Bug 4
    // fix below then promote to "ai" when the attribution tool is positively identified.
    if (finalSource === "human" && isExplicitAgentSignal) {
      finalSource = "unknown";
      finalStatus = "uncertain";
      finalReviewRequired = false;
      finalConfidence = Math.max(finalConfidence, 0.5);
    }

    // Bug 4 fix — Attribution-aware source promotion.
    // The UBA behavioral scorer's Trust Rule 2 forces source = "unknown" for
    // any classificationScore in [0.50, 0.80]. This is correct for pure
    // behavioral inference, but when the attribution pipeline has already
    // positively identified a specific AI tool (via a named env var, sidecar,
    // or process ancestry — not just a heuristic), suppressing that finding
    // causes entries to appear AI-unaware.
    //
    // Fix: when UBA says "unknown" but attribution has a confirmed tool name,
    // promote source to "ai". The status stays "uncertain" — that correctly
    // reflects the mapping-confidence level. These are independent concerns:
    //   source: "ai"       = which tool wrote the code (attribution pipeline)
    //   status: "uncertain" = how confident we are in the mapping location (UBA)
    const attributionIdentifiedAiTool =
      attribution.aiTool != null &&
      attribution.source !== "none" &&
      attribution.source !== "heuristic";

    if (finalSource === "unknown" && attributionIdentifiedAiTool) {
      finalSource = "ai";
      // status intentionally preserved as "uncertain"
      // reviewRequired intentionally preserved as false
    }

    // Gap 23 Option 4 — Hard cap: confidence 1.0 is only emitted for entries
    // with fully explicit agent signals (KODELA_AGENT or sidecar). The UBA
    // scorer already enforces this via trust rule 3, but guard here too.
    if (!isExplicitAgentSignal && finalConfidence >= 1.0) {
      finalConfidence = 0.89;
    }

    // Human-classified edits do not need auto-annotation — the watcher is
    // designed to track AI changes. Skip this file and move on.
    // Note: explicit agent signals are rescued above before reaching this gate.
    if (finalSource === "human") {
      if (verbose) {
        const s = ubaResult.classificationSignals;
        stdout.write(
          `[watch] ${relPath} — skipped (UBA: score=${ubaResult.classificationScore.toFixed(3)} source=human,` +
          ` signals: A=${(s["editPattern"] ?? 0).toFixed(2)} B=${(s["temporalSignature"] ?? 0).toFixed(2)}` +
          ` C=${(s["fileScope"] ?? 0).toFixed(2)} D=${(s["structuralChange"] ?? 0).toFixed(2)}` +
          ` E=${(s["environment"] ?? 0).toFixed(2)})\n`,
        );
      }
      deduplicator.record(relPath, contentHash);
      prevContentMap.set(event.filePath, afterContent);
      skippedCount++;
      continue;
    }

    await ensureSessionInitialized();

    const now = new Date().toISOString();
    const author = watchAuthor;

    // Build origin block.
    const origin =
      attribution.aiTool != null || sidecar != null
        ? {
            type: "ai" as const,
            tool: attribution.aiTool ?? sidecar?.aiTool ?? sidecar?.tool,
            model: attribution.model ?? sidecar?.model,
            sessionId: attribution.sessionId ?? sessionId ?? sidecar?.sessionId,
            summary: attribution.summary ?? sidecar?.summary,
            reasoning:
              captureReasoning
                ? (attribution.reasoning ?? sidecar?.reasoning)
                : undefined,
          }
        : undefined;

    // Gap 75 — Build a meaningful note using summary first, then hunk-aware
    // fallback with nearest symbol heading.  Replaces the static template that
    // carried no information about what actually changed.
    const firstHunkStart = hunks[0]?.range[0] ?? 1;
    const totalHunkLines = hunks.reduce(
      (acc, h) => acc + (h.range[1] - h.range[0] + 1),
      0,
    );
    const nearestHeading = extractNearestHeading(afterContent, firstHunkStart);
    // Symbols defined in the changed regions — lets the fallback note say what
    // was actually added ("Added `rotateToken`…") rather than just its size.
    const afterLines = afterContent.split("\n");
    const changedLines = hunks.flatMap((h) => afterLines.slice(h.range[0] - 1, h.range[1]));
    const addedSymbols = extractSymbols(changedLines);
    const heuristicNote = buildAutoNote({
      toolLabel: attribution.aiTool ?? sidecar?.aiTool ?? sidecar?.tool,
      source: finalSource,
      summary: attribution.summary ?? sidecar?.summary,
      hunkCount: hunks.length,
      totalLines: totalHunkLines,
      nearestHeading,
      filePath: relPath,
      addedSymbols,
    });

    // Compute a compact diff string whenever it is needed:
    //   - captureReasoning=true → needed for the Gap 79 extraction queue
    //   - aiConfig present      → needed for the AI proposal note (independent of reasoning)
    // The two concerns are intentionally decoupled: a user may set
    // capture_reasoning=false while still having an API key configured, and
    // they should still receive AI-generated notes.
    const diffText =
      captureReasoning || aiConfig
        ? buildDiffText(prevContent, afterContent)
        : undefined;

    // AI Summary Layer — call the AI provider to generate a meaningful note
    // at entry creation time, replacing the heuristic fallback.  Wrapped in
    // try/catch so any provider failure falls back silently to the heuristic.
    let aiProposalNote: string | undefined;
    if (aiConfig && diffText && diffText.trim().length > 0) {
      try {
        aiProposalNote = await callForProposalWithTimeout(diffText, {
          config: aiConfig,
          filePath: relPath,
        });
      } catch {
        // AI provider call failed — heuristic note will be used
      }
    }

    const autoNote = aiProposalNote ?? heuristicNote;

    // Derive trust level from attribution confidence using the canonical
    // normalizeContext mapping (confirmed ≥0.9, uncertain 0.5–0.89, none <0.5).
    const normalizedCtx = normalizeContext({
      tool: attribution.aiTool,
      source: attribution.source,
      attributionConfidence: attribution.attributionConfidence,
      canUpgradeAttribution: attribution.canUpgradeAttribution,
      filePath: relPath,
      diff: diffText,
      linesAdded,
      ubaScore: ubaResult.classificationScore,
      ubaSignals: ubaResult.classificationSignals,
      ubaSource: finalSource === "ai" ? "ai" : "unknown",
      sessionId: sessionId ?? undefined,
      model: attribution.model ?? sidecar?.model,
      summary: attribution.summary ?? sidecar?.summary,
    });
    const trustLevel = normalizedCtx.trustLevel;

    // Trust-level promotion: "confirmed" attribution means we know exactly
    // which AI tool wrote the code — no human review needed for the attribution
    // itself (code review is a separate concern).
    const promotedReviewRequired = trustLevel === "confirmed" ? false : finalReviewRequired;
    const promotedTags: string[] =
      finalSource === "ai" ? ["ai", "auto"] : ["auto"];
    if (trustLevel === "confirmed") {
      promotedTags.push("confirmed");
    }

    // Update origin.summary with the first sentence of the AI-generated note
    // so it is always the most informative value available.
    const finalOrigin: ContextEntry["origin"] = origin
      ? {
          ...origin,
          summary: aiProposalNote
            ? (aiProposalNote.split(/(?<=[.!?])\s+/)[0] ?? aiProposalNote).slice(0, 200)
            : origin.summary,
        }
      : undefined;

    // Gap 101 — map internal TrustLevel ("confirmed"|"uncertain"|"none") to
    // the persisted tier ("high"|"medium"|"low") stored on the entry.
    const resolvedTrustLevel: "high" | "medium" | "low" =
      trustLevel === "confirmed" ? "high" :
      trustLevel === "uncertain" ? "medium" : "low";

    for (const hunk of hunks) {
      const [hunkStart, hunkEnd] = hunk.range;
      const entryId = crypto.randomUUID();
      const partial: ContextEntry = {
        schemaVersion: SCHEMA_VERSION,
        id: entryId,
        filePath: relPath,
        astAnchor: null,
        contentHash: hunk.hash,
        lineRange: { start: hunkStart, end: Math.max(hunkStart, hunkEnd) },
        note: autoNote,
        author,
        createdAt: now,
        updatedAt: now,
        severity: "low",
        tags: promotedTags,
        source: finalSource,
        confidence: finalConfidence,
        attributionConfidence: attribution.attributionConfidence,
        canUpgradeAttribution:
          trustLevel === "confirmed" ? false : (attribution.canUpgradeAttribution && !isExplicitAgentSignal),
        ...(attribution.aiTool ? { aiTool: attribution.aiTool } : {}),
        classificationScore: ubaResult.classificationScore,
        classificationSignals: ubaResult.classificationSignals,
        status: finalStatus,
        reviewRequired: promotedReviewRequired,
        ...(sessionId ? { sessionId } : {}),
        ...(finalOrigin ? { origin: finalOrigin } : {}),
      };

      // Gap 100/101/102/103 — apply all enrichment layers before persisting.
      const entry = enrichEntry(partial, {
        sourceType: "watcher",
        isExplicitAgent: isExplicitAgentSignal,
        trustLevel: resolvedTrustLevel,
        fileContent: afterContent,
        diff: diffText ?? undefined,
        linesAdded,
        linesRemoved,
        fileCount: 1,
        aiProposalNote: aiProposalNote ?? undefined,
      });

      try {
        await writeContextEntry(repoRoot, entry);
        annotationsCreated++;
        if (verbose) {
          stdout.write(
            `[watch] ${relPath} — annotated (source=${finalSource} status=${finalStatus}` +
            ` conf=${finalConfidence.toFixed(2)} session=${sessionId.slice(0, 8)}\u2026)\n`,
          );
        }
        // Gap 121 — link this entry to the session file so session.entries[]
        // is populated and the handoff/dashboard can surface per-session context.
        await linkEntryToSession(repoRoot, sessionId, entry.id, relPath).catch(() => undefined);
        // Gap 79 — enqueue AI intent inference for this entry so the heuristic
        // note gets replaced with a meaningful description during the next
        // `kodela heal` run (or VSCode idle drain when implemented in Gap 77).
        if (captureReasoning && diffText !== undefined) {
          void scheduleExtraction(
            repoRoot,
            entry,
            { diff: diffText, sessionId: origin?.sessionId },
          );
        }
      } catch {
        // best-effort — storage errors should not crash the watcher
      }
    }

    deduplicator.record(relPath, contentHash);
    prevContentMap.set(event.filePath, afterContent);
  }

  if (annotationsCreated > 0) {
    stdout.write(
      `[watch] Auto-annotate: created ${annotationsCreated} entr${annotationsCreated === 1 ? "y" : "ies"} ` +
      `(tool: ${attribution.aiTool ?? "unknown"}, conf: ${attribution.attributionConfidence.toFixed(2)}, session: ${sessionId.slice(0, 8)}\u2026)\n`,
    );

    // Keep latest sessions timeline-ready by writing/refreshing summary sidecars
    // immediately after watcher annotation batches.
    await synthesiseAndWriteSessionSummary(repoRoot, sessionId).catch(() => null);
  }

  // Gap 122 — drain the extraction queue after every batch so that entries
  // created by the watcher get their `reasoning` fields populated.  When no AI
  // API key is configured this is a no-op for AI calls but still flushes any
  // pending heuristic reasoning that was enqueued above.
  if (annotationsCreated > 0 && aiConfig) {
    void drainExtractionQueue(repoRoot, aiConfig).catch(() => undefined);
  }

  // Gap 66 — batch summary written to stdout on every processed batch,
  // regardless of verbose mode.  Gives operators evidence that the watcher
  // is active and making decisions even when no entries are created.
  stdout.write(
    `[watch] Batch processed: ${filesSeenCount} file(s) seen,` +
    ` ${annotationsCreated} annotated, ${skippedCount} skipped` +
    ` (${new Date().toISOString()})\n`,
  );
}

// ---------------------------------------------------------------------------
// Gap 58 Phase A — Spike detection (runs after every heal cycle)
// ---------------------------------------------------------------------------

/**
 * Detect large, likely-AI changes after each heal batch.
 *
 * For each modified file:
 *   1. Compute the diff against spikePrevContentMap ("last seen by detector").
 *   2. If linesChanged > threshold AND UBA score > uba_threshold, flag it.
 *   3. If TTY and interactive: emit an interactive prompt.
 *   4. Otherwise: write to .kodela/detection-log.jsonl silently.
 *
 * spikePrevContentMap is updated for every processed file so subsequent
 * batches diff correctly even if autoAnnotate is disabled.
 */
async function handleSpikeDetection(
  batch: BatchedEvent,
  repoRoot: string,
  config: KodelaConfig | undefined,
  spikePrevContentMap: Map<string, string>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const thresholdLines = config?.detect?.threshold_lines ?? 50;
  const ubaThreshold = config?.detect?.uba_threshold ?? 0.6;
  const interactive = config?.detect?.interactive ?? true;

  const relevantEvents = batch.events.filter(
    (e) => e.changeType === "create" || e.changeType === "modify",
  );
  if (relevantEvents.length === 0) return;

  for (const event of relevantEvents) {
    let afterContent: string;
    try {
      afterContent = await fs.readFile(event.filePath, "utf-8");
    } catch {
      continue;
    }

    const prevContent = spikePrevContentMap.get(event.filePath) ?? "";
    const linesAfter = afterContent.split("\n").length;
    const linesBefore = prevContent.split("\n").length;
    const linesChanged = Math.abs(linesAfter - linesBefore);

    // Always update spikePrevContentMap so subsequent batches diff correctly.
    spikePrevContentMap.set(event.filePath, afterContent);

    if (linesChanged < thresholdLines) continue;

    // Compute UBA signals from the diff.
    const diffResult = computeDiff({ oldContent: prevContent, newContent: afterContent });
    const hasLargeContiguousBlock =
      [...diffResult.added, ...diffResult.modified].some(
        (h) => h.newRange && (h.newRange[1] - h.newRange[0] + 1) >= 20,
      );
    const linesAdded = Math.max(0, linesAfter - linesBefore);

    const ubaResult = ubaScore({
      linesAdded,
      writeEventCount: relevantEvents.length,
      isSingleBatch: true,
      fileCount: relevantEvents.length,
      hasLargeContiguousBlock,
      hasKnownEnvSignal: false,
      isExplicitAgentSignal: false,
    });

    if (ubaResult.classificationScore < ubaThreshold) continue;

    const relPath = path.relative(repoRoot, event.filePath).replace(/\\/g, "/");
    const scoreStr = ubaResult.classificationScore.toFixed(2);

    if (interactive && process.stdout.isTTY) {
      await runSpikePrompt(relPath, linesChanged, ubaResult, repoRoot, stdout);
    } else {
      // Non-interactive: log silently and print a one-liner to the watch output.
      await appendDetectionLog(repoRoot, {
        timestamp: new Date().toISOString(),
        file: relPath,
        linesChanged,
        ubaScore: ubaResult.classificationScore,
        signals: ubaResult.classificationSignals,
      });
      stdout.write(
        `[watch] AI spike detected: ${relPath} (${linesChanged} lines, score ${scoreStr}) → .kodela/detection-log.jsonl\n`,
      );
    }
  }
}

/**
 * Interactive TTY prompt for a detected AI-likely change.
 * Asks the developer whether the change was AI-generated and, if yes,
 * optionally records a one-line reason as a ContextEntry.
 */
async function runSpikePrompt(
  relPath: string,
  linesChanged: number,
  ubaResult: { classificationScore: number; classificationSignals: Record<string, number> },
  repoRoot: string,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  const question = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  try {
    stdout.write(
      `\n[kodela] Large change detected in ${relPath} ` +
      `(${linesChanged} lines, AI-score ${ubaResult.classificationScore.toFixed(2)})\n`,
    );
    const answer = await question("[kodela] Was this AI-generated? [y/n/skip] ");
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "y" || trimmed === "yes") {
      const reason = await question("[kodela] One-line reason (press Enter to skip): ");
      await createDetectionEntry(
        repoRoot,
        relPath,
        reason.trim(),
        ubaResult.classificationScore,
        ubaResult.classificationSignals,
      );
      stdout.write(`[kodela] Entry recorded for ${relPath}\n`);
    } else {
      stdout.write(`[kodela] Skipped annotation for ${relPath}\n`);
    }
  } catch {
    // If stdin is closed or readline errors, skip silently
  } finally {
    rl.close();
  }
}
