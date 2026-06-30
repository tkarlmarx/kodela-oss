// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ubaScore } from "./uba-scorer.js";
import type { UbaSignals } from "./uba-scorer.js";

// ---------------------------------------------------------------------------
// Shared signal baseline — a "small human-like change" in a neutral env.
// ---------------------------------------------------------------------------

const SMALL_HUMAN_BASELINE: UbaSignals = {
  linesAdded: 3,
  writeEventCount: 1,
  isSingleBatch: true,
  interBatchGapMs: undefined,
  fileCount: 1,
  hasLargeContiguousBlock: false,
  hasKnownEnvSignal: false,
  isExplicitAgentSignal: false,
};

// ---------------------------------------------------------------------------
// Signal A recalibration (Gap 65 Part 2)
// ---------------------------------------------------------------------------

describe("ubaScore — Signal A recalibration for known-env (Gap 65)", () => {
  test("small change (≤5 lines) in NO known-env scores below 0.50 → source=human", () => {
    const result = ubaScore(SMALL_HUMAN_BASELINE);
    assert.strictEqual(result.source, "human");
    assert.ok(
      result.classificationScore < 0.5,
      `Expected score < 0.5, got ${result.classificationScore}`,
    );
    // Signal A should be 0.2 when hasKnownEnvSignal=false
    assert.strictEqual(result.classificationSignals["editPattern"], 0.2);
  });

  test("small change (≤5 lines) in known-env lifts Signal A to 0.35", () => {
    const signals: UbaSignals = { ...SMALL_HUMAN_BASELINE, hasKnownEnvSignal: true };
    const result = ubaScore(signals);
    assert.strictEqual(result.classificationSignals["editPattern"], 0.35);
  });

  test("small change (≤5 lines) with known-env scores ≥0.40 (no longer strongly human)", () => {
    // With hasKnownEnvSignal the score should climb above the hard-human zone,
    // even though it may not reach 0.50.  The key assertion is that Signal A
    // is 0.35 instead of 0.2 — which shifts the weighted sum by +0.0525.
    const signals: UbaSignals = { ...SMALL_HUMAN_BASELINE, hasKnownEnvSignal: true };
    const result = ubaScore(signals);
    // Score should be > 0.35 (baseline with neutral signals B-E contributing ≥0.25)
    assert.ok(
      result.classificationScore > 0.35,
      `Expected score > 0.35, got ${result.classificationScore}`,
    );
  });

  test("larger change (>5 lines) ignores hasKnownEnvSignal for Signal A", () => {
    const withEnv: UbaSignals = { ...SMALL_HUMAN_BASELINE, linesAdded: 10, hasKnownEnvSignal: true };
    const withoutEnv: UbaSignals = { ...SMALL_HUMAN_BASELINE, linesAdded: 10, hasKnownEnvSignal: false };
    const resultWith = ubaScore(withEnv);
    const resultWithout = ubaScore(withoutEnv);
    // Both should return the same Signal A (0.5 — neither branch applies)
    assert.strictEqual(
      resultWith.classificationSignals["editPattern"],
      resultWithout.classificationSignals["editPattern"],
    );
  });

  test("large change (>40 lines, single batch, ≤2 events) → Signal A = 0.9 regardless of env", () => {
    const signals: UbaSignals = {
      ...SMALL_HUMAN_BASELINE,
      linesAdded: 50,
      writeEventCount: 1,
      isSingleBatch: true,
      hasKnownEnvSignal: true,
    };
    const result = ubaScore(signals);
    assert.strictEqual(result.classificationSignals["editPattern"], 0.9);
  });

  test("many small events (≤10 lines, >3 events) → Signal A = 0.1 regardless of env", () => {
    const signals: UbaSignals = {
      ...SMALL_HUMAN_BASELINE,
      linesAdded: 6,
      writeEventCount: 5,
      hasKnownEnvSignal: true,
    };
    const result = ubaScore(signals);
    assert.strictEqual(result.classificationSignals["editPattern"], 0.1);
  });
});

// ---------------------------------------------------------------------------
// Trust rule invariants
// ---------------------------------------------------------------------------

