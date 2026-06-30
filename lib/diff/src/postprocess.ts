// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Post-processing pipeline:
 *   1. Expand each RawChange into "removed" and/or "added" raw parts
 *   2. Apply ignoreWhitespace filter
 *   3. Promote truly-adjacent removed+added pairs of equal span to "modified"
 *   4. Compute contentHash for every hunk
 *   5. Detect exact moves (removed hash == added hash, paired greedily)
 *   5b. Detect fuzzy moves (Sørensen–Dice similarity ≥ fuzzyMoveThreshold, greedy best-first)
 *   6. Sort all result arrays ascending with no overlaps
 *   7. Compute stats
 */

import { hashLines } from "./hash.js";
import type { ChangeType, DiffHunk, DiffResult, DiffStats, LineRange } from "./types.js";
import type { RawChange } from "./diff.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a 0-based [start, end) span to a 1-based inclusive LineRange. */
function toLineRange(start: number, end: number): LineRange {
  return [start + 1, end];
}

/** Sort DiffHunks ascending by their first relevant line number. */
function sortHunks(hunks: DiffHunk[]): DiffHunk[] {
  return [...hunks].sort((a, b) => {
    const aLine = a.oldRange?.[0] ?? a.newRange?.[0] ?? 0;
    const bLine = b.oldRange?.[0] ?? b.newRange?.[0] ?? 0;
    return aLine - bLine;
  });
}

/**
 * Sørensen–Dice coefficient on the deduplicated trimmed line sets of two hunks.
 * Returns a value in [0, 1] where 1 = identical line sets and 0 = no shared lines.
 */
function diceSimilarity(aLines: readonly string[], bLines: readonly string[]): number {
  const setA = new Set(aLines.map((l) => l.trim()).filter((l) => l.length > 0));
  const setB = new Set(bLines.map((l) => l.trim()).filter((l) => l.length > 0));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const line of setA) {
    if (setB.has(line)) intersection++;
  }
  return (2 * intersection) / (setA.size + setB.size);
}

// ─── Internal part types ──────────────────────────────────────────────────────

type RemovedPart = {
  type: "removed";
  oldStart: number;
  oldEnd: number;
  /** Position in new file where this deletion sits (no new lines here). */
  newPos: number;
};

type AddedPart = {
  type: "added";
  newStart: number;
  newEnd: number;
  /** Position in old file where this insertion sits (no old lines here). */
  oldPos: number;
};

type RawPart = RemovedPart | AddedPart;

// ─── Main export ──────────────────────────────────────────────────────────────

