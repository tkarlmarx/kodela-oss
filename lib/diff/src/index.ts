// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { computeRawChanges } from "./diff.js";
import { postprocess } from "./postprocess.js";
import type { DiffInput, DiffOptions, DiffResult } from "./types.js";

export type {
  ChangeType,
  DiffHunk,
  DiffInput,
  DiffOptions,
  DiffResult,
  DiffStats,
  HunkType,
  LineRange,
} from "./types.js";

export {
  deriveChangeType,
  isLargeInsertion,
  isLikelyAIChange,
  isPossibleRewrite,
  similarityRatio,
} from "./classify.js";

export type {
  StreamDiffOptions,
  StreamHunkEvent,
  StreamStatsEvent,
  StreamDiffEvent,
} from "./stream.js";

export { streamDiff, collectStreamDiff } from "./stream.js";

const DEFAULT_LARGE_FILE_THRESHOLD = 10_000;

/**
 * Compute a deterministic, line-level diff of two file contents.
 *
 * @param input   - `{ oldContent, newContent }` as raw strings
 * @param options - optional tuning (ignoreWhitespace, largeFileThreshold)
 * @returns       DiffResult with added/removed/modified/moved hunk arrays and stats
 */
export function computeDiff(input: DiffInput, options?: DiffOptions): DiffResult {
  const ignoreWhitespace = options?.ignoreWhitespace ?? false;
  const largeFileThreshold = options?.largeFileThreshold ?? DEFAULT_LARGE_FILE_THRESHOLD;
  const fuzzyMoveThreshold = options?.fuzzyMoveThreshold ?? 1.0;

  const splitLines = (content: string): string[] =>
    content.length === 0 ? [] : content.split("\n");

  const oldLines = splitLines(input.oldContent);
  const newLines = splitLines(input.newContent);

  // When ignoreWhitespace is set, compare trimmed lines so that lines differing
  // only in leading/trailing whitespace are treated as identical. We still use
  // the original lines for hash computation and range output.
  const compareOld = ignoreWhitespace ? oldLines.map((l) => l.trim()) : oldLines;
  const compareNew = ignoreWhitespace ? newLines.map((l) => l.trim()) : newLines;

  const rawChanges = computeRawChanges(compareOld, compareNew, largeFileThreshold);
  return postprocess(rawChanges, oldLines, newLines, ignoreWhitespace, fuzzyMoveThreshold);
}
