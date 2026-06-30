// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { DiffResult, DiffHunk } from "@kodela/diff";
import { scoreTokenSimilarity, scorePositionalProximity } from "./scorer.js";

export type { DiffResult, DiffHunk };

/**
 * An item of context to be mapped from an old file version to a new one.
 *
 * `tokenHash`   — SHA-256 of the normalised original content, used for exact
 *                 matching.
 * `originalLines` — the raw source lines captured when the context was
 *                 created.  Required to enable Sørensen–Dice fallback
 *                 scoring when the exact hash does not match.
 */
export type ContextItem = {
  id: string;
  tokenHash: string;
  lineRange: { start: number; end: number };
  originalLines: string[];
};

/**
 * Breakdown of the individual scoring components for the winning candidate.
 * Useful for debugging and future weight tuning.
 */
export type ScoreBreakdown = {
  token: number;
  position: number;
};

/**
 * The outcome of mapping a single `ContextItem` into the new file.
 *
 * `newLineRange`   is absent when status is "orphaned" (deleted or unmappable).
 * `scoreBreakdown` exposes the per-component scores used to compute confidence.
 * `filePath`       is reserved for future cross-file move support; always
 *                  `undefined` in current code paths.
 */
export type MappingResult = {
  contextId: string;
  newLineRange?: { start: number; end: number };
  confidence: number;
  status: "mapped" | "uncertain" | "orphaned";
  scoreBreakdown?: ScoreBreakdown;
  filePath?: string;
};

/**
 * Tuning options for `mapContexts`.  All fields are optional; omitted fields
 * fall back to the default values listed below.
 *
 * `searchWindowLines`     — half-width of the candidate search window in lines
 *                           around the diff-adjusted predicted start position.
 *                           Default: 50.
 * `rangeLengthTolerance`  — fractional tolerance applied to the original range
 *                           length when selecting candidate window lengths.
 *                           0.2 means ±20%.  Default: 0.2.
 * `tokenWeight`           — weight given to token-similarity in the combined
 *                           score.  Must satisfy `tokenWeight + positionalWeight
 *                           === 1` for scores to stay in [0, 1].  Default: 0.6.
 * `positionalWeight`      — weight given to positional proximity.  Default: 0.4.
 * `epsilon`               — minimum score gap between the top two non-overlapping
 *                           candidates required to report "mapped"; if the gap is
 *                           smaller the result is downgraded to "uncertain".
 *                           Default: 0.03.
 * `confidenceThresholds`  — override the mapped (default 0.85) and uncertain
 *                           (default 0.60) classification cut-offs.
 * `maxCandidates`         — cap on the candidate pool after deduplication.
 *                           Candidates are ranked by proximity to predicted
 *                           start before truncation.  Default: 500.
 * `windowExpansionFactor` — multiplier applied to `searchWindowLines` for the
 *                           intermediate expanded-window pass that runs between
 *                           the initial window pass and the final full-file
 *                           fallback pass.  Set to 1 to skip the intermediate
 *                           expansion (the initial and full-file passes still
 *                           run).  Default: 2.
 * `isLikelyAIChange`      — when true, positional weight is reduced by 40%
 *                           (redistributed to token weight) before scoring,
 *                           because AI rewrites often preserve token vocabulary
 *                           while restructuring position.  Default: false.
 */
export type MapContextsOptions = {
  searchWindowLines?: number;
  rangeLengthTolerance?: number;
  tokenWeight?: number;
  positionalWeight?: number;
  epsilon?: number;
  confidenceThresholds?: {
    mapped?: number;
    uncertain?: number;
  };
  maxCandidates?: number;
  windowExpansionFactor?: number;
  isLikelyAIChange?: boolean;
};

const DEFAULT_MAPPED_THRESHOLD = 0.85;
const DEFAULT_UNCERTAIN_MIN = 0.6;
const DEFAULT_TOKEN_WEIGHT = 0.6;
const DEFAULT_POSITIONAL_WEIGHT = 0.4;
const DEFAULT_SEARCH_WINDOW_LINES = 50;
const DEFAULT_RANGE_LENGTH_TOLERANCE = 0.2;
const DEFAULT_EPSILON = 0.03;
const DEFAULT_MAX_CANDIDATES = 500;
const DEFAULT_WINDOW_EXPANSION_FACTOR = 2;
const CHANGE_DENSITY_DAMPENING_THRESHOLD = 0.3;
const AI_POSITIONAL_WEIGHT_REDUCTION = 0.4;
const PERFECT_SCORE = 1.0;

