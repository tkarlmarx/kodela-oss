// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 0 retrieval-quality tests — metrics correctness, reranker behaviour, and
 * the headline reality check: the feature reranker measurably beats the lexical
 * baseline on the seeded golden corpus (higher MRR + nDCG). If a future change
 * regresses retrieval, this suite fails.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  recallAtK,
  precisionAtK,
  reciprocalRank,
  meanReciprocalRank,
  ndcgAtK,
} from "./metrics.js";
import { featureRerank, tokenize, type RerankCandidate } from "./rerank.js";
import {
  evaluate,
  lexicalRetrieve,
  featureRerankRetrieve,
  hybridRerankRetrieve,
} from "./eval.js";
import { GOLDEN_CORPUS } from "./golden-corpus.js";
import { formatRecallBlock, type RecallItem } from "./recall.js";
import { runRetrievalBenchmark, formatBenchmarkMarkdown } from "./benchmark.js";

describe("retrieval benchmark (P4.2)", () => {
  test("is deterministic and shows the reranker lifting over lexical", async () => {
    const a = await runRetrievalBenchmark();
    const b = await runRetrievalBenchmark();
    assert.deepEqual(a.rows, b.rows, "same fixed clock → identical numbers");
    assert.equal(a.rows.length, 3);
    const [lexical, rerank] = a.rows;
    assert.match(lexical!.retriever, /lexical/);
    assert.ok(rerank!.mrr >= lexical!.mrr, "reranker MRR >= baseline");
    assert.ok(a.lift.mrr >= 0 && a.lift.ndcgAtK >= 0, "non-negative lift");
    // Headline claim the README/writeup publishes must hold.
    assert.ok(rerank!.mrr >= 0.9, `reranker near-perfect MRR on the golden corpus (got ${rerank!.mrr})`);
  });

  test("markdown renderer emits a table with all three retrievers", async () => {
    const md = formatBenchmarkMarkdown(await runRetrievalBenchmark());
    assert.match(md, /why-retrieval benchmark/);
    assert.match(md, /\| retriever \|/);
    assert.match(md, /lexical baseline/);
    assert.match(md, /feature rerank/);
    assert.match(md, /hybrid/);
  });
});