export function postprocess(
  rawChanges: readonly RawChange[],
  oldLines: readonly string[],
  newLines: readonly string[],
  ignoreWhitespace: boolean,
  fuzzyMoveThreshold = 1.0,
): DiffResult {
  // ── Step 1: expand raw changes into removed / added parts ─────────────────
  const parts: RawPart[] = [];
  for (const ch of rawChanges) {
    const hasOld = ch.oldStart < ch.oldEnd;
    const hasNew = ch.newStart < ch.newEnd;
    if (hasOld) {
      parts.push({ type: "removed", oldStart: ch.oldStart, oldEnd: ch.oldEnd, newPos: ch.newStart });
    }
    if (hasNew) {
      parts.push({ type: "added", newStart: ch.newStart, newEnd: ch.newEnd, oldPos: ch.oldEnd });
    }
  }

  // ── Step 2: apply ignoreWhitespace filter ─────────────────────────────────
  const filtered: RawPart[] = ignoreWhitespace
    ? parts.filter((p) => {
        const lines =
          p.type === "removed"
            ? oldLines.slice(p.oldStart, p.oldEnd)
            : newLines.slice(p.newStart, p.newEnd);
        return lines.some((l) => l.trim() !== "");
      })
    : parts;

  // ── Step 3: promote adjacent removed+added pairs to "modified" ────────────
  //
  // A removed part at [oldStart, oldEnd) and a following added part are truly
  // adjacent when:
  //   - removed.oldEnd === added.oldPos   (no old lines in between)
  //   - removed.newPos === added.newStart (no new lines in between)
  //
  // Equal-span check (same number of lines) is required so that the conceptual
  // mapping is line-for-line.

  type IntermHunk =
    | { type: "added"; newStart: number; newEnd: number }
    | { type: "removed"; oldStart: number; oldEnd: number }
    | { type: "modified"; oldStart: number; oldEnd: number; newStart: number; newEnd: number };

  const interim: IntermHunk[] = [];
  let i = 0;
  while (i < filtered.length) {
    const cur = filtered[i]!;
    const next = i + 1 < filtered.length ? filtered[i + 1] : undefined;

    if (
      cur.type === "removed" &&
      next?.type === "added" &&
      cur.oldEnd - cur.oldStart === next.newEnd - next.newStart && // same span
      cur.oldEnd === next.oldPos && // no old gap
      cur.newPos === next.newStart // no new gap
    ) {
      interim.push({
        type: "modified",
        oldStart: cur.oldStart,
        oldEnd: cur.oldEnd,
        newStart: next.newStart,
        newEnd: next.newEnd,
      });
      i += 2;
    } else if (cur.type === "removed") {
      interim.push({ type: "removed", oldStart: cur.oldStart, oldEnd: cur.oldEnd });
      i += 1;
    } else {
      interim.push({ type: "added", newStart: (cur as AddedPart).newStart, newEnd: (cur as AddedPart).newEnd });
      i += 1;
    }
  }

  // ── Step 4: build DiffHunk[] with contentHash ─────────────────────────────
  const added: DiffHunk[] = [];
  const removed: DiffHunk[] = [];
  const modified: DiffHunk[] = [];

  for (const h of interim) {
    if (h.type === "added") {
      const lines = newLines.slice(h.newStart, h.newEnd);
      added.push({
        type: "added",
        newRange: toLineRange(h.newStart, h.newEnd),
        contentHash: hashLines(lines),
      });
    } else if (h.type === "removed") {
      const lines = oldLines.slice(h.oldStart, h.oldEnd);
      removed.push({
        type: "removed",
        oldRange: toLineRange(h.oldStart, h.oldEnd),
        contentHash: hashLines(lines),
      });
    } else {
      const oldSlice = oldLines.slice(h.oldStart, h.oldEnd);
      const newSlice = newLines.slice(h.newStart, h.newEnd);
      modified.push({
        type: "modified",
        oldRange: toLineRange(h.oldStart, h.oldEnd),
        newRange: toLineRange(h.newStart, h.newEnd),
        contentHash: hashLines([...oldSlice, ...newSlice]),
      });
    }
  }

  // ── Step 5: exact move detection ──────────────────────────────────────────
  //
  // A "move" is a removed hunk whose contentHash matches an added hunk's hash.
  // We greedily pair them (first match wins) and remove them from added/removed.

  const moved: DiffHunk[] = [];
  const movedRemovedIdx = new Set<number>();
  const movedAddedIdx = new Set<number>();

  const removedByHash = new Map<string, number[]>();
  for (let ri = 0; ri < removed.length; ri++) {
    const hash = removed[ri]!.contentHash!;
    const list = removedByHash.get(hash) ?? [];
    list.push(ri);
    removedByHash.set(hash, list);
  }

  for (let ai = 0; ai < added.length; ai++) {
    const hash = added[ai]!.contentHash!;
    const riList = removedByHash.get(hash);
    if (riList && riList.length > 0) {
      const ri = riList.shift()!;
      moved.push({
        type: "moved",
        oldRange: removed[ri]!.oldRange,
        newRange: added[ai]!.newRange,
        contentHash: hash,
      });
      movedRemovedIdx.add(ri);
      movedAddedIdx.add(ai);
    }
  }

  let workingRemoved = removed.filter((_, idx) => !movedRemovedIdx.has(idx));
  let workingAdded = added.filter((_, idx) => !movedAddedIdx.has(idx));

  // ── Step 5b: fuzzy move detection ─────────────────────────────────────────
  //
  // Only runs when fuzzyMoveThreshold < 1.0.  For every remaining
  // (removed, added) pair compute Sørensen–Dice similarity on their trimmed
  // line sets.  Promote pairs that meet the threshold to "moved" using a
  // greedy best-first strategy (highest similarity wins; ties broken by
  // oldRange start then newRange start for determinism).

  // Clamp threshold to [0, 1] so callers can't accidentally pass out-of-range values.
  const clampedThreshold = Math.min(1, Math.max(0, fuzzyMoveThreshold));

  if (clampedThreshold < 1.0) {
    type Candidate = { ri: number; ai: number; similarity: number };
    const candidates: Candidate[] = [];

    for (let ri = 0; ri < workingRemoved.length; ri++) {
      const rh = workingRemoved[ri]!;
      const rLines = oldLines.slice(rh.oldRange![0] - 1, rh.oldRange![1]);
      for (let ai = 0; ai < workingAdded.length; ai++) {
        const ah = workingAdded[ai]!;
        const aLines = newLines.slice(ah.newRange![0] - 1, ah.newRange![1]);
        const sim = diceSimilarity(rLines, aLines);
        if (sim >= clampedThreshold) {
          candidates.push({ ri, ai, similarity: sim });
        }
      }
    }

    // Sort: highest similarity first; tie-break by removed oldRange start,
    // then added newRange start — ensures deterministic output.
    candidates.sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      const aOld = workingRemoved[a.ri]!.oldRange![0];
      const bOld = workingRemoved[b.ri]!.oldRange![0];
      if (aOld !== bOld) return aOld - bOld;
      return workingAdded[a.ai]!.newRange![0] - workingAdded[b.ai]!.newRange![0];
    });

    const usedRi = new Set<number>();
    const usedAi = new Set<number>();

    for (const { ri, ai } of candidates) {
      if (usedRi.has(ri) || usedAi.has(ai)) continue;
      usedRi.add(ri);
      usedAi.add(ai);

      const rh = workingRemoved[ri]!;
      const ah = workingAdded[ai]!;
      moved.push({
        type: "moved",
        oldRange: rh.oldRange,
        newRange: ah.newRange,
        contentHash: rh.contentHash,
      });
    }

    workingRemoved = workingRemoved.filter((_, idx) => !usedRi.has(idx));
    workingAdded = workingAdded.filter((_, idx) => !usedAi.has(idx));
  }

  const finalRemoved = workingRemoved;
  const finalAdded = workingAdded;

  // ── Step 6: compute stats ─────────────────────────────────────────────────
  const totalLinesOld = oldLines.length;
  const totalLinesNew = newLines.length;

  const addedLines = finalAdded.reduce((s, h) => {
    const [start, end] = h.newRange!;
    return s + (end - start + 1);
  }, 0);
  const removedLines = finalRemoved.reduce((s, h) => {
    const [start, end] = h.oldRange!;
    return s + (end - start + 1);
  }, 0);
  const modifiedLines = modified.reduce((s, h) => {
    const [start, end] = h.oldRange!;
    return s + (end - start + 1);
  }, 0);
  const movedLines = moved.reduce((s, h) => {
    const [start, end] = h.oldRange!;
    return s + (end - start + 1);
  }, 0);

  // changeDensity measures how much of the OLD file changed.
  // Using only removedLines + modifiedLines (the old-file side of each change)
  // keeps changeDensity in [0, 1] regardless of how many lines were inserted.
  // Moved lines are intentionally excluded: a move preserves content.
  const changedLines = removedLines + modifiedLines;
  const changeDensity = totalLinesOld > 0 ? changedLines / totalLinesOld : 0;

  // contentSimilarity: Sørensen–Dice coefficient on deduplicated trimmed line
  // sets.  Stored in stats so classification helpers like isLikelyAIChange can
  // work from a single DiffResult argument without needing the raw content.
  const oldSet = new Set(oldLines.map((l) => l.trim()).filter((l) => l.length > 0));
  const newSet = new Set(newLines.map((l) => l.trim()).filter((l) => l.length > 0));
  let contentSimilarity: number;
  if (oldSet.size === 0 && newSet.size === 0) {
    contentSimilarity = 1;
  } else if (oldSet.size === 0 || newSet.size === 0) {
    contentSimilarity = 0;
  } else {
    let intersectionSize = 0;
    for (const line of oldSet) {
      if (newSet.has(line)) intersectionSize++;
    }
    contentSimilarity = (2 * intersectionSize) / (oldSet.size + newSet.size);
  }

  // Derive the unified changeType using the same thresholds as deriveChangeType()
  // in classify.ts.  We compute it here from the raw values rather than calling
  // deriveChangeType() to avoid constructing a temporary DiffResult object.
  // Priority: rewrite > modify > minor.
  const changeType: ChangeType =
    changeDensity > 0.6 ? "rewrite" : addedLines > 20 ? "modify" : "minor";

  const stats: DiffStats = {
    totalLinesOld,
    totalLinesNew,
    addedLines,
    removedLines,
    modifiedLines,
    movedLines,
    changeDensity,
    contentSimilarity,
    changeType,
  };

  return {
    added: sortHunks(finalAdded),
    removed: sortHunks(finalRemoved),
    modified: sortHunks(modified),
    moved: sortHunks(moved),
    stats,
  };
}
