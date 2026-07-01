// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Retrieval evaluation harness (Phase 0 — retrieval quality).
 *
 * Turns "is our retrieval good?" from a vibe into a number. Given a corpus of
 * documents + graded-relevance queries (qrels), it runs any `RetrieveFn` and
 * reports recall@k / precision@k / MRR / nDCG@k. The point is to *prove* a
 * change helps: run the lexical baseline and the feature reranker over the same
 * corpus and compare (see `retrieval.eval.test.ts`).
 *
 * It is retrieval-fn-agnostic, so the same harness measures the CLI search path,
 * the MCP query path, or a future cross-encoder — and can run in CI on a seeded
 * golden corpus, with no network.
 */
import {
  featureRerank,
  tokenize,
  type RerankCandidate,
  type RerankOptions,
} from "./rerank.js";
import { cosineSimilarity, embedTextLocal } from "../semantic-search/index.js";
import {
  meanReciprocalRank,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  round,
} from "./metrics.js";

/** A graded-relevance query: `relevant` maps doc id → gain (>0 relevant). */
export interface EvalQuery {
  id: string;
  query: string;
  relevant: Record<string, number>;
}

export interface EvalCorpus {
  name: string;
  documents: RerankCandidate[];
  queries: EvalQuery[];
}

/** Anything that, given a query and the corpus docs, returns doc ids best-first. */
export type RetrieveFn = (query: string, docs: RerankCandidate[]) => string[] | Promise<string[]>;

export interface PerQueryResult {
  queryId: string;
  recallAtK: number;
  precisionAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
}

export interface EvalResult {
  corpus: string;
  retriever: string;
  k: number;
  queries: number;
  recallAtK: number;
  precisionAtK: number;
  mrr: number;
  ndcgAtK: number;
  perQuery: PerQueryResult[];
}

/** Run `retrieve` over every query in the corpus and aggregate the metrics. */
export async function evaluate(
  corpus: EvalCorpus,
  retrieve: RetrieveFn,
  opts: { k?: number; retrieverName?: string } = {},
): Promise<EvalResult> {
  const k = opts.k ?? 5;
  const perQuery: PerQueryResult[] = [];
  const mrrInputs: Array<{ ranked: string[]; relevant: Set<string> }> = [];

  for (const q of corpus.queries) {
    const ranked = await retrieve(q.query, corpus.documents);
    const relevant = new Set(Object.keys(q.relevant).filter((id) => (q.relevant[id] ?? 0) > 0));
    const gains = new Map(Object.entries(q.relevant));
    mrrInputs.push({ ranked, relevant });
    perQuery.push({
      queryId: q.id,
      recallAtK: round(recallAtK(ranked, relevant, k)),
      precisionAtK: round(precisionAtK(ranked, relevant, k)),
      reciprocalRank: round(rr(ranked, relevant)),
      ndcgAtK: round(ndcgAtK(ranked, gains, k)),
    });
  }

  const avg = (sel: (p: PerQueryResult) => number): number =>
    perQuery.length ? round(perQuery.reduce((s, p) => s + sel(p), 0) / perQuery.length) : 0;

  return {
    corpus: corpus.name,
    retriever: opts.retrieverName ?? "custom",
    k,
    queries: perQuery.length,
    recallAtK: avg((p) => p.recallAtK),
    precisionAtK: avg((p) => p.precisionAtK),
    mrr: round(meanReciprocalRank(mrrInputs)),
    ndcgAtK: avg((p) => p.ndcgAtK),
    perQuery,
  };
}

function rr(ranked: string[], relevant: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) if (relevant.has(ranked[i]!)) return 1 / (i + 1);
  return 0;
}

// ── baseline retrievers (for A/B comparison in the harness) ──────────────────

/**
 * Naive lexical baseline: rank by count of query terms that appear anywhere in
 * the document body/fields. This is the "before" the reranker must beat.
 */
export const lexicalRetrieve: RetrieveFn = (query, docs) => {
  const qt = new Set(tokenize(query));
  return docs
    .map((d) => {
      const hay = tokenize(
        [d.text, d.fields?.intent, d.fields?.summary, d.fields?.reasoning, (d.fields?.tags ?? []).join(" "), d.fields?.title]
          .filter(Boolean)
          .join(" "),
      );
      let hits = 0;
      const seen = new Set<string>();
      for (const t of hay) if (qt.has(t) && !seen.has(t)) { hits++; seen.add(t); }
      return { id: d.id, hits };
    })
    .sort((a, b) => b.hits - a.hits || a.id.localeCompare(b.id))
    .map((x) => x.id);
};

/** The feature reranker as a `RetrieveFn` (over the full doc set). */
export function featureRerankRetrieve(opts: RerankOptions = {}): RetrieveFn {
  return (query, docs) => featureRerank(query, docs, opts).map((h) => h.id);
}

/**
 * The realistic offline production path: compute an on-device embedding
 * similarity for each doc (the dependency-free hash embedder — the same engine
 * the CE ships) and feed it as the `similarity` signal into the feature
 * reranker. This is what `kodela search` / the MCP query path do end-to-end.
 */
export function hybridRerankRetrieve(opts: RerankOptions = {}): RetrieveFn {
  return (query, docs) => {
    const qv = embedTextLocal(query);
    const withSim = docs.map((d) => ({
      ...d,
      similarity:
        typeof d.similarity === "number"
          ? d.similarity
          : cosineSimilarity(qv, embedTextLocal(`${d.fields?.intent ?? ""} ${d.fields?.title ?? ""} ${d.text}`)),
    }));
    return featureRerank(query, withSim, opts).map((h) => h.id);
  };
}
