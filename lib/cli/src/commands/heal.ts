// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readIndex, readContextEntry, writeContextEntry, mapContextEntry, loadLicense, extractFingerprint, computeContentDrift, writeMappingFile, hashFilePath, SCHEMA_VERSION } from "@kodela/core";
import type { ContextEntry, MappingFile } from "@kodela/core";
import type { Severity } from "@kodela/core";
import { recordCliEvent } from "../audit/recordCliEvent.js";
import { isSensitivePath } from "../security/sensitive-paths.js";
import { computeDiff, isLikelyAIChange, isPossibleRewrite } from "@kodela/diff";
import type { KodelaConfig } from "../config/schema.js";
import { drainExtractionQueue } from "../hooks/queue.js";
import type { AiLayerConfig } from "./ai-layer.js";
import { runEmbed } from "./embed.js";

const execFileAsync = promisify(execFile);

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

export type HealOptions = {
  dryRun?: boolean;
  repoRoot: string;
  /**
   * When provided, only heal context entries whose `filePath` matches one of
   * these relative paths. All other entries are skipped. Omit to heal all entries.
   */
  filePaths?: string[];
  /**
   * Loaded kodela config. When provided, `heal.ai_confidence_cap` and
   * `heal.rewrite_confidence_factor` override the built-in defaults (0.6 / 0.85).
   */
  config?: KodelaConfig;
  /**
   * doc 22 (a) — after healing, refresh the semantic embedding index so it stays
   * fresh unattended (heal runs post-commit). Incremental: only new/changed notes
   * are embedded. Default true; pass false (or `kodela heal --no-embed`) to skip.
   */
  embed?: boolean;
};

/**
 * Classification of the magnitude of change detected for a file via the diff engine.
 *
 * - `"likely-ai"`       — large insertion + high change density or low similarity;
 *                         full re-annotation is triggered (confidence capped, reviewRequired set).
 * - `"possible-rewrite"` — high change density without all AI signals; moderate confidence penalty.
 * - `"minimal"`         — few changed lines; standard heal behaviour with no adjustment.
 * - `"none"`            — no baseline content was available (new file or git unavailable).
 */
export type DiffSignal = "likely-ai" | "possible-rewrite" | "minimal" | "none";

export type HealEntry = {
  id: string;
  filePath: string;
  /**
   * Set when a cross-file move is detected: the new relative path where the
   * annotation's code was found after a git rename. When present, heal persists
   * this as the entry's new `filePath`.
   */
  newFilePath?: string;
  before: { lineRange: ContextEntry["lineRange"]; status: ContextEntry["status"]; confidence: number };
  after: { lineRange: ContextEntry["lineRange"]; status: ContextEntry["status"]; confidence: number };
  changed: boolean;
  /** Diff-engine classification for the file this entry belongs to. */
  diffSignal: DiffSignal;
  /**
   * Per-component scores from the mapping layer, when available.
   * Present only when the winning layer computes token and positional
   * scores separately (e.g. the token-hash window-scoring path).
   */
  scoreBreakdown?: { token: number; position: number };
};

export type HealResult = {
  total: number;
  healed: number;
  unchanged: number;
  failed: number;
  entries: HealEntry[];
  dryRun: boolean;
  /** doc 22 (a) — how many annotations were (re)embedded this run, when embed ran. */
  embedded?: number;
};

/**
 * Attempt to read the committed (HEAD) version of a file from git.
 * Returns `null` when git is unavailable or the file has no committed version.
 */
