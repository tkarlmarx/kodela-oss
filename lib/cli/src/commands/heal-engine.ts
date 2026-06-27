// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Auto-heal engine — incremental context-mapping driven by watcher change events.
 *
 * Unlike `runHeal` (which scans every indexed entry), this engine processes only
 * the files that the watcher reports as changed, making it suitable for the
 * hot path triggered on every file save.
 *
 * Design goals:
 *   - Deterministic: same inputs always produce the same outputs.
 *   - Safe:  never silently maps an entry to the wrong location; uncertain and
 *            orphaned results are always surfaced explicitly.
 *   - Incremental: skips entries whose file is not in the change set.
 *   - Async: all I/O is non-blocking; entries within a file are processed
 *            concurrently where possible.
 *   - Debuggable: `debug: true` writes per-entry mapping decisions to stderr.
 *   - Observable: `collectDecisions: true` returns per-entry `MappingDecision`
 *            objects in `HealResult.decisions` for programmatic inspection.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readIndex,
  readContextEntry,
  writeContextEntry,
  mapContextEntry,
  loadLicense,
  extractFingerprint,
  computeContentDrift,
  writeMappingFile,
  hashFilePath,
  SCHEMA_VERSION,
} from "@kodela/core";
import type { ContextEntry, MappingFile } from "@kodela/core";
import type { DetailedMappingResult } from "@kodela/core";
import { recordCliEvent } from "../audit/recordCliEvent.js";
import { computeDiff, isLikelyAIChange, isPossibleRewrite } from "@kodela/diff";
import type { ChangeEvent } from "@kodela/watcher";
import type { KodelaConfig } from "../config/schema.js";
import { applyDiffSignal } from "./heal.js";
import type { DiffSignal } from "./heal.js";

const execFileAsync = promisify(execFile);

// ─── Public types ─────────────────────────────────────────────────────────────

export type HealEngineOptions = {
  /** Absolute path to the repository root. */
  repoRoot: string;
  /**
   * Print per-entry mapping decisions, scores, layer used, and reason
   * to stderr. Equivalent to the `kodela heal --debug` flag.
   */
  debug?: boolean;
  /**
   * When true, compute and return results but do not persist any changes.
   */
  dryRun?: boolean;
  /**
   * When true, each processed entry produces a `MappingDecision` record
   * returned in `HealResult.decisions`.  Useful for dashboards, CI checks,
   * VS Code hover providers, and other programmatic consumers that need
   * per-entry scores and reasons without parsing stderr.
   *
   * Compatible with `debug: true` — both can be enabled simultaneously.
   */
  collectDecisions?: boolean;
  /**
   * Loaded Kodela config.  When provided, `heal.ai_confidence_cap` and
   * `heal.rewrite_confidence_factor` override built-in defaults (0.6 / 0.85).
   */
  config?: KodelaConfig;
  /**
   * Optional shared content cache.  Pass the same `Map` instance across
   * multiple `heal()` calls to avoid redundant `fs.readFile` calls when the
   * watcher triggers in quick succession for the same set of files.
   *
   * The caller is responsible for invalidating entries when files are known
   * to have been updated (e.g. after each debounce window).
   */
  contentCache?: Map<string, string>;
};

/**
 * Aggregate outcome of a single incremental heal run.
 *
 * Each processed entry contributes to exactly one counter:
 *   - `updated`   → final status is "mapped"  (high-confidence location found)
 *   - `uncertain` → final status is "uncertain" (low-confidence; review needed)
 *   - `orphaned`  → file deleted, or mapping completely failed
 *
 * `decisions` is populated only when `HealEngineOptions.collectDecisions` is
 * `true`.  Each element corresponds to exactly one processed entry and carries
 * the `score`, `layerUsed`, and `reason` fields needed by programmatic
 * consumers such as hover providers, CI reporters, and dashboards.
 */
export type HealResult = {
  updated: number;
  orphaned: number;
  uncertain: number;
  decisions?: MappingDecision[];
};

/**
 * Per-entry mapping decision record emitted in debug mode and/or returned
 * in `HealResult.decisions` when `collectDecisions: true`.
 *
 * Exposed for callers that want to capture decisions programmatically instead
 * of relying on stderr output.
 */
