// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Retrieval benchmark (Phase 4 — P4.2).
 *
 * A reproducible, publishable benchmark of Kodela's *why-retrieval* quality: it
 * runs the eval harness over the seeded golden corpus for three retrievers —
 * lexical baseline, the offline feature reranker, and the hybrid (on-device
 * embedding + rerank) — and reports recall@k / precision@k / MRR / nDCG@k for
 * each, plus the reranker's lift over the baseline.
 *
 * Deterministic: `now` is injected so the recency signal is fixed and the
 * numbers are identical run-to-run (which is what makes them publishable). This
 * powers `scripts/bench/retrieval-benchmark.ts`, the README table, and a CI
 * reality-check.
 */

import { evaluate, lexicalRetrieve, featureRerankRetrieve, hybridRerankRetrieve } from "./eval.js";
import { GOLDEN_CORPUS } from "./golden-corpus.js";
import { round } from "./metrics.js";

export interface BenchmarkRow {
  retriever: string;
  recallAtK: number;
  precisionAtK: number;
  mrr: number;
  ndcgAtK: number;
}

export interface BenchmarkResult {
  corpus: string;
  k: number;
  queries: number;
  rows: BenchmarkRow[];
  /** Lift of the feature reranker over the lexical baseline. */
  lift: { mrr: number; ndcgAtK: number };
}

export interface BenchmarkOptions {
  k?: number;
  /** Fixed "now" (epoch ms) so recency — and the whole result — is reproducible. */
  now?: number;
}

/** Default benchmark timestamp — pinned so published numbers never drift. */
export const BENCHMARK_NOW = Date.parse("2026-06-15T00:00:00Z");

export async function runRetrievalBenchmark(opts: BenchmarkOptions = {}): Promise<BenchmarkResult> {
  const k = opts.k ?? 5;
  const now = opts.now ?? BENCHMARK_NOW;

  const [lexical, rerank, hybrid] = await Promise.all([
    evaluate(GOLDEN_CORPUS, lexicalRetrieve, { k, retrieverName: "lexical baseline" }),
    evaluate(GOLDEN_CORPUS, featureRerankRetrieve({ now }), { k, retrieverName: "+ feature rerank (offline)" }),
    evaluate(GOLDEN_CORPUS, hybridRerankRetrieve({ now }), { k, retrieverName: "+ hybrid (embed + rerank)" }),
  ]);

  const toRow = (r: typeof lexical): BenchmarkRow => ({
    retriever: r.retriever,
    recallAtK: r.recallAtK,
    precisionAtK: r.precisionAtK,
    mrr: r.mrr,
    ndcgAtK: r.ndcgAtK,
  });

  return {
    corpus: lexical.corpus,
    k,
    queries: lexical.queries,
    rows: [toRow(lexical), toRow(rerank), toRow(hybrid)],
    lift: {
      mrr: round(rerank.mrr - lexical.mrr),
      ndcgAtK: round(rerank.ndcgAtK - lexical.ndcgAtK),
    },
  };
}

/** Render the benchmark as a markdown table (for the README / writeup / CI). */
export function formatBenchmarkMarkdown(result: BenchmarkResult): string {
  const lines: string[] = [];
  lines.push(`### Kodela why-retrieval benchmark`);
  lines.push("");
  lines.push(
    `Corpus: \`${result.corpus}\` · ${result.queries} graded queries · metrics @${result.k}. ` +
      `Deterministic (fixed clock), so these numbers reproduce exactly.`,
  );
  lines.push("");
  lines.push("| retriever | recall@k | precision@k | MRR | nDCG@k |");
  lines.push("|---|--:|--:|--:|--:|");
  for (const r of result.rows) {
    const bold = r.retriever.startsWith("+ feature") ? "**" : "";
    lines.push(
      `| ${bold}${r.retriever}${bold} | ${bold}${r.recallAtK.toFixed(2)}${bold} | ${bold}${r.precisionAtK.toFixed(2)}${bold} | ${bold}${r.mrr.toFixed(2)}${bold} | ${bold}${r.ndcgAtK.toFixed(2)}${bold} |`,
    );
  }
  lines.push("");
  lines.push(
    `The offline feature reranker lifts **MRR by +${result.lift.mrr.toFixed(2)}** and ` +
      `**nDCG@${result.k} by +${result.lift.ndcgAtK.toFixed(2)}** over the lexical baseline — ` +
      `with no API key and nothing leaving the machine.`,
  );
  return lines.join("\n") + "\n";
}