function classifyStatus(
  confidence: number,
  mappedThreshold: number,
  uncertainMin: number,
): "mapped" | "uncertain" | "orphaned" {
  if (confidence > mappedThreshold) return "mapped";
  if (confidence >= uncertainMin) return "uncertain";
  return "orphaned";
}

/**
 * Return the representative old-file position of a hunk for sort ordering.
 * Added-only hunks (no oldRange) are keyed on their new position.
 */
function hunkOldKey(hunk: DiffHunk): number {
  if (hunk.oldRange !== undefined) return hunk.oldRange[0];
  if (hunk.newRange !== undefined) return hunk.newRange[0];
  return 0;
}

/**
 * Compute the cumulative line offset introduced by hunks that fall entirely
 * before `lineStart` in the old file, and detect whether the context range
 * was fully deleted.
 *
 * Hunks are sorted by old-file start position so the cumulative offset
 * accumulates in a deterministic, order-independent manner.
 */
function computeDiffOffsets(
  lineStart: number,
  lineEnd: number,
  diffResult: DiffResult,
): { offset: number; isDeleted: boolean } {
  const allHunks: DiffHunk[] = [
    ...diffResult.added,
    ...diffResult.removed,
    ...diffResult.modified,
    ...diffResult.moved,
  ].sort((a, b) => hunkOldKey(a) - hunkOldKey(b));

  let offset = 0;
  let coveringHunks = 0;
  let coveringRemovedHunks = 0;

  for (const hunk of allHunks) {
    const oldStart = hunk.oldRange?.[0];
    const oldEnd = hunk.oldRange?.[1];
    const newStart = hunk.newRange?.[0];
    const newEnd = hunk.newRange?.[1];

    if (oldStart === undefined || oldEnd === undefined) {
      if (hunk.type === "added" && newStart !== undefined && newEnd !== undefined) {
        if (newEnd < lineStart) {
          offset += newEnd - newStart + 1;
        }
      }
      continue;
    }

    if (oldEnd < lineStart) {
      const oldLen = oldEnd - oldStart + 1;
      const newLen =
        newStart !== undefined && newEnd !== undefined
          ? newEnd - newStart + 1
          : 0;
      offset += newLen - oldLen;
    } else if (oldStart <= lineEnd && oldEnd >= lineStart) {
      coveringHunks++;
      if (hunk.type === "removed") {
        coveringRemovedHunks++;
      }
    }
  }

  const isDeleted = coveringHunks > 0 && coveringRemovedHunks === coveringHunks;

  return { offset, isDeleted };
}

/**
 * Gather candidate line ranges from `lines` (1-based) whose length is within
 * ±`rangeLengthTolerance` of `targetLength` and whose start falls within
 * `windowStart`..`windowEnd`.
 */
function gatherCandidates(
  lines: string[],
  targetLength: number,
  windowStart: number,
  windowEnd: number,
  rangeLengthTolerance: number,
): Array<{ start: number; end: number; lineSlice: string[] }> {
  const minLen = Math.max(1, Math.round(targetLength * (1 - rangeLengthTolerance)));
  const maxLen = Math.round(targetLength * (1 + rangeLengthTolerance));
  const totalLines = lines.length;

  const candidates: Array<{ start: number; end: number; lineSlice: string[] }> = [];

  const clampedStart = Math.max(1, windowStart);
  const clampedEnd = Math.min(totalLines, windowEnd);

  for (let rangeLen = minLen; rangeLen <= maxLen; rangeLen++) {
    for (let start = clampedStart; start <= clampedEnd; start++) {
      const end = start + rangeLen - 1;
      if (end > totalLines) break;
      const lineSlice = lines.slice(start - 1, end);
      candidates.push({ start, end, lineSlice });
    }
  }

  return candidates;
}

/**
 * Scan for the nearest exact hash match (at exactly `targetLength` lines) within
 * the given window.  Returns the nearest-to-predictedStart match, or null when
 * none is found.
 *
 * This is the performance guardrail that fulfils the "early-stop in candidate
 * gathering when an exact match is found" requirement: instead of stopping inside
 * `gatherCandidates` (which has no access to the token hash) we scan before
 * building the full pool.  Short-circuit is only applied when the resulting
 * combined score reaches a perfect 1.0 — ensuring a better-positioned near-exact
 * candidate in the pool can still win when the exact match is far away.
 */
