// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { FileChange } from "./types.js";

const AI_FILE_COUNT_THRESHOLD = 10;
const AI_TIME_WINDOW_MS = 2000;
const AI_LINES_THRESHOLD = 500;

/**
 * Detect whether a batch of file changes was likely produced by an AI tool.
 *
 * Returns true when EITHER condition holds:
 *   1. More than 10 files changed within a 2-second window
 *      (min/max timestamp spread < 2000 ms).
 *   2. Total lines changed exceeds 500.
 *
 * Pure function — no side effects, no I/O.
 */
export function detectAIChange(
  files: FileChange[],
  totalLinesChanged: number,
): boolean {
  if (totalLinesChanged > AI_LINES_THRESHOLD) {
    return true;
  }

  if (files.length > AI_FILE_COUNT_THRESHOLD) {
    let minTs = files[0]!.timestamp;
    let maxTs = files[0]!.timestamp;
    for (let i = 1; i < files.length; i++) {
      const ts = files[i]!.timestamp;
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
    if (maxTs - minTs <= AI_TIME_WINDOW_MS) {
      return true;
    }
  }

  return false;
}
