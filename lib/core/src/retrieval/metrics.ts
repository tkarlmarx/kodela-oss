// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Standard information-retrieval metrics (Phase 0 — retrieval quality).
 *
 * Retrieval quality was previously unmeasured in Kodela. These are the yardsticks
 * the eval harness (`eval.ts`) uses to prove a change (e.g. adding the reranker)
 * actually *improves* which memories surface — the discipline that keeps
 * "semantic search" from being a vibe.
 *
 * All functions take a `ranked` list of candidate ids (best-first) and a notion
 * of relevance, and are pure.
 */

/** Fraction of the relevant set that appears in the top-k. */
export function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const top = ranked.slice(0, k);
  let hit = 0;
  for (const id of top) if (relevant.has(id)) hit++;
  return hit / relevant.size;
}

/** Fraction of the top-k that are relevant. */
export function precisionAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (k <= 0) return 0;
  const top = ranked.slice(0, k);
  if (top.length === 0) return 0;
  let hit = 0;
  for (const id of top) if (relevant.has(id)) hit++;
  return hit / top.length;
}

/** Reciprocal rank of the first relevant result (0 if none). */
export function reciprocalRank(ranked: string[], relevant: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i]!)) return 1 / (i + 1);
  }
  return 0;
}

/** Mean reciprocal rank over many queries. */
export function meanReciprocalRank(
  perQuery: Array<{ ranked: string[]; relevant: Set<string> }>,
): number {
  if (perQuery.length === 0) return 0;
  let sum = 0;
  for (const q of perQuery) sum += reciprocalRank(q.ranked, q.relevant);
  return sum / perQuery.length;
}

/**
 * Normalised discounted cumulative gain at k, for graded relevance
 * (`gains`: id → gain, gain 0 = irrelevant). Rewards putting the *most*
 * relevant items highest, not just any relevant item.
 */
export function ndcgAtK(ranked: string[], gains: Map<string, number>, k: number): number {
  const dcg = (ids: string[]): number => {
    let s = 0;
    for (let i = 0; i < Math.min(k, ids.length); i++) {
      const g = gains.get(ids[i]!) ?? 0;
      if (g > 0) s += (Math.pow(2, g) - 1) / Math.log2(i + 2);
    }
    return s;
  };
  const ideal = [...gains.entries()]
    .filter(([, g]) => g > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  const idcg = dcg(ideal);
  return idcg === 0 ? 0 : dcg(ranked) / idcg;
}

export function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