function quickExactMatchScan(
  lines: string[],
  targetLength: number,
  windowStart: number,
  windowEnd: number,
  tokenHash: string,
  predictedStart: number,
): { start: number; end: number; lineSlice: string[] } | null {
  const totalLines = lines.length;
  const clampedStart = Math.max(1, windowStart);
  const clampedEnd = Math.min(totalLines, windowEnd);

  let nearest: { start: number; end: number; lineSlice: string[]; distance: number } | null = null;

  for (let start = clampedStart; start <= clampedEnd; start++) {
    const end = start + targetLength - 1;
    if (end > totalLines) break;
    const lineSlice = lines.slice(start - 1, end);
    if (scoreTokenSimilarity(tokenHash, lineSlice) >= PERFECT_SCORE) {
      const distance = Math.abs(start - predictedStart);
      if (nearest === null || distance < nearest.distance) {
        nearest = { start, end, lineSlice, distance };
        if (distance === 0) break;
      }
    }
  }

  return nearest;
}

type RawCandidate = { start: number; end: number; lineSlice: string[] };

type ScoredBest = {
  start: number;
  end: number;
  tokenScore: number;
  positionalScore: number;
  combinedScore: number;
};

/**
 * Deduplicate, cap, and score a candidate pool, then return the best and
 * second-best non-overlapping results via a greedy accept pass.
 *
 * Deduplication steps (in order):
 *   1. Remove candidates with duplicate (start, end) pairs.
 *   2. For candidates sharing identical line content (same joined text), keep
 *      only the one nearest to `predictedStart`.
 *   3. Sort remaining candidates by proximity to `predictedStart` and truncate
 *      to `maxCandidates`.
 *
 * Scoring:
 *   All pool entries are scored; the loop exits early when a candidate reaches
 *   a perfect combined score (1.0).
 *
 * Overlap suppression:
 *   After scoring, candidates are sorted by combined score (descending) and
 *   accepted greedily: a candidate is rejected when its range is fully
 *   contained within an already-accepted higher-scoring candidate's range.
 *   The top-2 accepted, non-overlapping candidates are returned so the
 *   caller can apply epsilon tie-handling correctly.
 */
function scorePool(
  ctx: ContextItem,
  candidates: RawCandidate[],
  totalLines: number,
  effectiveTokenWeight: number,
  effectivePositionalWeight: number,
  changeDensity: number,
  predictedStart: number,
  maxCandidates: number,
): { best: ScoredBest | null; secondBestScore: number } {
  const oldStart = ctx.lineRange.start;
  const oldEnd = ctx.lineRange.end;

  const seenRanges = new Set<string>();
  const dedupeByRange: RawCandidate[] = [];
  for (const c of candidates) {
    const key = `${c.start}:${c.end}`;
    if (!seenRanges.has(key)) {
      seenRanges.add(key);
      dedupeByRange.push(c);
    }
  }

  const seenContent = new Map<string, { candidate: RawCandidate; distance: number }>();
  for (const c of dedupeByRange) {
    const contentKey = c.lineSlice.join("\n");
    const distance = Math.abs(c.start - predictedStart);
    const existing = seenContent.get(contentKey);
    if (!existing || distance < existing.distance) {
      seenContent.set(contentKey, { candidate: c, distance });
    }
  }

  let pool = Array.from(seenContent.values())
    .map((v) => v.candidate)
    .sort(
      (a, b) =>
        Math.abs(a.start - predictedStart) - Math.abs(b.start - predictedStart),
    );

  if (pool.length > maxCandidates) {
    pool = pool.slice(0, maxCandidates);
  }

  const allScored: ScoredBest[] = [];

  for (const candidate of pool) {
    const tokenScore = scoreTokenSimilarity(
      ctx.tokenHash,
      candidate.lineSlice,
      ctx.originalLines,
    );
    const positionalScore = scorePositionalProximity(
      [oldStart, oldEnd],
      [candidate.start, candidate.end],
      totalLines,
    );
    let combinedScore =
      effectiveTokenWeight * tokenScore + effectivePositionalWeight * positionalScore;

    if (changeDensity > CHANGE_DENSITY_DAMPENING_THRESHOLD) {
      combinedScore *= 1 - changeDensity * 0.5;
    }

    allScored.push({ start: candidate.start, end: candidate.end, tokenScore, positionalScore, combinedScore });

    if (combinedScore >= PERFECT_SCORE) {
      break;
    }
  }

  allScored.sort((a, b) => b.combinedScore - a.combinedScore);

  const accepted: ScoredBest[] = [];
  for (const s of allScored) {
    const overlapped = accepted.some(
      (a) =>
        (a.start <= s.start && a.end >= s.end) ||
        (s.start <= a.start && s.end >= a.end),
    );
    if (!overlapped) {
      accepted.push(s);
      if (accepted.length >= 2) break;
    }
  }

  return {
    best: accepted[0] ?? null,
    secondBestScore: accepted[1]?.combinedScore ?? -1,
  };
}