async function getGitBaseContent(repoRoot: string, relPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["show", `HEAD:${relPath}`], {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Parse `git diff --name-status` / `git log --name-status` output looking for a
 * rename line whose source path equals `oldPath`.  Lines have the form:
 *   R<score>\t<old-path>\t<new-path>
 * Returns the new path when found, otherwise `null`.
 */
export function parseRenameNameStatus(output: string, oldPath: string): string | null {
  for (const line of output.split("\n")) {
    const parts = line.split("\t");
    if (parts.length === 3 && parts[0].startsWith("R")) {
      const from = parts[1].trim();
      const to = parts[2].trim();
      if (from === oldPath) return to;
    }
  }
  return null;
}

/**
 * Attempt to find a git rename that moved `oldPath` to a new location.
 * Three-pass check: staged renames, unstaged working-tree renames, then full git
 * history.  Returns the new relative path when a match is found, or `null` when
 * git is unavailable, the file was not renamed, or the repo has no commits.
 */
async function detectGitRename(repoRoot: string, oldPath: string): Promise<string | null> {
  // 1. Check staged renames (files renamed and `git add`-ed, not yet committed).
  try {
    const { stdout: staged } = await execFileAsync(
      "git",
      ["diff", "--cached", "--name-status", "--diff-filter=R"],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    const result = parseRenameNameStatus(staged, oldPath);
    if (result !== null) return result;
  } catch {
    // git unavailable or no staged changes — fall through
  }

  // 2. Check renames visible to git in the working tree relative to HEAD
  //    (covers partial-stage workflows where some files are staged and others
  //    are not, but both old and new names are git-tracked).
  //    Note: a pure `mv` without any staging makes the new file untracked so
  //    git cannot detect it as a rename here; that case is handled by step 3
  //    when the rename was eventually committed.
  try {
    const { stdout: unstaged } = await execFileAsync(
      "git",
      ["diff", "HEAD", "--name-status", "--diff-filter=R"],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    const result = parseRenameNameStatus(unstaged, oldPath);
    if (result !== null) return result;
  } catch {
    // fall through
  }

  // 3. Search git history for any commit that renamed `oldPath`.
  // No -1 limit: there may be newer unrelated renames that would shadow the one
  // we care about if we stopped at the first matching commit.  No path filter:
  // the `-- <path>` form causes git to classify a renamed file as "deleted",
  // which defeats `--diff-filter=R`.
  try {
    const { stdout: committed } = await execFileAsync(
      "git",
      ["log", "--diff-filter=R", "--name-status", "--format=", "HEAD"],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    return parseRenameNameStatus(committed, oldPath);
  } catch {
    return null;
  }
}

/**
 * Compute the diff signal for a single file by comparing its git-committed content
 * against the current on-disk content. Returns `"none"` when a baseline cannot be
 * obtained (e.g. new file, git not available).
 */
async function classifyFileDiff(
  repoRoot: string,
  relPath: string,
  currentContent: string,
): Promise<DiffSignal> {
  const oldContent = await getGitBaseContent(repoRoot, relPath);
  if (oldContent === null) {
    return "none";
  }

  const diffResult = computeDiff({ oldContent, newContent: currentContent });

  if (isLikelyAIChange(diffResult)) {
    return "likely-ai";
  }
  if (isPossibleRewrite(diffResult)) {
    return "possible-rewrite";
  }
  return "minimal";
}

/**
 * Apply confidence and reviewRequired adjustments based on the diff signal.
 *
 * - `likely-ai`        → confidence capped at `aiConfidenceCap` (default 0.6), reviewRequired forced true.
 * - `possible-rewrite` → confidence multiplied by `rewriteConfidenceFactor` (default 0.85), reviewRequired forced true.
 * - `minimal` / `none` → no adjustment.
 */
export function applyDiffSignal(
  signal: DiffSignal,
  confidence: number,
  reviewRequired: boolean,
  aiConfidenceCap = 0.6,
  rewriteConfidenceFactor = 0.85,
): { confidence: number; reviewRequired: boolean } {
  switch (signal) {
    case "likely-ai":
      return { confidence: Math.min(confidence, aiConfidenceCap), reviewRequired: true };
    case "possible-rewrite":
      return { confidence: confidence * rewriteConfidenceFactor, reviewRequired: true };
    default:
      return { confidence, reviewRequired };
  }
}

export async function runHeal(opts: HealOptions): Promise<HealResult> {
  const { repoRoot, dryRun = false, filePaths, config, embed = true } = opts;
  const aiConfidenceCap = config?.heal.ai_confidence_cap ?? 0.6;
  const rewriteConfidenceFactor = config?.heal.rewrite_confidence_factor ?? 0.85;
  const filePathSet = filePaths ? new Set(filePaths) : null;

  const index = await readIndex(repoRoot);
  const healEntries: HealEntry[] = [];
  let failed = 0;

  // Gap 74 — accumulate per-file mapping results so we can write one MappingFile
  // per source file after the heal loop completes.
  const mappingAccumulator = new Map<string, MappingFile["mappings"]>();

  // Pre-compute per-file content and diff signals for all files that will be healed.
  // Grouping avoids redundant git calls and file reads when multiple entries share a file.
  const fileContentCache = new Map<string, string>();
  const fileMissingCache = new Map<string, boolean>();
  const fileDiffSignalCache = new Map<string, DiffSignal>();

  async function getFileData(
    relPath: string,
  ): Promise<{ content: string; signal: DiffSignal; missing: boolean }> {
    if (!fileContentCache.has(relPath)) {
      let content = "";
      let missing = false;
      try {
        content = await fs.readFile(path.resolve(repoRoot, relPath), "utf-8");
      } catch (err) {
        content = "";
        missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      }
      fileContentCache.set(relPath, content);
      fileMissingCache.set(relPath, missing);

      const signal = await classifyFileDiff(repoRoot, relPath, content);
      fileDiffSignalCache.set(relPath, signal);
    }
    return {
      content: fileContentCache.get(relPath)!,
      signal: fileDiffSignalCache.get(relPath)!,
      missing: fileMissingCache.get(relPath) ?? false,
    };
  }

  for (const id of index.entries) {
    let entry: ContextEntry;
    try {
      entry = await readContextEntry(repoRoot, id);
    } catch {
      if (!filePathSet) {
        failed++;
      }
      continue;
    }

    if (filePathSet && !filePathSet.has(entry.filePath)) {
      continue;
    }

    const { content: fileContent, signal: diffSignal, missing: fileMissing } = await getFileData(entry.filePath);

    // Cross-file move detection: when the stored file is missing (ENOENT), check
    // whether git recorded a rename and, if so, remap the entry against the new
    // file.  Empty files are intentionally excluded — an empty file exists and
    // there is nothing to remap.
    let newFilePath: string | undefined;
    let contentForMapping = fileContent;

    if (fileMissing) {
      const detectedNewPath = await detectGitRename(repoRoot, entry.filePath);
      if (detectedNewPath !== null) {
        try {
          contentForMapping = await fs.readFile(
            path.resolve(repoRoot, detectedNewPath),
            "utf-8",
          );
          newFilePath = detectedNewPath;
        } catch {
          // New file also unreadable — treat as ordinary orphan.
        }
      }
    }

    let mappingResult;
    try {
      mappingResult = await mapContextEntry(entry, contentForMapping, repoRoot);
    } catch {
      failed++;
      continue;
    }

    // Apply diff-signal adjustments to the mapping result's confidence and reviewRequired.
    const adjusted = applyDiffSignal(
      diffSignal,
      mappingResult.confidence,
      entry.reviewRequired,
      aiConfidenceCap,
      rewriteConfidenceFactor,
    );
    const finalConfidence = adjusted.confidence;
    const finalReviewRequired = adjusted.reviewRequired;

    const changed =
      mappingResult.updatedLineRange.start !== entry.lineRange.start ||
      mappingResult.updatedLineRange.end !== entry.lineRange.end ||
      mappingResult.status !== entry.status ||
      Math.abs(finalConfidence - entry.confidence) > 0.001 ||
      finalReviewRequired !== entry.reviewRequired ||
      newFilePath !== undefined;

    healEntries.push({
      id,
      filePath: entry.filePath,
      newFilePath,
      before: {
        lineRange: entry.lineRange,
        status: entry.status,
        confidence: entry.confidence,
      },
      after: {
        lineRange: mappingResult.updatedLineRange,
        status: mappingResult.status,
        confidence: finalConfidence,
      },
      changed,
      diffSignal,
      scoreBreakdown: mappingResult.scoreBreakdown,
    });

    // Gap 74 — accumulate this entry's resolved mapping so we can persist a
    // MappingFile for its source file once the full heal loop is done.
    const effectiveMappingPath = newFilePath ?? entry.filePath;
    const existingMappings = mappingAccumulator.get(effectiveMappingPath) ?? [];
    existingMappings.push({
      entryId: id,
      lineRange: mappingResult.updatedLineRange,
      confidence: finalConfidence,
      status: mappingResult.status,
    });
    mappingAccumulator.set(effectiveMappingPath, existingMappings);

    // Gap 48 — recompute content fingerprint and drift on heal.
    const healRange = mappingResult.updatedLineRange;
    const healLines = fileContent.split("\n");
    const healSlice = healLines.slice(healRange.start - 1, healRange.end).join("\n");
    const currentFingerprint = extractFingerprint(healSlice);
    const newDrift =
      entry.contentFingerprint && entry.contentFingerprint.length > 0
        ? computeContentDrift(entry.contentFingerprint, currentFingerprint)
        : entry.contentDrift;
    const driftChanged = newDrift !== entry.contentDrift;
    const fingerprintChanged =
      JSON.stringify(currentFingerprint) !== JSON.stringify(entry.contentFingerprint ?? []);

    if ((changed || driftChanged || fingerprintChanged) && !dryRun) {
      const sensitivePaths = config?.security.sensitive_paths ?? [];
      const effectivePath = newFilePath ?? entry.filePath;
      const reClassifiedSeverity =
        sensitivePaths.length > 0 && isSensitivePath(effectivePath, sensitivePaths)
          ? maxSeverity(entry.severity, "high")
          : entry.severity;

      const updatedEntry: ContextEntry = {
        ...entry,
        lineRange: mappingResult.updatedLineRange,
        confidence: finalConfidence,
        status: mappingResult.status,
        reviewRequired: finalReviewRequired,
        severity: reClassifiedSeverity,
        updatedAt: new Date().toISOString(),
        ...(newFilePath !== undefined ? { filePath: newFilePath } : {}),
        contentFingerprint: currentFingerprint,
        ...(newDrift ? { contentDrift: newDrift } : {}),
      };
      await writeContextEntry(repoRoot, updatedEntry);

      const healLicense = await loadLicense(repoRoot);
      const healOrgId = healLicense?.orgId;
      if (healOrgId) {
        const healActor = process.env["KODELA_AUTHOR"] ?? process.env["GIT_AUTHOR_NAME"] ?? "unknown";
        void recordCliEvent(
          {
            eventType: "context_updated",
            actor: healActor,
            orgId: healOrgId,
            filePath: newFilePath ?? entry.filePath,
            entryId: id,
            metadata: {
              diffSignal,
              status: mappingResult.status,
              confidence: finalConfidence,
              ...(newFilePath ? { movedFrom: entry.filePath } : {}),
            },
          },
          repoRoot,
        );
      }
    }
  }

  // Gap 74 — write one MappingFile per affected source file so the MCP server
  // and other consumers can read resolved line ranges without re-running heal.
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

    // Gap 79 — drain the extraction queue so watcher-created and retroactive
    // entries get their notes upgraded via AI intent inference.  Heal runs
    // after every commit (via the post-commit hook from Gap 78) and on-demand,
    // making it the natural drain point for offline inference.  A higher drain
    // limit (10 vs the hook default of 3) is used because heal is called less
    // frequently and can afford to process more entries per run.
    const aiApiKey = config?.ai_provider?.api_key ?? process.env["KODELA_AI_API_KEY"] ?? "";
    const healAiConfig: AiLayerConfig | undefined = aiApiKey
      ? {
          provider: config?.ai_provider?.provider as AiLayerConfig["provider"],
          model: config?.ai_provider?.model,
          apiKey: aiApiKey,
          baseUrl: config?.ai_provider?.base_url,
        }
      : undefined;
    await drainExtractionQueue(repoRoot, healAiConfig, 10).catch(() => {});
  }

  const healed = healEntries.filter((e) => e.changed).length;
  const unchanged = healEntries.filter((e) => !e.changed).length;

  const total = filePathSet
    ? healEntries.length + failed
    : index.entries.length;

  // doc 22 (a) — keep the semantic index fresh unattended. heal runs post-commit,
  // so this picks up entries the watcher auto-annotated since the last embed.
  // Incremental (skips unchanged notes) and best-effort (never fails the heal).
  let embedded: number | undefined;
  if (embed && !dryRun) {
    try {
      const r = await runEmbed({ repoRoot });
      embedded = r.embedded;
    } catch {
      // non-fatal — search still works on whatever embeddings already exist.
    }
  }

  return {
    total,
    healed,
    unchanged,
    failed,
    entries: healEntries,
    dryRun,
    ...(embedded !== undefined ? { embedded } : {}),
  };
}

/**
 * Format a `HealResult` as a human-readable string.
 *
 * @param result  The result returned by `runHeal`.
 * @param verbose When `true`, prints the per-component token and position
 *                scores alongside the confidence percentage for each updated
 *                entry.  Useful for diagnosing why an annotation drifted or
 *                was marked uncertain.  Corresponds to `--verbose` / `--debug`
 *                CLI flags.
 */
export function formatHealResult(result: HealResult, verbose = false): string {
  const prefix = result.dryRun ? "[DRY RUN] " : "";
  const lines = [
    `${prefix}Heal complete: ${result.healed} updated, ${result.unchanged} unchanged, ${result.failed} failed (of ${result.total} total)`,
  ];

  const changed = result.entries.filter((e) => e.changed);
  if (changed.length > 0) {
    lines.push("");
    lines.push("Updated entries:");
    for (const e of changed) {
      const before = `${e.before.lineRange.start}-${e.before.lineRange.end} [${e.before.status} | ${(e.before.confidence * 100).toFixed(0)}%]`;
      const after = `${e.after.lineRange.start}-${e.after.lineRange.end} [${e.after.status} | ${(e.after.confidence * 100).toFixed(0)}%]`;
      const signal = e.diffSignal !== "none" && e.diffSignal !== "minimal" ? ` (${e.diffSignal})` : "";
      const pathLabel = e.newFilePath ? `${e.filePath} → ${e.newFilePath}` : e.filePath;
      const moveNote = e.newFilePath ? " (file moved)" : "";
      lines.push(`  ${pathLabel}: ${before} → ${after}${signal}${moveNote}`);
      if (verbose && e.scoreBreakdown !== undefined) {
        const tok = (e.scoreBreakdown.token * 100).toFixed(1);
        const pos = (e.scoreBreakdown.position * 100).toFixed(1);
        lines.push(`    score breakdown: token=${tok}% position=${pos}%`);
      }
    }
  }

  return lines.join("\n");
}
