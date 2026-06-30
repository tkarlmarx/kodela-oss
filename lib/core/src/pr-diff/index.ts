// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 51 — GitHub / GitLab pull request diff view integration.
 *
 * Phase A — Core matching algorithm.
 *
 * `findAnnotationsInDiff` takes a parsed PR diff and the full set of
 * ContextEntry objects and returns every annotation whose `lineRange`
 * overlaps with at least one changed hunk in the diff.
 *
 * This module has no network dependencies — it operates purely on
 * in-memory data structures so it can be used by:
 *   • The CLI `kodela pr-comment` command (reads local git diff)
 *   • The API server webhook handlers (GitHub App / GitLab bot)
 */

import type { ContextEntry } from "../schema/index.js";

/**
 * A single `@@` hunk inside a unified diff file section.
 * Describes the new-file line range that is covered by this hunk.
 *
 * `newStart` — first 1-based line number in the new file for this hunk.
 * `newLines` — number of lines in the new file covered by this hunk.
 *              When omitted in the `@@ … +N @@` header it defaults to 1.
 */
export type DiffHunk = {
  newStart: number;
  newLines: number;
};

/**
 * One file's worth of diff information extracted from a PR / MR.
 * `filePath` must match the post-rename path (the `b/` side of the diff).
 */
export type ParsedDiff = {
  filePath: string;
  hunks: DiffHunk[];
};

/**
 * A single annotation that overlaps with a changed hunk.
 * `hunkLine` is the first line in the hunk range that the annotation covers,
 * clamped to [hunk.newStart, hunk.newStart + hunk.newLines − 1].
 */
export type AnnotationInDiff = {
  entry: ContextEntry;
  filePath: string;
  hunkLine: number;
};

/**
 * Parse the unified-diff patch string returned by the GitHub PR Files API
 * (and similar providers) into an array of `DiffHunk` records.
 *
 * The patch format is standard unified diff:
 *   @@ -oldStart,oldLines +newStart,newLines @@ optional context
 *
 * Only the `+newStart[,newLines]` fragment is extracted — that gives us
 * the new-file line ranges that reviewers see in the diff view.
 */
export function parsePatchHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  // Match:  @@ -OLD[,OLDLINES] +NEW[,NEWLINES] @@
  const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;
  while ((match = hunkRegex.exec(patch)) !== null) {
    const newStart = parseInt(match[1], 10);
    const newLines = match[2] !== undefined ? parseInt(match[2], 10) : 1;
    if (!isNaN(newStart) && newStart > 0) {
      hunks.push({ newStart, newLines });
    }
  }
  return hunks;
}

/**
 * Given a list of parsed diff files and a list of ContextEntry objects,
 * return every entry whose `lineRange` intersects at least one changed
 * hunk in the diff.
 *
 * Two ranges [a, b] and [c, d] intersect when a ≤ d AND b ≥ c.
 *
 * Each entry appears at most once in the result even if it spans multiple
 * hunks.  `hunkLine` is the first line of the matching hunk range that
 * falls inside the entry's lineRange (useful for pinpointing the inline
 * comment position).
 */
export function findAnnotationsInDiff(
  diff: ParsedDiff[],
  entries: ContextEntry[],
): AnnotationInDiff[] {
  const result: AnnotationInDiff[] = [];

  for (const entry of entries) {
    const parsedFile = diff.find((d) => d.filePath === entry.filePath);
    if (!parsedFile) continue;

    for (const hunk of parsedFile.hunks) {
      if (hunk.newLines === 0) continue;
      const hunkEnd = hunk.newStart + hunk.newLines - 1;
      const entryStart = entry.lineRange.start;
      const entryEnd = entry.lineRange.end;

      // Overlap check: entry and hunk share at least one line
      if (entryStart <= hunkEnd && entryEnd >= hunk.newStart) {
        // Pinpoint the first overlapping line
        const hunkLine = Math.max(entryStart, hunk.newStart);
        result.push({ entry, filePath: entry.filePath, hunkLine });
        break; // one match per entry is enough
      }
    }
  }

  return result;
}