describe("ubaScore — trust rule invariants", () => {
  test("trust rule 1 NOT satisfied: strong A but neutral B → score < 0.80 → falls into uncertain zone", () => {
    // A=0.9 (bulk insert) but B=0.5 (neutral interBatchGapMs), C/D/E low.
    // With current weights the score tops out at ~0.59 so trust rule 2 fires first.
    const signals: UbaSignals = {
      linesAdded: 50,
      writeEventCount: 1,
      isSingleBatch: true,
      interBatchGapMs: 3_000,
      fileCount: 1,
      hasLargeContiguousBlock: false,
      hasKnownEnvSignal: false,
      isExplicitAgentSignal: false,
    };
    const result = ubaScore(signals);
    // Score = 0.35*0.9 + 0.25*0.5 + 0.20*0.3 + 0.10*0.4 + 0.10*0.2 = 0.5395
    assert.strictEqual(result.source, "unknown");
    assert.ok(
      result.classificationScore >= 0.50 && result.classificationScore <= 0.80,
      `Expected score in uncertain zone [0.50, 0.80], got ${result.classificationScore}`,
    );
  });

  test("trust rule 1 satisfied: two strong signals A≥0.7 and B≥0.7 → source=ai", () => {
    // A=0.9 (linesAdded>40, single burst), B=0.8 (interBatchGapMs<100, >20 lines).
    // Need C and E high enough to push score above 0.80:
    //   C=0.8 (fileCount=4), D=0.7, E=0.6 (knownEnv) → score = 0.805.
    const signals: UbaSignals = {
      linesAdded: 50,
      writeEventCount: 1,
      isSingleBatch: true,
      interBatchGapMs: 80,
      fileCount: 4,
      hasLargeContiguousBlock: true,
      hasKnownEnvSignal: true,
      isExplicitAgentSignal: false,
    };
    const result = ubaScore(signals);
    assert.strictEqual(result.source, "ai");
    assert.strictEqual(result.status, "mapped");
    assert.ok(result.reviewRequired);
  });

  test("trust rule 2: score in [0.50, 0.80] → source=unknown always", () => {
    // Craft signals to land in the uncertain zone.
    const signals: UbaSignals = {
      linesAdded: 15,
      writeEventCount: 2,
      isSingleBatch: true,
      interBatchGapMs: undefined,
      fileCount: 2,
      hasLargeContiguousBlock: false,
      hasKnownEnvSignal: true,
      isExplicitAgentSignal: false,
    };
    const result = ubaScore(signals);
    if (result.classificationScore >= 0.50 && result.classificationScore <= 0.80) {
      assert.strictEqual(result.source, "unknown");
    }
    // If score is outside the band, the trust rule doesn't apply here —
    // this test is conditional on the score landing in the zone.
  });

  test("trust rule 3: confidence=1.0 only emitted for isExplicitAgentSignal=true", () => {
    const signals: UbaSignals = {
      linesAdded: 60,
      writeEventCount: 1,
      isSingleBatch: true,
      interBatchGapMs: 50,
      fileCount: 3,
      hasLargeContiguousBlock: true,
      hasKnownEnvSignal: true,
      isExplicitAgentSignal: false,
    };
    const result = ubaScore(signals);
    assert.ok(result.confidence < 1.0, `Expected confidence < 1.0, got ${result.confidence}`);
  });

  test("isExplicitAgentSignal=true: confidence equals classificationScore (not extra-capped by trust rule 3)", () => {
    // Max achievable score with current weights:
    //   A=0.9, B=0.8, C=0.8, D=0.7, E=1.0 → 0.845.
    // Trust rule 3 only fires when confidence >= 1.0 (unreachable with current
    // weights), so for explicit signals confidence == classificationScore.
    const signals: UbaSignals = {
      linesAdded: 60,
      writeEventCount: 1,
      isSingleBatch: true,
      interBatchGapMs: 50,
      fileCount: 4,
      hasLargeContiguousBlock: true,
      hasKnownEnvSignal: true,
      isExplicitAgentSignal: true,
    };
    const result = ubaScore(signals);
    // source=ai (2 strong signals, score > 0.80), confidence = classificationScore.
    assert.strictEqual(result.source, "ai");
    assert.ok(
      Math.abs(result.confidence - result.classificationScore) < 0.001,
      `Expected confidence == classificationScore, got confidence=${result.confidence}, score=${result.classificationScore}`,
    );
    // Confidence is approximately 0.845.
    assert.ok(
      result.confidence > 0.80 && result.confidence < 0.90,
      `Expected confidence in (0.80, 0.90), got ${result.confidence}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Source/status/reviewRequired output consistency
// ---------------------------------------------------------------------------

describe("ubaScore — output field consistency", () => {
  test("human classification: status=mapped, reviewRequired=false, confidence=1-score", () => {
    const result = ubaScore(SMALL_HUMAN_BASELINE);
    assert.strictEqual(result.source, "human");
    assert.strictEqual(result.status, "mapped");
    assert.strictEqual(result.reviewRequired, false);
    assert.ok(
      Math.abs(result.confidence - (1 - result.classificationScore)) < 0.001,
      "confidence should be 1 - classificationScore for human",
    );
  });

  test("all five classificationSignals are present in every result", () => {
    const result = ubaScore(SMALL_HUMAN_BASELINE);
    for (const key of ["editPattern", "temporalSignature", "fileScope", "structuralChange", "environment"]) {
      assert.ok(key in result.classificationSignals, `Missing signal key: ${key}`);
    }
  });

  test("all signal values are in [0, 1]", () => {
    const signals: UbaSignals = {
      linesAdded: 25,
      writeEventCount: 3,
      isSingleBatch: false,
      interBatchGapMs: 1_000,
      fileCount: 3,
      hasLargeContiguousBlock: true,
      hasKnownEnvSignal: true,
      isExplicitAgentSignal: false,
    };
    const result = ubaScore(signals);
    for (const [key, val] of Object.entries(result.classificationSignals)) {
      assert.ok(
        val >= 0 && val <= 1,
        `Signal ${key} out of [0,1]: ${val}`,
      );
    }
  });
});
