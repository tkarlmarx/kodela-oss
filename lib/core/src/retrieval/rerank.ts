// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Retrieval reranking (Phase 0 — retrieval quality).
 *
 * Kodela already resolves candidates via keyword scoring + vector cosine + RRF
 * fusion (see the MCP `query` tool and `semantic-search`). What was missing is a
 * **rerank stage**: a second pass that re-scores a small candidate set with
 * richer, field-aware signals so the *most relevant* item rises to the top —
 * the single biggest quality lever a retrieval stack has.
 *
 * This is the OFFLINE, dependency-free default reranker: a transparent,
 * deterministic feature blend (vector similarity + field-weighted lexical
 * overlap + exact-phrase + recency + why-authority). It runs in the Community
 * Edition with no model download and no API key. The `Reranker` seam lets a
 * heavier cross-encoder (a Pro power-up) slot in later without touching callers.
 *
 * Why a feature reranker and not "just trust cosine": cosine alone ignores
 * exact identifiers, which field a term matched (a hit in the *intent* is worth
 * more than one buried in a tag), how fresh the memory is, and Kodela's bias
 * toward ratified decisions. Blending these is what turns "semantically near"
 * into "actually the answer".
 */

/** A store-neutral candidate to be reranked. Callers map their hits to this. */
export interface RerankCandidate {
  id: string;
  /** Primary body text (the annotation note / decision body). */
  text: string;
  /** Optional high-signal fields; matches here are weighted above the body. */
  fields?: {
    title?: string;
    intent?: string;
    summary?: string;
    reasoning?: string;
    tags?: string[];
    filePath?: string;
  };
  /** Query↔candidate vector cosine in [-1, 1], if a vector index was available. */
  similarity?: number;
  /** ISO timestamp for the recency signal. */
  createdAt?: string;
  /** risk/severity — feeds the authority signal. */
  severity?: string;
  /** decision | entry | session | … — decisions get a small authority boost. */
  kind?: string;
}

export interface RerankSignals {
  /** Normalised vector similarity in [0,1], or null when no vector was present. */
  sim: number | null;
  /** Field-weighted lexical overlap in [0,1]. */
  lex: number;
  /** Exact-phrase / identifier match boost in [0,1]. */
  exact: number;
  /** Recency in [0,1] (1 = brand new, decays with age). */
  recency: number;
  /** why-authority in [0,1] (decisions + high severity rank up). */
  authority: number;
}

export interface RerankedHit {
  id: string;
  /** Final blended relevance in [0,1]. */
  score: number;
  signals: RerankSignals;
  /** 1-based position after reranking. */
  rank: number;
}

export interface RerankWeights {
  sim: number;
  lex: number;
  exact: number;
  recency: number;
  authority: number;
}

/** Sensible defaults — vector + lexical carry the signal; the rest are tie-breakers. */
export const DEFAULT_WEIGHTS: RerankWeights = {
  sim: 0.45,
  lex: 0.35,
  exact: 0.1,
  recency: 0.05,
  authority: 0.05,
};

export interface RerankOptions {
  weights?: Partial<RerankWeights>;
  /** Reference "now" (ms) for recency; defaults to Date.now(). Pass for determinism. */
  now?: number;
  /** Recency half-life in days (older-than → decays). Default 45. */
  halfLifeDays?: number;
  /**
   * MMR diversity in [0,1]. 0 (default) = pure relevance; >0 trades some
   * relevance for novelty so near-duplicate memories don't dominate the top-K.
   */
  mmrLambda?: number;
  /** Truncate to this many results after reranking. */
  limit?: number;
}

// ── tokenisation (shared, deterministic) ─────────────────────────────────────

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "was", "were", "be", "with", "that", "this", "it", "as", "at", "by", "we",
  "how", "what", "why", "which", "when", "does", "do", "did",
]);

export function tokenize(text: unknown): string[] {
  // Defensive: candidate fields come from arbitrary stored entries, some of
  // which carry a structured `summary` object instead of a string. Coercing a
  // non-string here (rather than throwing) keeps the reranker — the default
  // retrieval path for search/recall/Ask — robust to malformed candidates.
  if (typeof text !== "string") return [];
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
    (t) => t.length >= 2 && !STOP.has(t),
  );
}

function fieldWeightedTexts(c: RerankCandidate): Array<{ text: string; weight: number }> {
  const f = c.fields ?? {};
  const out: Array<{ text: string; weight: number }> = [];
  if (f.title) out.push({ text: f.title, weight: 3 });
  if (f.intent) out.push({ text: f.intent, weight: 3 });
  if (f.summary) out.push({ text: f.summary, weight: 2.5 });
  out.push({ text: c.text, weight: 2 });
  if (f.reasoning) out.push({ text: f.reasoning, weight: 1.5 });
  if (f.tags && f.tags.length) out.push({ text: f.tags.join(" "), weight: 1.5 });
  if (f.filePath) out.push({ text: f.filePath, weight: 1 });
  return out;
}

/**
 * Field-weighted lexical overlap: what fraction of the query's meaningful terms
 * are covered, weighted by which field they hit. Squashed to [0,1].
 */
function lexicalScore(queryTerms: string[], c: RerankCandidate): number {
  if (queryTerms.length === 0) return 0;
  const qset = new Set(queryTerms);
  // Best field-weight at which each query term appears anywhere in the candidate.
  const best = new Map<string, number>();
  for (const { text, weight } of fieldWeightedTexts(c)) {
    for (const tok of tokenize(text)) {
      if (qset.has(tok)) best.set(tok, Math.max(best.get(tok) ?? 0, weight));
    }
  }
  if (best.size === 0) return 0;
  // Coverage (how many query terms matched) × average field weight, normalised.
  let weightSum = 0;
  for (const w of best.values()) weightSum += w;
  const coverage = best.size / qset.size; // [0,1]
  const avgWeight = weightSum / best.size; // ~[1,3]
  const norm = Math.min(1, avgWeight / 3); // [0,1]
  return coverage * (0.5 + 0.5 * norm); // reward both coverage and where it hit
}