export type MappingDecision = {
  entryId: string;
  filePath: string;
  changeType: ChangeEvent["changeType"];
  diffSignal: DiffSignal;
  layerUsed: string;
  before: { lineRange: { start: number; end: number }; status: string; confidence: number };
  after: { lineRange: { start: number; end: number }; status: string; confidence: number };
  score: number;
  reason: string;
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

function debugWrite(message: string): void {
  process.stderr.write(`[heal-engine] ${message}\n`);
}

/**
 * Fetch the committed (HEAD) version of `relPath` from git.
 * Returns `null` when git is unavailable or the file has no committed version.
 */
async function getGitBaseContent(
  repoRoot: string,
  relPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["show", `HEAD:${relPath}`],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Classify how much a file changed relative to its last committed version.
 * Returns `"none"` when no baseline is available (new file / git missing).
 */
async function classifyFileDiff(
  repoRoot: string,
  relPath: string,
  currentContent: string,
): Promise<DiffSignal> {
  const oldContent = await getGitBaseContent(repoRoot, relPath);
  if (oldContent === null) return "none";

  const diff = computeDiff({ oldContent, newContent: currentContent });
  if (isLikelyAIChange(diff)) return "likely-ai";
  if (isPossibleRewrite(diff)) return "possible-rewrite";
  return "minimal";
}

/**
 * Convert an event-carried file path to a repo-relative POSIX path.
 * The watcher emits absolute paths; `entry.filePath` is always relative.
 */
function toRelPath(filePath: string, repoRoot: string): string {
  const rel = path.isAbsolute(filePath)
    ? path.relative(repoRoot, filePath)
    : filePath;
  return rel.replace(/\\/g, "/");
}

/**
 * Build a human-readable reason string for debug / audit output.
 */
function buildReason(
  changeType: string,
  signal: DiffSignal,
  layer: string,
  status: string,
  score: number,
): string {
  const parts: string[] = [];

  if (changeType === "create") parts.push("new file");

  switch (signal) {
    case "likely-ai":
      parts.push("AI-likely change — confidence capped");
      break;
    case "possible-rewrite":
      parts.push("possible rewrite — confidence reduced");
      break;
    case "minimal":
      parts.push("minimal change");
      break;
    case "none":
      parts.push("no git baseline");
      break;
  }

  parts.push(`${layer} layer scored ${(score * 100).toFixed(1)}%`);

  if (status === "orphaned") parts.push("→ ORPHANED (confidence too low)");
  else if (status === "uncertain") parts.push("→ UNCERTAIN (needs review)");
  else parts.push("→ mapped");

  return parts.join("; ");
}

/**
 * Emit a single-line debug record describing one mapping decision.
 */
function emitDecision(d: MappingDecision): void {
  const status = d.after.status.padEnd(9);
  const id = d.entryId.slice(0, 8);
  const before = `L${d.before.lineRange.start}-${d.before.lineRange.end}`;
  const after = `L${d.after.lineRange.start}-${d.after.lineRange.end}`;
  debugWrite(
    `[${status}] ${id} ${d.filePath}` +
    `  ${before} → ${after}` +
    `  score=${d.score.toFixed(3)}` +
    `  layer=${d.layerUsed}` +
    `  signal=${d.diffSignal}` +
    `  reason: ${d.reason}`,
  );
}

// ─── Entry processing helpers ─────────────────────────────────────────────────

/**
 * Mark a single entry as orphaned (file was deleted).
 * Returns the updated entry (or the original in dry-run mode).
 */
async function orphanEntry(
  repoRoot: string,
  entry: ContextEntry,
  dryRun: boolean,
): Promise<ContextEntry> {
  const updated: ContextEntry = {
    ...entry,
    status: "orphaned",
    reviewRequired: true,
    updatedAt: new Date().toISOString(),
  };
  if (!dryRun) {
    await writeContextEntry(repoRoot, updated);
  }
  return updated;
}

/**
 * Build a `MappingDecision` for an entry whose file was deleted.
 * No mapping engine runs — the entry is immediately orphaned.
 */
function buildDeleteDecision(
  entry: ContextEntry,
  entryPath: string,
): MappingDecision {
  return {
    entryId: entry.id,
    filePath: entryPath,
    changeType: "delete",
    diffSignal: "none",
    layerUsed: "none",
    before: {
      lineRange: entry.lineRange,
      status: entry.status,
      confidence: entry.confidence,
    },
    after: {
      lineRange: entry.lineRange,
      status: "orphaned",
      confidence: 0,
    },
    score: 0,
    reason: "file deleted",
  };
}

/**
 * Run the mapping engine for one entry and persist the result.
 *
 * Returns a `MappingDecision` so callers can tally and/or log it.
 */
async function processEntry(
  repoRoot: string,
  entry: ContextEntry,
  fileContent: string,
  changeType: ChangeEvent["changeType"],
  diffSignal: DiffSignal,
  aiConfidenceCap: number,
  rewriteConfidenceFactor: number,
  dryRun: boolean,
  originalFilePath?: string,
): Promise<MappingDecision> {
  let mappingResult: DetailedMappingResult;

  try {
    mappingResult = await mapContextEntry(entry, fileContent, repoRoot);
  } catch {
    // Mapping engine threw — treat as complete loss of context
    mappingResult = {
      confidence: 0,
      status: "orphaned",
      updatedLineRange: entry.lineRange,
      layerUsed: "fallback",
    };
  }

  const adjusted = applyDiffSignal(
    diffSignal,
    mappingResult.confidence,
    entry.reviewRequired,
    aiConfidenceCap,
    rewriteConfidenceFactor,
  );

  const finalStatus = mappingResult.status;
  const finalConfidence = adjusted.confidence;
  const finalReviewRequired = adjusted.reviewRequired;

  const reason = buildReason(
    changeType,
    diffSignal,
    mappingResult.layerUsed,
    finalStatus,
    finalConfidence,
  );

  const decision: MappingDecision = {
    entryId: entry.id,
    filePath: entry.filePath,
    changeType,
    diffSignal,
    layerUsed: mappingResult.layerUsed,
    before: {
      lineRange: entry.lineRange,
      status: entry.status,
      confidence: entry.confidence,
    },
    after: {
      lineRange: mappingResult.updatedLineRange,
      status: finalStatus,
      confidence: finalConfidence,
    },
    score: finalConfidence,
    reason,
  };

  // Persist when the entry has materially changed
  const changed =
    mappingResult.updatedLineRange.start !== entry.lineRange.start ||
    mappingResult.updatedLineRange.end !== entry.lineRange.end ||
    finalStatus !== entry.status ||
    Math.abs(finalConfidence - entry.confidence) > 0.001 ||
    finalReviewRequired !== entry.reviewRequired ||
    (originalFilePath !== undefined && originalFilePath !== entry.filePath);

  // Gap 48 — recompute content fingerprint and drift level.
  const newRange = mappingResult.updatedLineRange;
  const fileLines = fileContent.split("\n");
  const currentSlice = fileLines.slice(newRange.start - 1, newRange.end).join("\n");
  const currentFingerprint = extractFingerprint(currentSlice);
  const newDrift =
    entry.contentFingerprint && entry.contentFingerprint.length > 0
      ? computeContentDrift(entry.contentFingerprint, currentFingerprint)
      : entry.contentDrift;

  const driftChanged = newDrift !== entry.contentDrift;
  const fingerprintChanged =
    JSON.stringify(currentFingerprint) !== JSON.stringify(entry.contentFingerprint ?? []);

  if ((changed || driftChanged || fingerprintChanged) && !dryRun) {
    const updatedEntry: ContextEntry = {
      ...entry,
      lineRange: mappingResult.updatedLineRange,
      confidence: finalConfidence,
      status: finalStatus,
      reviewRequired: finalReviewRequired,
      updatedAt: new Date().toISOString(),
      contentFingerprint: currentFingerprint,
      ...(newDrift ? { contentDrift: newDrift } : {}),
    };
    await writeContextEntry(repoRoot, updatedEntry);
  }

  return decision;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Incrementally heal context entries for a batch of watcher change events.
 *
 * Processing strategy:
 *   1. Build a normalised map of relative-path → event from `changes`, keeping
 *      the latest event when the same file appears more than once.
 *   2. Load the repository index and skip any entry whose file is not in the
 *      change set.
 *   3. **Delete events** → immediately orphan all entries for that file without
 *      running the mapping engine (no content to map against).
 *   4. **Create / modify events** → read file content, compute a diff signal
 *      against HEAD, run the multi-layer mapping engine, apply diff-signal
 *      confidence adjustments, and persist changes.
 *   5. **Rename events** (`renameFrom` set on a create event) → update each
 *      affected entry's `filePath` to the new location as part of mapping.
 *
 * All file reads and diff-signal computations are cached per-file within a
 * single `heal()` call.  Pass a persistent `contentCache` in `opts` to share
 * the cache across consecutive calls.
 *
 * When `opts.collectDecisions` is `true`, each processed entry (including
 * delete-orphaned ones) contributes exactly one `MappingDecision` to
 * `HealResult.decisions`.  This is the structured, programmatic alternative
 * to parsing `debug` stderr output.
 *
 * @param changes - Coalesced change events from the watcher
 * @param opts    - Engine options (repoRoot required; all others optional)
 * @returns       Aggregate counts: updated, orphaned, uncertain; plus optional decisions array
 */
export async function heal(
  changes: ChangeEvent[],
  opts: HealEngineOptions,
): Promise<HealResult> {
  const {
    repoRoot,
    debug = false,
    dryRun = false,
    collectDecisions = false,
    config,
    contentCache = new Map<string, string>(),
  } = opts;

  const aiConfidenceCap = config?.heal.ai_confidence_cap ?? 0.6;
  const rewriteConfidenceFactor = config?.heal.rewrite_confidence_factor ?? 0.85;

  // ── 1. Normalise change events to relative POSIX paths ─────────────────────

  const changeMap = new Map<string, ChangeEvent>();
  for (const event of changes) {
    const rel = toRelPath(event.filePath, repoRoot);
    const existing = changeMap.get(rel);
    // Keep the event with the latest timestamp when a file appears twice
    if (!existing || event.timestamp > existing.timestamp) {
      changeMap.set(rel, { ...event, filePath: rel });
    }
  }

  if (changeMap.size === 0) {
    const empty: HealResult = { updated: 0, orphaned: 0, uncertain: 0 };
    if (collectDecisions) empty.decisions = [];
    return empty;
  }

  // Build rename lookup: old relative path → new relative path
  const renamedFrom = new Map<string, string>(); // oldPath → newPath
  for (const [newPath, ev] of changeMap) {
    if (ev.renameFrom) {
      const oldPath = toRelPath(ev.renameFrom, repoRoot);
      renamedFrom.set(oldPath, newPath);
    }
  }

  // Full set of relative paths that have any activity this batch
  const activePaths = new Set([...changeMap.keys(), ...renamedFrom.keys()]);

  if (debug) {
    debugWrite(`Batch: ${changeMap.size} event(s), ${activePaths.size} affected path(s)`);
    for (const [rel, ev] of changeMap) {
      const rename = ev.renameFrom ? ` (renamed from ${toRelPath(ev.renameFrom, repoRoot)})` : "";
      debugWrite(`  ${ev.changeType.padEnd(8)} ${rel}${rename}`);
    }
  }

  // ── 2. Load index and filter entries to active paths ───────────────────────

  const index = await readIndex(repoRoot);

  // Diff-signal cache: one lookup per file path per heal() call
  const signalCache = new Map<string, DiffSignal>();

  let updated = 0;
  let orphaned = 0;
  let uncertain = 0;
  const decisions: MappingDecision[] = [];

  // Gap 74 — accumulate per-file mapping results so we can write one MappingFile
  // per source file after the loop, matching what runHeal does for full heals.
  const mappingAccumulator = new Map<string, MappingFile["mappings"]>();

  type PendingAuditEvent = {
    entryId: string;
    filePath: string;
    diffSignal?: string;
    fromStatus: string;
    toStatus: string;
    confidence: number;
  };
  const pendingAudit: PendingAuditEvent[] = [];

  // ── 3–5. Process each indexed entry ────────────────────────────────────────

  for (const id of index.entries) {
    let entry: ContextEntry;
    try {
      entry = await readContextEntry(repoRoot, id);
    } catch {
      // Unreadable entry — skip; do not count against any bucket
      continue;
    }

    const entryPath = entry.filePath.replace(/\\/g, "/");

    // Determine which event (if any) applies to this entry
    const directEvent = changeMap.get(entryPath);
    const renamedToPath = renamedFrom.get(entryPath);
    const event = directEvent ?? (renamedToPath ? changeMap.get(renamedToPath) : undefined);

    if (!event) continue; // Entry's file not in this batch — skip

    const changeType = event.changeType;

    // ── 3. Delete: orphan immediately ──────────────────────────────────────

    if (changeType === "delete") {
      if (debug) {
        debugWrite(
          `[orphaned  ] ${id.slice(0, 8)} ${entryPath}` +
          `  L${entry.lineRange.start}-${entry.lineRange.end}` +
          `  reason: file deleted`,
        );
      }
      if (collectDecisions) {
        decisions.push(buildDeleteDecision(entry, entryPath));
      }
      orphaned++;
      await orphanEntry(repoRoot, entry, dryRun);
      if (!dryRun) {
        pendingAudit.push({
          entryId: id,
          filePath: entryPath,
          fromStatus: entry.status,
          toStatus: "orphaned",
          confidence: 0,
        });
      }
      continue;
    }

    // ── 4–5. Create / Modify / Rename: run mapping engine ──────────────────

    // For renames, map against the new file path
    const effectivePath = renamedToPath ?? entryPath;
    const entryToMap: ContextEntry = renamedToPath
      ? { ...entry, filePath: effectivePath }
      : entry;

    // Load file content (cached)
    if (!contentCache.has(effectivePath)) {
      let content = "";
      try {
        content = await fs.readFile(path.resolve(repoRoot, effectivePath), "utf-8");
      } catch {
        // File unreadable (permission error, race with deletion, etc.) — treat as empty
        content = "";
      }
      contentCache.set(effectivePath, content);
    }
    const fileContent = contentCache.get(effectivePath)!;

    // Compute diff signal (cached per effective path per call)
    if (!signalCache.has(effectivePath)) {
      const signal = await classifyFileDiff(repoRoot, effectivePath, fileContent);
      signalCache.set(effectivePath, signal);
    }
    const diffSignal = signalCache.get(effectivePath)!;

    // Run the mapping engine and persist
    const decision = await processEntry(
      repoRoot,
      entryToMap,
      fileContent,
      changeType,
      diffSignal,
      aiConfidenceCap,
      rewriteConfidenceFactor,
      dryRun,
      renamedToPath ? entryPath : undefined,
    );

    if (debug) emitDecision(decision);
    if (collectDecisions) decisions.push(decision);

    // Gap 74 — accumulate the resolved mapping for this entry so we can write
    // a MappingFile per source file after the loop.
    {
      const existingMappings = mappingAccumulator.get(decision.filePath) ?? [];
      existingMappings.push({
        entryId: decision.entryId,
        lineRange: decision.after.lineRange,
        confidence: decision.after.confidence,
        status: decision.after.status as MappingFile["mappings"][number]["status"],
      });
      mappingAccumulator.set(decision.filePath, existingMappings);
    }

    if (!dryRun) {
      const entryChanged =
        decision.before.status !== decision.after.status ||
        Math.abs(decision.before.confidence - decision.after.confidence) > 0.001 ||
        decision.before.lineRange.start !== decision.after.lineRange.start ||
        decision.before.lineRange.end !== decision.after.lineRange.end;
      if (entryChanged) {
        pendingAudit.push({
          entryId: decision.entryId,
          filePath: decision.filePath,
          diffSignal: decision.diffSignal,
          fromStatus: decision.before.status,
          toStatus: decision.after.status,
          confidence: decision.after.confidence,
        });
      }
    }

    // Tally by final status
    switch (decision.after.status) {
      case "mapped":
        updated++;
        break;
      case "uncertain":
        uncertain++;
        break;
      default:
        orphaned++;
        break;
    }
  }

  // Gap 74 — flush accumulated mapping results to disk now that every entry
  // for the active files has been processed.  Skipped in dry-run mode.
  if (!dryRun) {
    await Promise.all(
      Array.from(mappingAccumulator.entries()).map(([filePath, mappings]) =>
        writeMappingFile(repoRoot, {
          schemaVersion: SCHEMA_VERSION,
          filePathHash: hashFilePath(filePath),
          updatedAt: new Date().toISOString(),
          mappings,
        }),
      ),
    );
  }

  if (debug) {
    debugWrite(
      `Done — updated=${updated} uncertain=${uncertain} orphaned=${orphaned}` +
      (dryRun ? " [DRY RUN — no changes written]" : ""),
    );
  }

  if (!dryRun && pendingAudit.length > 0) {
    try {
      const healLicense = await loadLicense(repoRoot);
      const healOrgId = healLicense?.orgId;
      if (healOrgId) {
        const healActor = process.env["KODELA_AUTHOR"] ?? process.env["GIT_AUTHOR_NAME"] ?? "unknown";
        for (const event of pendingAudit) {
          void recordCliEvent(
            {
              eventType: "context_updated",
              actor: healActor,
              orgId: healOrgId,
              filePath: event.filePath,
              entryId: event.entryId,
              metadata: {
                diffSignal: event.diffSignal,
                fromStatus: event.fromStatus,
                toStatus: event.toStatus,
                confidence: event.confidence,
              },
            },
            repoRoot,
          );
        }
      }
    } catch {
      // non-fatal — audit recording failure never blocks the heal engine
    }
  }

  const result: HealResult = { updated, orphaned, uncertain };
  if (collectDecisions) result.decisions = decisions;
  return result;
}
