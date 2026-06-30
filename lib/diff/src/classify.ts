// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { ChangeType, DiffResult } from "./types.js";

/**
 * Returns true when the number of added lines exceeds the given threshold.
 */
export function isLargeInsertion(result: DiffResult, threshold: number): boolean {
  return result.stats.addedLines > threshold;
}

/**
 * Returns true when changeDensity exceeds `ratio` (default 0.6).
 * A high change density suggests the file was substantially rewritten.
 */
export function isPossibleRewrite(result: DiffResult, ratio = 0.6): boolean {
  return result.stats.changeDensity > ratio;
}

/**
 * Sørensen–Dice coefficient on deduplicated line sets.
 * Returns a value in [0, 1] where 1 = identical and 0 = no shared lines.
 */
export function similarityRatio(oldContent: string, newContent: string): number {
  const oldLines = new Set(oldContent.split("\n").map((l) => l.trim()).filter((l) => l.length > 0));
  const newLines = new Set(newContent.split("\n").map((l) => l.trim()).filter((l) => l.length > 0));

  if (oldLines.size === 0 && newLines.size === 0) return 1;
  if (oldLines.size === 0 || newLines.size === 0) return 0;

  let intersectionSize = 0;
  for (const line of oldLines) {
    if (newLines.has(line)) intersectionSize++;
  }

  return (2 * intersectionSize) / (oldLines.size + newLines.size);
}

/**
 * Heuristic AI-change detector combining:
 *   - large insertion (added > 20 lines)
 *   - high change density (> 0.5)
 *   - low similarity (< 0.4, via stats.contentSimilarity)
 *
 * Returns true when at least two of the three signals are present.
 * Uses only the DiffResult so callers don't need to pass the raw content.
 */
export function isLikelyAIChange(result: DiffResult): boolean {
  const largeInsert = isLargeInsertion(result, 20);
  const highDensity = result.stats.changeDensity > 0.5;
  const lowSimilarity = result.stats.contentSimilarity < 0.4;

  const signals = [largeInsert, highDensity, lowSimilarity].filter(Boolean).length;
  return signals >= 2;
}

/**
 * Derive a unified `ChangeType` from a `DiffResult`.
 *
 * Priority (highest first):
 *   1. `"rewrite"` — changeDensity > 0.6 (majority of the old file was replaced)
 *   2. `"modify"`  — addedLines > 20 (meaningful insertion, but not a full rewrite)
 *   3. `"minor"`   — everything else (small, localised edits)
 *
 * This function is the single source of truth for the `stats.changeType` field
 * that is computed inside `postprocess` and attached to every `DiffResult`.
 * Callers that already have a `DiffResult` should read `result.stats.changeType`
 * directly rather than calling this function again.
 */
export function deriveChangeType(result: DiffResult): ChangeType {
  if (isPossibleRewrite(result)) return "rewrite";
  if (isLargeInsertion(result, 20)) return "modify";
  return "minor";
}