describe("formatRecallBlock (Phase 1 — recall injection)", () => {
  const items: RecallItem[] = [
    { ref: "src/auth/session.ts:5-7", note: "rotation writes the new id here", score: 0.91, tags: ["auth"] },
    { ref: "src/auth/jwt.ts:1-3", note: "verify against the stored id", score: 0.42 },
  ];

  test("renders a numbered, ranked, injectable block", () => {
    const block = formatRecallBlock("token rotation", items);
    assert.match(block, /## Relevant prior context for "token rotation"/);
    assert.match(block, /1\. \*\*src\/auth\/session\.ts:5-7\*\*/);
    assert.match(block, /\[auth\]/);
    assert.match(block, /relevance 0\.91/);
    // Order is preserved as given (the caller ranks; the formatter doesn't).
    assert.ok(block.indexOf("session.ts") < block.indexOf("jwt.ts"));
  });

  test("empty result returns an explicit note, never an empty string", () => {
    const block = formatRecallBlock("nothing here", []);
    assert.match(block, /No prior context captured/);
    assert.ok(block.trim().length > 0);
  });

  test("a custom heading overrides the default and notes are truncated", () => {
    const long = "x".repeat(500);
    const block = formatRecallBlock("q", [{ ref: "a:1-2", note: long }], {
      heading: "## Custom",
      noteMax: 40,
      showScore: false,
    });
    assert.match(block, /## Custom/);
    assert.ok(block.includes("…"), "long notes are ellipsized");
    assert.ok(!block.includes("relevance"), "score hidden when showScore:false");
  });
});

describe("IR metrics", () => {
  test("recall@k and precision@k", () => {
    const ranked = ["a", "b", "c", "d"];
    const rel = new Set(["b", "d", "x"]); // x not retrieved
    assert.equal(recallAtK(ranked, rel, 2), 1 / 3); // only b in top-2
    assert.equal(recallAtK(ranked, rel, 4), 2 / 3); // b + d
    assert.equal(precisionAtK(ranked, rel, 4), 2 / 4);
  });

  test("reciprocal rank + MRR", () => {
    assert.equal(reciprocalRank(["a", "b", "c"], new Set(["b"])), 1 / 2);
    assert.equal(reciprocalRank(["a", "b"], new Set(["z"])), 0);
    assert.equal(
      meanReciprocalRank([
        { ranked: ["a", "b"], relevant: new Set(["a"]) }, // 1
        { ranked: ["a", "b"], relevant: new Set(["b"]) }, // 1/2
      ]),
      0.75,
    );
  });

  test("nDCG rewards ordering by graded relevance", () => {
    const gains = new Map([["a", 3], ["b", 1]]);
    const perfect = ndcgAtK(["a", "b", "c"], gains, 3);
    const swapped = ndcgAtK(["b", "a", "c"], gains, 3);
    assert.equal(perfect, 1);
    assert.ok(swapped < perfect, "putting the lower-gain item first lowers nDCG");
  });
});

describe("featureRerank", () => {
  const cands: RerankCandidate[] = [
    { id: "body", text: "we rate the api limit for login attempts in the job queue", kind: "entry" },
    {
      id: "intent",
      text: "throttle brute force on the endpoint",
      fields: { intent: "Add rate limit to login", title: "Login rate limit", tags: ["auth"] },
      kind: "entry",
      severity: "high",
    },
  ];

  test("a hit in a high-signal field outranks the same terms in the body", () => {
    const hits = featureRerank("rate limit login", cands, { now: Date.parse("2026-06-15T00:00:00Z") });
    assert.equal(hits[0]?.id, "intent");
    assert.equal(hits[0]?.rank, 1);
    assert.ok(hits[0]!.score > hits[1]!.score);
  });

  test("exact-phrase presence contributes a signal", () => {
    const hits = featureRerank("rate limit login", cands, { now: Date.parse("2026-06-15T00:00:00Z") });
    const intent = hits.find((h) => h.id === "intent")!;
    assert.ok(intent.signals.exact > 0, "the exact phrase 'rate limit' is detected in a field");
  });

  test("missing vector similarity is handled (sim=null, still scores on lexical)", () => {
    const hits = featureRerank("login", [{ id: "x", text: "the login page" }]);
    assert.equal(hits[0]?.signals.sim, null);
    assert.ok(hits[0]!.score > 0);
  });

  test("limit truncates and ranks are 1-based contiguous", () => {
    const hits = featureRerank("rate", cands, { limit: 1 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.rank, 1);
  });

  test("tokenize drops stopwords and short tokens", () => {
    assert.deepEqual(tokenize("How does the auth flow work"), ["auth", "flow", "work"]);
  });

  test("tokenize tolerates non-string field text (structured summary object)", () => {
    // Regression: entries can persist `summary` as a structured object; feeding
    // it into a candidate field must not crash the reranker.
    assert.deepEqual(tokenize({ intent: "x" } as unknown as string), []);
    assert.deepEqual(tokenize(undefined as unknown as string), []);
  });

  test("featureRerank does not throw on a candidate with an object-valued field", () => {
    const poisoned: RerankCandidate[] = [
      {
        id: "obj",
        text: "the login rate limiter",
        // A stray object where a string is expected — mirrors a structured summary.
        fields: { summary: { intent: "add rate limit" } as unknown as string },
      },
    ];
    const hits = featureRerank("rate limit", poisoned);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, "obj");
  });
});

describe("eval harness — reranker beats the lexical baseline (reality check)", () => {
  test("feature reranker improves MRR and nDCG over lexical on the golden corpus", async () => {
    const now = Date.parse("2026-06-15T00:00:00Z");
    const base = await evaluate(GOLDEN_CORPUS, lexicalRetrieve, { k: 5, retrieverName: "lexical" });
    const rerank = await evaluate(GOLDEN_CORPUS, featureRerankRetrieve({ now }), {
      k: 5,
      retrieverName: "feature-rerank",
    });

    // The headline claim Phase 0 makes must hold on the seeded ground truth.
    assert.ok(
      rerank.mrr > base.mrr,
      `reranker MRR (${rerank.mrr}) must exceed lexical MRR (${base.mrr})`,
    );
    assert.ok(
      rerank.ndcgAtK >= base.ndcgAtK,
      `reranker nDCG (${rerank.ndcgAtK}) must be >= lexical nDCG (${base.ndcgAtK})`,
    );
    // Sanity: the reranker should get the answer at rank 1 for most trap queries.
    assert.ok(rerank.mrr >= 0.9, `reranker MRR should be near-perfect on this corpus (got ${rerank.mrr})`);
  });

  test("hybrid (on-device embedding similarity + rerank) also beats lexical", async () => {
    const now = Date.parse("2026-06-15T00:00:00Z");
    const base = await evaluate(GOLDEN_CORPUS, lexicalRetrieve, { k: 5 });
    const hybrid = await evaluate(GOLDEN_CORPUS, hybridRerankRetrieve({ now }), { k: 5 });
    assert.ok(
      hybrid.mrr >= base.mrr,
      `hybrid MRR (${hybrid.mrr}) must be >= lexical MRR (${base.mrr})`,
    );
  });
});
