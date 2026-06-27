// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 58 Phase B — `kodela detect-ai-change`
 *
 * Standalone command that reads a unified diff (from a patch file or from
 * `git diff --cached` / `git diff HEAD`) and runs the UBA scorer against
 * each changed file to determine whether the change is likely AI-generated.
 *
 * Useful in git hooks, CI scripts, and pre-commit checks where `kodela watch`
 * is not running.  Outputs per-file results with the UBA signal breakdown and
 * whether a covering ContextEntry exists.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ubaScore, readIndex, readContextEntry, writeContextEntry, SCHEMA_VERSION, hashTokenStream } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetectAiChangeOptions = {
  repoRoot: string;
  /** Absolute path to a unified diff patch file. Mutually exclusive with staged/all. */
  diffFile?: string;
  /** Use git diff --cached (staged changes). */
  staged?: boolean;
  /** Exit 1 when at least one likely-AI file has no covering ContextEntry. */
  exitCode?: boolean;
  /** Output JSON instead of human-readable text. */
  json?: boolean;
};

export type DetectedFile = {
  /** Relative file path (forward-slash). */
  file: string;
  /** Net lines changed (|added − removed|). */
  linesChanged: number;
  /** Added lines only. */
  linesAdded: number;
  /** Removed lines only. */
  linesRemoved: number;
  /** UBA classification score (0–1). */
  ubaScore: number;
  /** Whether the change is classified as likely AI-generated (score ≥ uba_threshold). */
  likelyAi: boolean;
  /** Whether an existing ContextEntry covers this file. */
  hasCoveringEntry: boolean;
  /** Per-signal UBA breakdown. */
  signals: Record<string, number>;
};

export type DetectAiChangeResult = {
  files: DetectedFile[];
  /** True when at least one file is classified as likely AI-generated. */
  anyLikelyAi: boolean;
  /**
   * True when at least one likely-AI file has no covering ContextEntry.
   * This is the condition that triggers an exit 1 when --exit-code is set.
   */
  anyUncovered: boolean;
  /** Source of the diff that was analysed. */
  diffSource: "file" | "staged" | "working-tree";
};

// ---------------------------------------------------------------------------
// Unified diff parser
// ---------------------------------------------------------------------------

type ParsedFileDiff = {
  file: string;
  linesAdded: number;
  linesRemoved: number;
  maxHunkAddedLines: number;
};

/**
 * Parse a unified diff string and return per-file change statistics.
 * Handles both `git diff` and plain `diff -u` output.
 */