/** Exact phrase / multi-term-adjacent boost. */
function exactScore(query: string, c: RerankCandidate): number {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return 0;
  const hay = [
    c.fields?.title,
    c.fields?.intent,
    c.fields?.summary,
    c.text,
    c.fields?.reasoning,
    (c.fields?.tags ?? []).join(" "),
  ]
    .filter(Boolean)
    .join("  ")
    .toLowerCase();
  if (hay.includes(q)) return 1;
  // Partial: longest run of consecutive query tokens that appears verbatim.
  const qt = tokenize(query);
  for (let len = qt.length; len >= 2; len--) {
    for (let i = 0; i + len <= qt.length; i++) {
      if (hay.includes(qt.slice(i, i + len).join(" "))) return len / qt.length;
    }
  }
  return 0;
}

function recencyScore(createdAt: string | undefined, now: number, halfLifeDays: number): number {
  if (!createdAt) return 0.5; // unknown age → neutral
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0.5;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays); // 1 at age 0, 0.5 at half-life
}

function authorityScore(c: RerankCandidate): number {
  let s = 0.4;
  if ((c.kind ?? "").toLowerCase() === "decision") s += 0.35;
  const sev = (c.severity ?? "").toLowerCase();
  if (sev === "critical") s += 0.25;
  else if (sev === "high") s += 0.15;
  else if (sev === "medium") s += 0.05;
  return Math.min(1, s);
}

// ── the reranker ─────────────────────────────────────────────────────────────

/**
 * Rerank a candidate set with the offline feature blend. Pure + deterministic
 * (given `now`). Returns candidates sorted by blended relevance, each carrying
 * its signal breakdown so the UI can explain *why* a result ranked where it did.
 */
export function featureRerank(
  query: string,
  candidates: RerankCandidate[],
  opts: RerankOptions = {},
): RerankedHit[] {
  const weights: RerankWeights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
  const now = opts.now ?? Date.now();
  const halfLife = opts.halfLifeDays ?? 45;
  const queryTerms = tokenize(query);

  const scored = candidates.map((c) => {
    const sim = typeof c.similarity === "number" ? Math.max(0, Math.min(1, (c.similarity + 1) / 2)) : null;
    const lex = lexicalScore(queryTerms, c);
    const exact = exactScore(query, c);
    const recency = recencyScore(c.createdAt, now, halfLife);
    const authority = authorityScore(c);

    // When no vector similarity is present, fold its weight into lexical so the
    // score stays in [0,1] and lexical carries the semantic load.
    let wSim = weights.sim;
    let wLex = weights.lex;
    if (sim === null) {
      wLex += wSim;
      wSim = 0;
    }
    const total = wSim + wLex + weights.exact + weights.recency + weights.authority || 1;
    const score =
      ((sim ?? 0) * wSim +
        lex * wLex +
        exact * weights.exact +
        recency * weights.recency +
        authority * weights.authority) /
      total;

    const signals: RerankSignals = { sim, lex, exact, recency, authority };
    return { id: c.id, score, signals, candidate: c };
  });

  scored.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));

  const ordered =
    opts.mmrLambda && opts.mmrLambda > 0 ? mmrReorder(scored, opts.mmrLambda) : scored;

  const limited = typeof opts.limit === "number" ? ordered.slice(0, Math.max(0, opts.limit)) : ordered;
  return limited.map((s, i) => ({ id: s.id, score: s.score, signals: s.signals, rank: i + 1 }));
}

/** Token-Jaccard between two candidates — the diversity metric for MMR. */
function jaccard(a: RerankCandidate, b: RerankCandidate): number {
  const sa = new Set(tokenize(`${a.text} ${a.fields?.intent ?? ""} ${(a.fields?.tags ?? []).join(" ")}`));
  const sb = new Set(tokenize(`${b.text} ${b.fields?.intent ?? ""} ${(b.fields?.tags ?? []).join(" ")}`));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

interface Scored { id: string; score: number; signals: RerankSignals; candidate: RerankCandidate }

/** Maximal Marginal Relevance: greedily pick relevance − λ·(max sim to chosen). */
function mmrReorder(scored: Scored[], lambda: number): Scored[] {
  const pool = [...scored];
  const chosen: Scored[] = [];
  while (pool.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const rel = pool[i]!.score;
      let maxSim = 0;
      for (const ch of chosen) maxSim = Math.max(maxSim, jaccard(pool[i]!.candidate, ch.candidate));
      const val = (1 - lambda) * rel - lambda * maxSim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    chosen.push(pool.splice(bestIdx, 1)[0]!);
  }
  return chosen;
}

// ── pluggable seam (Pro cross-encoder can implement this later) ──────────────

export interface Reranker {
  readonly id: string;
  readonly offline: boolean;
  rerank(query: string, candidates: RerankCandidate[], opts?: RerankOptions): Promise<RerankedHit[]>;
}

/** The default offline feature reranker as a `Reranker`. */
export function createFeatureReranker(defaults: RerankOptions = {}): Reranker {
  return {
    id: "feature-rerank/v1",
    offline: true,
    rerank: (query, candidates, opts) =>
      Promise.resolve(featureRerank(query, candidates, { ...defaults, ...(opts ?? {}) })),
  };
}
