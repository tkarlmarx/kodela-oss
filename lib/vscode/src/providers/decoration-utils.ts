// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { ContextEntry } from "@kodela/core";

export interface LineRange {
  start: number;
  end: number;
}

export interface DecorationRanges {
  mapped: LineRange[];
  uncertain: LineRange[];
  orphaned: LineRange[];
}

export function computeDecorationRanges(
  entries: ReadonlyArray<ContextEntry>,
  normalizedRelPath: string,
): DecorationRanges {
  const result: DecorationRanges = { mapped: [], uncertain: [], orphaned: [] };
  for (const entry of entries) {
    if (entry.filePath !== normalizedRelPath) continue;
    const range: LineRange = {
      start: entry.lineRange.start,
      end: entry.lineRange.end,
    };
    if (entry.status === "orphaned") {
      result.orphaned.push(range);
    } else if (entry.status === "uncertain") {
      result.uncertain.push(range);
    } else {
      result.mapped.push(range);
    }
  }
  return result;
}
