// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { readIndex, readContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { computeDiff } from "@kodela/diff";
import { isLikelyAIChange } from "@kodela/diff";
import fs from "node:fs/promises";
import path from "node:path";
import { tryRunGit, runGit } from "../utils/exec.js";
import { normalizeFilePath } from "../utils/repo.js";
import type { OutputMode } from "../output/formatters.js";

export const CI_FAILURE_MESSAGE =
  "AI-change signal triggered — add a context note before merging";

/**
 * Evaluate whether a CI check should fail for a given file analysis result.
 * Returns `{ pass: false, message: CI_FAILURE_MESSAGE }` when the AI-change
 * signal is triggered; `{ pass: true, message: null }` otherwise.
 *
 * Extracted from bin.ts so the CI-exit-code logic can be tested without
 * spawning a subprocess.
 */
export function evaluateCiMode(result: FileAnalysisResult): {
  pass: boolean;
  exitCode: 0 | 1;
  message: string | null;
} {
  if (result.isLikelyAIChange) {
    return { pass: false, exitCode: 1, message: CI_FAILURE_MESSAGE };
  }
  return { pass: true, exitCode: 0, message: null };
}

export type DiffEntry = {
  filePath: string;
  entries: ContextEntry[];
};

export type DiffResult = {
  from: string;
  to: string;
  changedFiles: string[];
  affectedEntries: DiffEntry[];
};

export type DiffOptions = {
  from?: string;
  to?: string;
  output?: OutputMode;
  repoRoot: string;
};

export type FileAnalysisStats = {
  added: number;
  removed: number;
  modified: number;
  moved: number;
  changeDensity: number;
  contentSimilarity: number;
  totalLinesOld: number;
  totalLinesNew: number;
};

export type FileAnalysisResult = {
  filePath: string;
  baseline: string;
  baselineAvailable: boolean;
  stats: FileAnalysisStats;
  isLikelyAIChange: boolean;
};

export type FileAnalysisOptions = {
  repoRoot: string;
  filePath: string;
  baseline?: string;
};

export type WorkingTreeAnalysisOptions = {
  repoRoot: string;
  baseline?: string;
  output?: OutputMode;
};

export type WorkingTreeAnalysisResult = {
  files: FileAnalysisResult[];
  totalFiles: number;
  aiChangedCount: number;
};

export async function runDiff(opts: DiffOptions): Promise<DiffResult> {
  const { repoRoot, from = "HEAD~1", to = "HEAD" } = opts;

  const gitResult = await tryRunGit(
    ["diff", "--name-only", from, to],
    repoRoot,
  );

  const changedFiles =
    gitResult && gitResult.stdout
      ? gitResult.stdout.split("\n").map(normalizeFilePath).filter(Boolean)
      : [];

  if (changedFiles.length === 0) {
    return { from, to, changedFiles: [], affectedEntries: [] };
  }

  const index = await readIndex(repoRoot);
  const allEntries = await Promise.all(
    index.entries.map((id) => readContextEntry(repoRoot, id)),
  );

  const affectedEntries: DiffEntry[] = [];
  for (const filePath of changedFiles) {
    const entries = allEntries.filter(
      (e) => normalizeFilePath(e.filePath) === filePath,
    );
    if (entries.length > 0) {
      affectedEntries.push({ filePath, entries });
    }
  }

  return { from, to, changedFiles, affectedEntries };
}

export async function runFileAnalysis(
  opts: FileAnalysisOptions,
): Promise<FileAnalysisResult> {
  const { repoRoot, filePath, baseline = "HEAD" } = opts;

  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(repoRoot, filePath);
  const relPath = normalizeFilePath(
    path.isAbsolute(filePath) ? path.relative(repoRoot, filePath) : filePath,
  );

  const newContent = await fs.readFile(absPath, "utf8");

  let oldContent = "";
  let baselineAvailable = false;
  try {
    const baselineResult = await runGit(
      ["show", `${baseline}:${relPath}`],
      repoRoot,
    );
    oldContent = baselineResult.stdout;
    baselineAvailable = true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr ?? msg;
    const isFileMissingAtRef =
      stderr.includes("does not exist") ||
      stderr.includes("exists on disk, but not in") ||
      stderr.includes("Path '") ||
      stderr.includes("path '");
    if (!isFileMissingAtRef) {
      throw new Error(
        `Invalid git baseline "${baseline}": ${stderr.split("\n")[0]}`,
      );
    }
  }

  const diffResult = computeDiff({ oldContent, newContent });

  const stats: FileAnalysisStats = {
    added: diffResult.added.length,
    removed: diffResult.removed.length,
    modified: diffResult.modified.length,
    moved: diffResult.moved.length,
    changeDensity: diffResult.stats.changeDensity,
    contentSimilarity: diffResult.stats.contentSimilarity,
    totalLinesOld: diffResult.stats.totalLinesOld,
    totalLinesNew: diffResult.stats.totalLinesNew,
  };

  return {
    filePath: relPath,
    baseline,
    baselineAvailable,
    stats,
    isLikelyAIChange: isLikelyAIChange(diffResult),
  };
}

