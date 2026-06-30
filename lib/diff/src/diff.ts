// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Core diff engine: Myers O(ND) for files within the size threshold,
 * histogram/patience-style O(N) fallback for large files.
 *
 * Outputs raw changed regions that postprocess.ts classifies and sorts
 * into the final DiffResult.
 */

/** A single contiguous changed region (0-based indices, end exclusive). */
export type RawChange = {
  /** First changed line index in the old file. */
  oldStart: number;
  /** Exclusive end line index in the old file. */
  oldEnd: number;
  /** First changed line index in the new file. */
  newStart: number;
  /** Exclusive end line index in the new file. */
  newEnd: number;
};

// ─── Myers O(ND) ─────────────────────────────────────────────────────────────
//
// Myers finds the shortest edit script (minimum number of inserts+deletes).
// We store the "V" array (furthest x on each diagonal) at every step d so
// the backtrack pass can reconstruct the edit path.

/**
 * Build the Myers trace: trace[d] = V (furthest-x array) before iteration d.
 * A final extra entry is appended once (N,M) is reached.
 */
function buildTrace(a: readonly string[], b: readonly string[]): Int32Array[] {
  const N = a.length;
  const M = b.length;
  const MAX = N + M;
  const size = 2 * MAX + 1;
  const v = new Int32Array(size);
  // V[k] uses offset so k can be negative. Sentinel: V[1] = 0.
  v[1 + MAX] = 0;

  const trace: Int32Array[] = [];

  for (let d = 0; d <= MAX; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const ki = k + MAX;
      let x: number;
      // Choose to come from diagonal k+1 (insert) or k-1 (delete)
      if (k === -d || (k !== d && v[ki - 1]! < v[ki + 1]!)) {
        x = v[ki + 1]!;       // insert: x stays, y increases → came from k+1
      } else {
        x = v[ki - 1]! + 1;   // delete: x increases → came from k-1
      }
      let y = x - k;
      // Follow the snake (matching lines)
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[ki] = x;
      if (x >= N && y >= M) {
        trace.push(v.slice());
        return trace;
      }
    }
  }
  return trace;
}

/**
 * Backtrack through the Myers trace to emit one RawChange per edit step,
 * then coalesce adjacent (gap-free) steps into merged regions.
 */
function backtrack(
  trace: readonly Int32Array[],
  a: readonly string[],
  b: readonly string[],
): RawChange[] {
  const MAX = a.length + b.length;
  const ops: RawChange[] = [];
  let x = a.length;
  let y = b.length;

  // d goes from trace.length-1 down to 2.
  // trace[d-1] = V used during Myers iteration (d-1), which is the step being reconstructed.
  for (let d = trace.length - 1; d >= 2; d--) {
    const v = trace[d - 1]!;
    const k = x - y;
    const ki = k + MAX;
    const dMyers = d - 1; // actual Myers edit-count for this step

    // Determine which diagonal we came from
    let prevK: number;
    if (k === -dMyers || (k !== dMyers && v[ki - 1]! < v[ki + 1]!)) {
      prevK = k + 1; // insert (came from diagonal k+1)
    } else {
      prevK = k - 1; // delete (came from diagonal k-1)
    }

    const prevX = v[prevK + MAX]!;
    const prevY = prevX - prevK;

    // Undo the snake that follows the edit to land at (x, y).
    // After a delete: we move from (prevX, prevY) to (prevX+1, prevY), then snake.
    // After an insert: we move from (prevX, prevY) to (prevX, prevY+1), then snake.
    const afterEditX = prevK === k - 1 ? prevX + 1 : prevX;
    const afterEditY = prevK === k - 1 ? prevY : prevY + 1;
    x = afterEditX;
    y = afterEditY;

    // Emit the single-step change
    if (prevK === k - 1) {
      // Delete a[prevX]
      ops.push({ oldStart: prevX, oldEnd: prevX + 1, newStart: prevY, newEnd: prevY });
    } else {
      // Insert b[prevY]
      ops.push({ oldStart: prevX, oldEnd: prevX, newStart: prevY, newEnd: prevY + 1 });
    }

    x = prevX;
    y = prevY;
  }

  return coalesce(ops.reverse());
}

/**
 * Merge adjacent, gap-free individual edit steps into single RawChange objects.
 * Two changes can be merged when they share the same boundary in both old and new.
 */