/**
 * Map a list of `ContextItem` objects to their best matching positions in
 * `newFileContent`, guided by `diffResult`.
 *
 * Search strategy — three passes in order, stopping at the first pass that
 * produces a candidate with score ≥ `uncertainMin`:
 *   1. Initial window: `predictedStart ± searchWindowLines`
 *   2. Expanded window: `predictedStart ± searchWindowLines × windowExpansionFactor`
 *      (skipped when `windowExpansionFactor === 1`)
 *   3. Full-file scan: entire new file (always run as last resort)
 *
 * Within each pass, an exact-hash pre-scan short-circuits candidate pool
 * construction when an exact match is found at the original range length.
 *
 * Scoring formula: `effectiveTokenWeight * tokenSimilarity + effectivePositionalWeight * positionalProximity`
 *
 * Default thresholds (configurable via `confidenceThresholds`):
 *   - confidence > 0.85  → "mapped"
 *   - confidence >= 0.60 → "uncertain"
 *   - confidence < 0.60  → "orphaned"
 *
 * Epsilon tie-handling: if the top-two non-overlapping candidate scores differ
 * by less than `epsilon` (default 0.03), a "mapped" result is downgraded to
 * "uncertain".
 *
 * Deleted contexts (all covering hunks are "removed") immediately produce an
 * "orphaned" result with no `newLineRange`.
 *
 * All logic is pure and deterministic — no I/O, no randomness, no side effects.
 *
 * Pass an `options` object to override any of the default tuning constants.
 */
