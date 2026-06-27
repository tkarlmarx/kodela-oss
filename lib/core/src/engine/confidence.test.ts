// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyConfidence, CONFIDENCE_THRESHOLD } from "./confidence.js";

describe("classifyConfidence", () => {
  test("returns 'mapped' for confidence > 0.85", () => {
    assert.equal(classifyConfidence(0.86), "mapped");
    assert.equal(classifyConfidence(0.9), "mapped");
    assert.equal(classifyConfidence(0.99), "mapped");
    assert.equal(classifyConfidence(1.0), "mapped");
  });

  test("returns 'uncertain' for confidence exactly at the upper threshold (0.85)", () => {
    assert.equal(classifyConfidence(0.85), "uncertain");
  });

  test("returns 'uncertain' for confidence in range 0.5–0.85", () => {
    assert.equal(classifyConfidence(0.5), "uncertain");
    assert.equal(classifyConfidence(0.6), "uncertain");
    assert.equal(classifyConfidence(0.75), "uncertain");
    assert.equal(classifyConfidence(0.84), "uncertain");
  });

  test("returns 'orphaned' for confidence < 0.5", () => {
    assert.equal(classifyConfidence(0.0), "orphaned");
    assert.equal(classifyConfidence(0.1), "orphaned");
    assert.equal(classifyConfidence(0.49), "orphaned");
  });

  test("throws RangeError for confidence above 1", () => {
    assert.throws(() => classifyConfidence(1.1), RangeError);
    assert.throws(() => classifyConfidence(2), RangeError);
  });

  test("throws RangeError for negative confidence", () => {
    assert.throws(() => classifyConfidence(-0.01), RangeError);
    assert.throws(() => classifyConfidence(-1), RangeError);
  });

  test("threshold constants have the expected values", () => {
    assert.equal(CONFIDENCE_THRESHOLD.MAPPED, 0.85);
    assert.equal(CONFIDENCE_THRESHOLD.UNCERTAIN_MIN, 0.5);
  });

  test("boundary: exactly 0 is orphaned", () => {
    assert.equal(classifyConfidence(0), "orphaned");
  });

  test("boundary: exactly 1 is mapped", () => {
    assert.equal(classifyConfidence(1), "mapped");
  });
});
