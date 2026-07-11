// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectContradictionsAsync, cosine } from "./semantic.js";
import type { ContradictionDecision, EmbedFn, JudgeFn } from "./types.js";

const DECISIONS: ContradictionDecision[] = [
  {
    id: "DEC-1",
    title: "Standardize on Postgres for the datastore",
    status: "active",
    decision: "Use Postgres as the primary datastore.",
    reason: "One well-understood relational store; reject document databases.",
  },
];

/**
 * A deterministic bag-of-words embedder over a tiny vocabulary — cosine reflects
 * topical overlap, so tests don't need the real ONNX model.
 */
const VOCAB = ["postgres", "datastore", "database", "document", "elephant", "cache", "readme", "typo", "node"];
const fakeEmbed: EmbedFn = async (text) => {
  const t = text.toLowerCase();
  // "elephant database" is a synonym for Postgres — give it overlapping dims so
  // it lands topically near the Postgres decision without sharing a lexicon word.
  const bag = t.includes("elephant") ? t + " postgres datastore database" : t;
  return VOCAB.map((w) => (bag.includes(w) ? 1 : 0));
};

describe("cosine", () => {
  test("identical vectors → 1, orthogonal → 0", () => {
    assert.ok(Math.abs(cosine([1, 0, 1], [1, 0, 1]) - 1) < 1e-9);
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(cosine([], [1]), 0);
  });
});

describe("detectContradictionsAsync — recall dial", () => {
  test("with no embed/judge, returns exactly the base regex result", async () => {
    const flags = await detectContradictionsAsync({ text: "Add a README typo fix." }, DECISIONS);
    assert.equal(flags.length, 0);
  });

  test("embedding topic-match + judge flags a lexicon-invisible reversal", async () => {
    const judge: JudgeFn = async ({ changeText }) => ({
      isViolation: /switch to|adopt|move to/i.test(changeText),
      confidence: 0.82,
      reason: "The change adopts a document database, reversing the Postgres standardization.",
    });
    const flags = await detectContradictionsAsync(
      { text: "Let's switch to the elephant database for documents." },
      DECISIONS,
      { embed: fakeEmbed, judge, semanticThreshold: 0.3 },
    );
    const f = flags.find((x) => x.kind === "semantic");
    assert.ok(f, "expected a judge-confirmed semantic flag");
    assert.equal(f!.decisionId, "DEC-1");
    assert.equal(f!.confidence, 0.82);
  });

  test("judge that clears the change adds no flag (precision preserved)", async () => {
    const judge: JudgeFn = async () => ({ isViolation: false, confidence: 0.1, reason: "unrelated" });
    const flags = await detectContradictionsAsync(
      { text: "Tune the elephant database connection pool." },
      DECISIONS,
      { embed: fakeEmbed, judge, semanticThreshold: 0.3 },
    );
    assert.equal(flags.filter((f) => f.kind === "semantic").length, 0);
  });

  test("semanticReview surfaces low-confidence candidates when no judge is wired", async () => {
    const flags = await detectContradictionsAsync(
      { text: "Migrate to the elephant database." },
      DECISIONS,
      { embed: fakeEmbed, semanticThreshold: 0.3, semanticReview: true },
    );
    const f = flags.find((x) => x.kind === "semantic");
    assert.ok(f, "expected a review candidate");
    assert.equal(f!.confidence, 0.4);
    assert.match(f!.reason, /review/i);
  });

  test("a topically-unrelated change produces no semantic candidate", async () => {
    const flags = await detectContradictionsAsync(
      { text: "Fix a README typo and bump the node version." },
      DECISIONS,
      { embed: fakeEmbed, semanticThreshold: 0.5, semanticReview: true },
    );
    assert.equal(flags.length, 0);
  });

  test("base regex flags are always kept alongside semantic ones", async () => {
    const decisions: ContradictionDecision[] = [
      ...DECISIONS,
      { id: "DEC-2", title: "Reject MongoDB", status: "active", decision: "Do not use MongoDB.", reason: "We reject MongoDB." },
    ];
    const judge: JudgeFn = async () => ({ isViolation: true, confidence: 0.8, reason: "semantic reversal" });
    const flags = await detectContradictionsAsync(
      { text: "Reintroduce MongoDB and also move to the elephant database." },
      decisions,
      { embed: fakeEmbed, judge, semanticThreshold: 0.3 },
    );
    assert.ok(flags.some((f) => f.decisionId === "DEC-2" && f.kind === "polarity"), "regex MongoDB flag kept");
    assert.ok(flags.some((f) => f.kind === "semantic"), "semantic flag added");
  });
});