export function mapContexts(
  contexts: ContextItem[],
  newFileContent: string,
  diffResult: DiffResult,
  options?: MapContextsOptions,
): MappingResult[] {
  const searchWindowLines = options?.searchWindowLines ?? DEFAULT_SEARCH_WINDOW_LINES;
  const rangeLengthTolerance = options?.rangeLengthTolerance ?? DEFAULT_RANGE_LENGTH_TOLERANCE;
  const tokenWeight = options?.tokenWeight ?? DEFAULT_TOKEN_WEIGHT;
  const positionalWeight = options?.positionalWeight ?? DEFAULT_POSITIONAL_WEIGHT;
  const epsilon = options?.epsilon ?? DEFAULT_EPSILON;
  const maxCandidates = options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const windowExpansionFactor = options?.windowExpansionFactor ?? DEFAULT_WINDOW_EXPANSION_FACTOR;
  const isLikelyAIChange = options?.isLikelyAIChange ?? false;
  const mappedThreshold = options?.confidenceThresholds?.mapped ?? DEFAULT_MAPPED_THRESHOLD;
  const uncertainMin = options?.confidenceThresholds?.uncertain ?? DEFAULT_UNCERTAIN_MIN;

  if (searchWindowLines <= 0) {
    throw new RangeError(
      `searchWindowLines must be > 0, got ${searchWindowLines}`,
    );
  }
  if (rangeLengthTolerance < 0 || rangeLengthTolerance > 1) {
    throw new RangeError(
      `rangeLengthTolerance must be in [0, 1], got ${rangeLengthTolerance}`,
    );
  }
  if (tokenWeight < 0 || tokenWeight > 1) {
    throw new RangeError(
      `tokenWeight must be in [0, 1], got ${tokenWeight}`,
    );
  }
  if (positionalWeight < 0 || positionalWeight > 1) {
    throw new RangeError(
      `positionalWeight must be in [0, 1], got ${positionalWeight}`,
    );
  }
  if (Math.abs(tokenWeight + positionalWeight - 1) > 0.001) {
    throw new RangeError(
      `tokenWeight + positionalWeight must equal 1 (±0.001), got ${tokenWeight + positionalWeight}`,
    );
  }
  if (epsilon < 0) {
    throw new RangeError(`epsilon must be >= 0, got ${epsilon}`);
  }
  if (maxCandidates < 1) {
    throw new RangeError(`maxCandidates must be >= 1, got ${maxCandidates}`);
  }
  if (windowExpansionFactor < 1) {
    throw new RangeError(`windowExpansionFactor must be >= 1, got ${windowExpansionFactor}`);
  }

  let effectiveTokenWeight = tokenWeight;
  let effectivePositionalWeight = positionalWeight;
  if (isLikelyAIChange) {
    const reduction = positionalWeight * AI_POSITIONAL_WEIGHT_REDUCTION;
    effectiveTokenWeight = tokenWeight + reduction;
    effectivePositionalWeight = positionalWeight - reduction;
  }

  const changeDensity = diffResult.stats?.changeDensity ?? 0;

  const lines = newFileContent.split("\n");
  const totalLines = lines.length;

  return contexts.map((ctx): MappingResult => {
    const oldStart = ctx.lineRange.start;
    const oldEnd = ctx.lineRange.end;
    const originalLength = oldEnd - oldStart + 1;

    const { offset, isDeleted } = computeDiffOffsets(oldStart, oldEnd, diffResult);

    if (isDeleted) {
      return {
        contextId: ctx.id,
        confidence: 0,
        status: "orphaned",
        scoreBreakdown: { token: 0, position: 0 },
      };
    }

    const predictedStart = oldStart + offset;
    const initialWindowStart = predictedStart - searchWindowLines;
    const initialWindowEnd = predictedStart + searchWindowLines;

    const searchPasses: Array<[number, number]> = [
      [initialWindowStart, initialWindowEnd],
    ];

    if (windowExpansionFactor > 1) {
      const expandedStart = predictedStart - searchWindowLines * windowExpansionFactor;
      const expandedEnd = predictedStart + searchWindowLines * windowExpansionFactor;
      if (expandedStart < initialWindowStart || expandedEnd > initialWindowEnd) {
        searchPasses.push([expandedStart, expandedEnd]);
      }
    }

    searchPasses.push([1, totalLines]);

    let best: ScoredBest | null = null;
    let secondBestScore = -1;

    for (const [wStart, wEnd] of searchPasses) {
      const exactMatch = quickExactMatchScan(
        lines,
        originalLength,
        wStart,
        wEnd,
        ctx.tokenHash,
        predictedStart,
      );

      if (exactMatch !== null) {
        const positionalScore = scorePositionalProximity(
          [oldStart, oldEnd],
          [exactMatch.start, exactMatch.end],
          totalLines,
        );
        let combinedScore = effectiveTokenWeight * PERFECT_SCORE + effectivePositionalWeight * positionalScore;
        if (changeDensity > CHANGE_DENSITY_DAMPENING_THRESHOLD) {
          combinedScore *= 1 - changeDensity * 0.5;
        }
        if (combinedScore >= PERFECT_SCORE) {
          best = { start: exactMatch.start, end: exactMatch.end, tokenScore: 1.0, positionalScore, combinedScore };
          secondBestScore = -1;
          break;
        }
        // Combined score is below 1.0 — fall through to full pool scoring so that
        // a better-positioned near-exact candidate can still win.
      }

      const candidates = gatherCandidates(
        lines,
        originalLength,
        wStart,
        wEnd,
        rangeLengthTolerance,
      );

      if (candidates.length === 0) continue;

      const result = scorePool(
        ctx,
        candidates,
        totalLines,
        effectiveTokenWeight,
        effectivePositionalWeight,
        changeDensity,
        predictedStart,
        maxCandidates,
      );

      if (result.best !== null) {
        if (best === null || result.best.combinedScore > best.combinedScore) {
          best = result.best;
          secondBestScore = result.secondBestScore;
        }
        if (best.combinedScore >= uncertainMin) {
          break;
        }
      }
    }

    if (best === null || best.combinedScore < 0) {
      return {
        contextId: ctx.id,
        confidence: 0,
        status: "orphaned",
      };
    }

    let status = classifyStatus(best.combinedScore, mappedThreshold, uncertainMin);

    if (
      status === "mapped" &&
      secondBestScore >= 0 &&
      Math.abs(best.combinedScore - secondBestScore) < epsilon
    ) {
      status = "uncertain";
    }

    const scoreBreakdown: ScoreBreakdown = {
      token: best.tokenScore,
      position: best.positionalScore,
    };

    if (status === "orphaned") {
      return {
        contextId: ctx.id,
        confidence: best.combinedScore,
        status: "orphaned",
        scoreBreakdown,
      };
    }

    return {
      contextId: ctx.id,
      newLineRange: { start: best.start, end: best.end },
      confidence: best.combinedScore,
      status,
      scoreBreakdown,
    };
  });
}
