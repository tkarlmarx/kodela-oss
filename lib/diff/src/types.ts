// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/** A 1-based inclusive line range: [startLine, endLine]. */
export type LineRange = [number, number];

export type HunkType = "added" | "removed" | "modified" | "moved";

export type DiffHunk = {
  type: HunkType;
  /** Present for "removed", "modified", and "moved" hunks. */
  oldRange?: LineRange;
  /** Present for "added", "modified", and "moved" hunks. */
  newRange?: LineRange;
  /** FNV-1a hash of the normalised line content in the hunk. */
  contentHash?: string;
};

/**
 * High-level classification of the overall change magnitude.
 *
 * - `"minor"`   — Small, localised edits; change density ≤ 0.6 and fewer than
 *                 20 lines added.
 * - `"modify"`  — Meaningful change: more than 20 lines added but change
 *                 density has not exceeded the rewrite threshold.
 * - `"rewrite"` — Substantial rewrite: change density > 0.6, indicating the
 *                 majority of the file was replaced.
 */
export type ChangeType = "minor" | "modify" | "rewrite";

export type DiffStats = {
  totalLinesOld: number;
  totalLinesNew: number;
  addedLines: number;
  removedLines: number;
  modifiedLines: number;
  /**
   * Sum of old-side line spans for all moved hunks (exact and fuzzy).
   * Consistent with how `modifiedLines` counts old-side lines.
   */
  movedLines: number;
  /** changedLines / totalLinesOld; 0 when old file is empty. */
  changeDensity: number;
  /**
   * Sørensen–Dice coefficient on deduplicated trimmed line sets.
   * 1 = identical content, 0 = no shared lines.
   * Enables single-argument classification helpers like isLikelyAIChange.
   */
  contentSimilarity: number;
  /**
   * Unified high-level classification of the change magnitude.
   * Derived deterministically from `changeDensity` and `addedLines`:
   *   - `"rewrite"` when changeDensity > 0.6
   *   - `"modify"`  when addedLines > 20 (and not a rewrite)
   *   - `"minor"`   otherwise
   */
  changeType: ChangeType;
};

export type DiffResult = {
  added: DiffHunk[];
  removed: DiffHunk[];
  modified: DiffHunk[];
  moved: DiffHunk[];
  stats: DiffStats;
};

export type DiffInput = {
  oldContent: string;
  newContent: string;
};

export type DiffOptions = {
  /** Treat whitespace-only line differences as unchanged. Default: false. */
  ignoreWhitespace?: boolean;
  /** Lines above this threshold use the histogram fallback. Default: 10_000. */
  largeFileThreshold?: number;
  /**
   * Similarity threshold (0–1) for fuzzy move detection.
   * Default `1.0` = exact content-hash match only (backward-compatible).
   * Set below 1.0 to promote near-identical relocated blocks to "moved"
   * rather than classifying them as unrelated remove + add pairs.
   * Similarity is measured as the Sørensen–Dice coefficient on the
   * deduplicated trimmed line sets of the two hunks.
   */
  fuzzyMoveThreshold?: number;
};