export async function runWorkingTreeAnalysis(
  opts: WorkingTreeAnalysisOptions,
): Promise<WorkingTreeAnalysisResult> {
  const { repoRoot, baseline = "HEAD" } = opts;

  // --diff-filter=d (lowercase) excludes deleted files; we cannot read their
  // content from disk so we skip them rather than crashing with ENOENT.
  const gitResult = await tryRunGit(
    ["diff", "--diff-filter=d", "--name-only", "HEAD"],
    repoRoot,
  );
  const dirtyFiles =
    gitResult && gitResult.stdout
      ? gitResult.stdout
          .split("\n")
          .map(normalizeFilePath)
          .filter((f) => Boolean(f) && !f.startsWith(".kodela/"))
      : [];

  const files = await Promise.all(
    dirtyFiles.map((f) => runFileAnalysis({ repoRoot, filePath: f, baseline })),
  );

  return {
    files,
    totalFiles: files.length,
    aiChangedCount: files.filter((f) => f.isLikelyAIChange).length,
  };
}

export function formatFileAnalysisResult(
  result: FileAnalysisResult,
  output: OutputMode,
): string {
  if (output === "json") {
    return JSON.stringify(result, null, 2);
  }

  const lines: string[] = [
    `File analysis: ${result.filePath}`,
    `Baseline: ${result.baseline}${result.baselineAvailable ? "" : " (not found — treating as new file)"}`,
    "",
    "Hunk counts:",
    `  Added    : ${result.stats.added}`,
    `  Removed  : ${result.stats.removed}`,
    `  Modified : ${result.stats.modified}`,
    `  Moved    : ${result.stats.moved}`,
    "",
    "Change metrics:",
    `  Change density    : ${(result.stats.changeDensity * 100).toFixed(1)}%`,
    `  Content similarity: ${(result.stats.contentSimilarity * 100).toFixed(1)}%`,
    `  Lines (old → new) : ${result.stats.totalLinesOld} → ${result.stats.totalLinesNew}`,
    "",
    `AI-change signal: ${result.isLikelyAIChange ? "YES — likely AI-generated change" : "no"}`,
  ];

  return lines.join("\n");
}

export function formatWorkingTreeAnalysisResult(
  result: WorkingTreeAnalysisResult,
  output: OutputMode,
): string {
  if (output === "json") {
    return JSON.stringify(result.files, null, 2);
  }

  if (result.totalFiles === 0) {
    return (
      "No working-tree changes detected.\n" +
      "  (Files match the current git HEAD — reverting a file with `git checkout` removes it from this view.\n" +
      "   To capture context for a file, run: kodela add <file>)"
    );
  }

  const lines: string[] = [
    `Working-tree analysis: ${result.totalFiles} modified file${result.totalFiles !== 1 ? "s" : ""}`,
    result.aiChangedCount > 0
      ? `AI-change signal: ${result.aiChangedCount} file${result.aiChangedCount !== 1 ? "s" : ""} flagged`
      : "AI-change signal: none",
    "",
  ];

  for (const file of result.files) {
    const aiTag = file.isLikelyAIChange ? " [AI]" : "";
    lines.push(
      `  ${file.filePath}${aiTag}`,
      `    Added: ${file.stats.added}  Removed: ${file.stats.removed}  Density: ${(file.stats.changeDensity * 100).toFixed(1)}%`,
    );
  }

  return lines.join("\n");
}

export function formatDiffResult(result: DiffResult, output: OutputMode): string {
  if (output === "json") {
    return JSON.stringify(result, null, 2);
  }

  if (result.changedFiles.length === 0) {
    return `No changes between ${result.from} and ${result.to}.`;
  }

  const lines = [
    `Context diff: ${result.from} → ${result.to}`,
    `Changed files: ${result.changedFiles.length}`,
    `Files with context entries: ${result.affectedEntries.length}`,
  ];

  if (result.affectedEntries.length > 0) {
    lines.push("");
    for (const file of result.affectedEntries) {
      lines.push(`  ${file.filePath} (${file.entries.length} entr${file.entries.length !== 1 ? "ies" : "y"})`);
      for (const e of file.entries) {
        const statusIcon =
          e.status === "mapped" ? "✓" : e.status === "uncertain" ? "⚠" : "✗";
        lines.push(
          `    ${statusIcon} L${e.lineRange.start}-${e.lineRange.end}: ${e.note.slice(0, 60)}`,
        );
      }
    }
  }

  const unchanged = result.changedFiles.filter(
    (f) => !result.affectedEntries.some((a) => a.filePath === f),
  );
  if (unchanged.length > 0) {
    lines.push("");
    lines.push("Changed files without context entries:");
    for (const f of unchanged) {
      lines.push(`  ${f}`);
    }
  }

  return lines.join("\n");
}