export function parseUnifiedDiff(diff: string): ParsedFileDiff[] {
  const results: ParsedFileDiff[] = [];
  let current: ParsedFileDiff | null = null;
  let currentHunkAdded = 0;
  let inHunk = false;

  for (const rawLine of diff.split("\n")) {
    // New file section — flush current, start new
    if (rawLine.startsWith("+++ ")) {
      if (current) {
        if (inHunk) {
          current.maxHunkAddedLines = Math.max(current.maxHunkAddedLines, currentHunkAdded);
        }
        results.push(current);
      }
      // Strip leading "b/" prefix from git diff format
      let filePath = rawLine.slice(4);
      if (filePath.startsWith("b/")) filePath = filePath.slice(2);
      // Skip /dev/null (file deletions)
      if (filePath === "/dev/null") {
        current = null;
      } else {
        current = { file: filePath, linesAdded: 0, linesRemoved: 0, maxHunkAddedLines: 0 };
      }
      inHunk = false;
      currentHunkAdded = 0;
      continue;
    }

    if (current === null) continue;

    if (rawLine.startsWith("@@ ")) {
      // New hunk — record max for previous hunk
      if (inHunk) {
        current.maxHunkAddedLines = Math.max(current.maxHunkAddedLines, currentHunkAdded);
      }
      inHunk = true;
      currentHunkAdded = 0;
      continue;
    }

    if (!inHunk) continue;

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      current.linesAdded++;
      currentHunkAdded++;
    } else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      current.linesRemoved++;
      // Reset hunk counter on removed lines (contiguous block tracking)
      currentHunkAdded = 0;
    } else {
      // Context line — reset contiguous counter
      currentHunkAdded = 0;
    }
  }

  // Flush last file
  if (current) {
    if (inHunk) {
      current.maxHunkAddedLines = Math.max(current.maxHunkAddedLines, currentHunkAdded);
    }
    results.push(current);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Coverage check
// ---------------------------------------------------------------------------

/**
 * Return true if any ContextEntry in the index covers the given relative
 * file path.  Uses a simple filePath equality check — does not validate
 * line ranges (a gap-level check is beyond the scope of this command).
 */
async function hasCoveringEntry(repoRoot: string, relPath: string): Promise<boolean> {
  try {
    const index = await readIndex(repoRoot);
    const entries = await Promise.all(
      index.entries.map((id) => readContextEntry(repoRoot, id).catch(() => null)),
    );
    return entries.some((e) => e !== null && e.filePath === relPath);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Diff acquisition
// ---------------------------------------------------------------------------

async function getDiffText(opts: DetectAiChangeOptions): Promise<{ text: string; source: DetectAiChangeResult["diffSource"] }> {
  if (opts.diffFile) {
    const text = await fs.readFile(opts.diffFile, "utf-8");
    return { text, source: "file" };
  }

  if (opts.staged) {
    try {
      const { stdout } = await execFileAsync("git", ["diff", "--cached", "-U0"], {
        cwd: opts.repoRoot,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { text: stdout, source: "staged" };
    } catch {
      return { text: "", source: "staged" };
    }
  }

  // Default: working-tree diff against HEAD
  try {
    const { stdout } = await execFileAsync("git", ["diff", "HEAD", "-U0"], {
      cwd: opts.repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { text: stdout, source: "working-tree" };
  } catch {
    return { text: "", source: "working-tree" };
  }
}

// ---------------------------------------------------------------------------
// Main command runner
// ---------------------------------------------------------------------------

export async function runDetectAiChange(
  opts: DetectAiChangeOptions,
  ubaThreshold = 0.6,
): Promise<DetectAiChangeResult> {
  const { text: diffText, source: diffSource } = await getDiffText(opts);

  if (!diffText.trim()) {
    return { files: [], anyLikelyAi: false, anyUncovered: false, diffSource };
  }

  const parsedFiles = parseUnifiedDiff(diffText);
  const totalFiles = parsedFiles.length;

  const detectedFiles: DetectedFile[] = await Promise.all(
    parsedFiles.map(async (pf) => {
      const linesChanged = pf.linesAdded + pf.linesRemoved;
      const hasLargeContiguousBlock = pf.maxHunkAddedLines >= 20;

      const result = ubaScore({
        linesAdded: pf.linesAdded,
        writeEventCount: 1,
        isSingleBatch: true,
        interBatchGapMs: undefined,
        fileCount: totalFiles,
        hasLargeContiguousBlock,
        hasKnownEnvSignal: false,
        isExplicitAgentSignal: false,
      });

      const likelyAi = result.classificationScore >= ubaThreshold;
      const covering = likelyAi
        ? await hasCoveringEntry(opts.repoRoot, pf.file)
        : true;

      return {
        file: pf.file,
        linesChanged,
        linesAdded: pf.linesAdded,
        linesRemoved: pf.linesRemoved,
        ubaScore: result.classificationScore,
        likelyAi,
        hasCoveringEntry: covering,
        signals: result.classificationSignals,
      };
    }),
  );

  const anyLikelyAi = detectedFiles.some((f) => f.likelyAi);
  const anyUncovered = detectedFiles.some((f) => f.likelyAi && !f.hasCoveringEntry);

  return { files: detectedFiles, anyLikelyAi, anyUncovered, diffSource };
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

export function formatDetectAiChangeResult(result: DetectAiChangeResult): string {
  if (result.files.length === 0) {
    return `[detect-ai-change] No changes found in ${result.diffSource} diff.`;
  }

  const lines: string[] = [];
  const sourceLabel = result.diffSource === "staged"
    ? "staged changes"
    : result.diffSource === "file"
    ? "diff file"
    : "working-tree changes";

  lines.push(`[detect-ai-change] Analysed ${result.files.length} file(s) from ${sourceLabel}:`);
  lines.push("");

  for (const f of result.files) {
    const aiLabel = f.likelyAi ? "AI-likely" : "human";
    const scoreStr = f.ubaScore.toFixed(2);
    const covLabel = f.likelyAi
      ? f.hasCoveringEntry
        ? "annotated"
        : "NO ANNOTATION"
      : "";
    const covPart = covLabel ? ` [${covLabel}]` : "";
    lines.push(`  ${f.likelyAi ? "⚠" : "·"} ${f.file}`);
    lines.push(
      `    ${aiLabel} · score=${scoreStr} · +${f.linesAdded}/-${f.linesRemoved} lines${covPart}`,
    );
    if (f.likelyAi) {
      const sigParts = Object.entries(f.signals)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join(" ");
      lines.push(`    signals: ${sigParts}`);
    }
  }

  if (result.anyUncovered) {
    lines.push("");
    lines.push(
      "WARNING: Likely AI-generated changes found without Kodela annotations.",
    );
    lines.push(
      "  Run `kodela add` to annotate or `kodela hook process` to capture automatically.",
    );
  } else if (result.anyLikelyAi) {
    lines.push("");
    lines.push("All likely AI-generated changes have Kodela annotations. ✓");
  }

  return lines.join("\n");
}

export function formatDetectAiChangeResultJson(result: DetectAiChangeResult): string {
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Detection entry creation (called from watch spike detection)
// ---------------------------------------------------------------------------

/**
 * Create a minimal ContextEntry for a file detected as AI-generated by the
 * spike detector.  Used by the watch interactive prompt and the detect-ai-change
 * command when the user confirms the change.
 */
export async function createDetectionEntry(
  repoRoot: string,
  relPath: string,
  note: string,
  ubaClassificationScore: number,
  ubaSignals: Record<string, number>,
): Promise<void> {
  let lineCount = 1;
  try {
    const content = await fs.readFile(path.join(repoRoot, relPath), "utf-8");
    lineCount = content.split("\n").length;
    const now = new Date().toISOString();
    const author =
      process.env["KODELA_AUTHOR"] ??
      process.env["GIT_AUTHOR_NAME"] ??
      "unknown";
    const contentHash = hashTokenStream(content);
    const entry: ContextEntry = {
      schemaVersion: SCHEMA_VERSION,
      id: crypto.randomUUID(),
      filePath: relPath,
      astAnchor: null,
      contentHash,
      lineRange: { start: 1, end: lineCount },
      note: note || "(AI-generated, detected by spike detector)",
      author,
      createdAt: now,
      updatedAt: now,
      severity: "low",
      tags: ["auto-detected"],
      source: "ai",
      confidence: ubaClassificationScore,
      attributionConfidence: 0,
      canUpgradeAttribution: true,
      classificationScore: ubaClassificationScore,
      classificationSignals: ubaSignals,
      status: "uncertain",
      reviewRequired: true,
    };
    await writeContextEntry(repoRoot, entry);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Detection log writer (non-interactive path)
// ---------------------------------------------------------------------------

export type DetectionLogEntry = {
  timestamp: string;
  file: string;
  linesChanged: number;
  ubaScore: number;
  signals: Record<string, number>;
};

export async function appendDetectionLog(
  repoRoot: string,
  entry: DetectionLogEntry,
): Promise<void> {
  const logPath = path.join(repoRoot, ".kodela", "detection-log.jsonl");
  try {
    await fs.appendFile(logPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // best-effort — never throw from detection
  }
}
