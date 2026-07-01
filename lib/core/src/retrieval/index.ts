// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `@kodela/core` retrieval — the measurable retrieval-quality layer (Phase 0).
 *
 * A pluggable reranker (offline feature blend by default), standard IR metrics,
 * and an eval harness with a seeded golden corpus so retrieval quality is a
 * number we can improve release-over-release rather than a vibe.
 */
export {
  featureRerank,
  createFeatureReranker,
  tokenize,
  DEFAULT_WEIGHTS,
  type RerankCandidate,
  type RerankOptions,
  type RerankWeights,
  type RerankSignals,
  type RerankedHit,
  type Reranker,
} from "./rerank.js";

export {
  recallAtK,
  precisionAtK,
  reciprocalRank,
  meanReciprocalRank,
  ndcgAtK,
  round,
} from "./metrics.js";

export {
  evaluate,
  lexicalRetrieve,
  featureRerankRetrieve,
  hybridRerankRetrieve,
  type EvalQuery,
  type EvalCorpus,
  type EvalResult,
  type PerQueryResult,
  type RetrieveFn,
} from "./eval.js";

export { GOLDEN_CORPUS } from "./golden-corpus.js";

export {
  formatRecallBlock,
  type RecallItem,
  type RecallBlockOptions,
} from "./recall.js";

export {
  runRetrievalBenchmark,
  formatBenchmarkMarkdown,
  BENCHMARK_NOW,
  type BenchmarkResult,
  type BenchmarkRow,
  type BenchmarkOptions,
} from "./benchmark.js";