function coalesce(changes: RawChange[]): RawChange[] {
  if (changes.length === 0) return [];
  const result: RawChange[] = [Object.assign({}, changes[0]!)];
  for (let i = 1; i < changes.length; i++) {
    const prev = result[result.length - 1]!;
    const cur = changes[i]!;
    if (cur.oldStart === prev.oldEnd && cur.newStart === prev.newEnd) {
      prev.oldEnd = cur.oldEnd;
      prev.newEnd = cur.newEnd;
    } else {
      result.push(Object.assign({}, cur));
    }
  }
  return result;
}

/** Run the full Myers diff. Returns 0-based changed regions. */
function myersDiff(a: readonly string[], b: readonly string[]): RawChange[] {
  const N = a.length;
  const M = b.length;
  if (N === 0 && M === 0) return [];
  if (N === 0) return [{ oldStart: 0, oldEnd: 0, newStart: 0, newEnd: M }];
  if (M === 0) return [{ oldStart: 0, oldEnd: N, newStart: 0, newEnd: 0 }];

  const trace = buildTrace(a, b);
  return backtrack(trace, a, b);
}

// ─── Histogram / patience O(N) fallback ───────────────────────────────────────
//
// For files above the size threshold: count occurrences of each line,
// use lines that appear exactly once in both files as diff anchors,
// then emit the regions between anchors as raw changes.

function histogramDiff(a: readonly string[], b: readonly string[]): RawChange[] {
  const N = a.length;
  const M = b.length;
  if (N === 0 && M === 0) return [];
  if (N === 0) return [{ oldStart: 0, oldEnd: 0, newStart: 0, newEnd: M }];
  if (M === 0) return [{ oldStart: 0, oldEnd: N, newStart: 0, newEnd: 0 }];

  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (const line of a) countA.set(line, (countA.get(line) ?? 0) + 1);
  for (const line of b) countB.set(line, (countB.get(line) ?? 0) + 1);

  // Index unique lines in B (appear exactly once in both A and B)
  const uniqueInB = new Map<string, number>();
  for (let j = 0; j < M; j++) {
    const line = b[j]!;
    if (countA.get(line) === 1 && countB.get(line) === 1) {
      uniqueInB.set(line, j);
    }
  }

  // Collect anchors in natural A order (ai is already strictly increasing)
  type Anchor = { ai: number; bi: number };
  const anchors: Anchor[] = [];
  for (let i = 0; i < N; i++) {
    const bi = uniqueInB.get(a[i]!);
    if (bi !== undefined) anchors.push({ ai: i, bi });
  }

  // Compute Longest Increasing Subsequence on bi (O(N log N) patience sort).
  // Because ai is already strictly increasing, LIS on bi gives us a set of
  // anchors where BOTH ai and bi are strictly increasing — the only valid
  // anchors for a non-overlapping diff.
  const dp: number[] = []; // dp[k] = index of anchor with smallest bi ending LIS of length k+1
  const parent: number[] = new Array<number>(anchors.length).fill(-1);

  for (let j = 0; j < anchors.length; j++) {
    const bi = anchors[j]!.bi;
    let lo = 0;
    let hi = dp.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (anchors[dp[mid]!]!.bi < bi) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) parent[j] = dp[lo - 1]!;
    dp[lo] = j;
  }

  // Reconstruct the chosen anchors in order
  const chosen: Anchor[] = [];
  if (dp.length > 0) {
    let k = dp[dp.length - 1]!;
    while (k >= 0) {
      chosen.unshift(anchors[k]!);
      k = parent[k]!;
    }
  }

  // Emit changed regions between consecutive anchors.
  // Because both ai and bi are strictly increasing in chosen,
  // all emitted ranges are guaranteed non-overlapping.
  const changes: RawChange[] = [];
  let ai = 0;
  let bi = 0;
  for (const { ai: nextAi, bi: nextBi } of chosen) {
    if (ai < nextAi || bi < nextBi) {
      changes.push({ oldStart: ai, oldEnd: nextAi, newStart: bi, newEnd: nextBi });
    }
    ai = nextAi + 1;
    bi = nextBi + 1;
  }
  if (ai < N || bi < M) {
    changes.push({ oldStart: ai, oldEnd: N, newStart: bi, newEnd: M });
  }

  return changes;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Compute raw changed regions for the given line arrays.
 * Selects the algorithm based on file size.
 */
export function computeRawChanges(
  a: readonly string[],
  b: readonly string[],
  largeFileThreshold: number,
): RawChange[] {
  if (a.length > largeFileThreshold || b.length > largeFileThreshold) {
    return histogramDiff(a, b);
  }
  return myersDiff(a, b);
}
