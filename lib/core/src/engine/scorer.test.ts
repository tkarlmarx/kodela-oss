// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { scoreTokenSimilarity, scorePositionalProximity } from "./scorer.js";

function normalizeForHash(text: string): string {
  return text
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/#[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function computeHash(lines: string[]): string {
  const normalized = normalizeForHash(lines.join("\n"));
  return createHash("sha256").update(normalized).digest("hex");
}

describe("scoreTokenSimilarity", () => {
  test("returns 1.0 when candidate hash matches oldTokenHash exactly", () => {
    const lines = ["export function greet(name) {", "  return name;", "}"];
    const hash = computeHash(lines);
    const score = scoreTokenSimilarity(hash, lines);
    assert.equal(score, 1.0);
  });

  test("returns 1.0 when content differs only in comments (normalises to same hash)", () => {
    const original = ["export function greet(name) {", "  return name;", "}"];
    const withComment = [
      "export function greet(name) { // greets the user",
      "  return name; /* returns it */",
      "}",
    ];
    const hash = computeHash(original);
    const score = scoreTokenSimilarity(hash, withComment);
    assert.equal(score, 1.0);
  });

  test("returns Dice coefficient when hash does not match and originalLines is provided", () => {
    const origLines = ["alpha beta gamma", "delta epsilon", "zeta"];
    const candidateLines = ["alpha beta gamma", "omega pi", "zeta"];

    const hash = computeHash(origLines);

    const score = scoreTokenSimilarity(hash, candidateLines, origLines);

    assert.notEqual(score, 1.0, "hash should not match");
    assert.notEqual(score, 0, "Dice should be > 0 with shared tokens");

    const expectedDice = (2 * 4) / (6 + 6);
    assert.ok(
      Math.abs(score - expectedDice) < 0.001,
      `expected Dice ≈ ${expectedDice.toFixed(3)}, got ${score.toFixed(3)}`,
    );
  });

  test("returns 0 when hash does not match and originalLines is not provided", () => {
    const origLines = ["alpha beta", "gamma delta"];
    const candidateLines = ["alpha beta", "different content"];
    const hash = computeHash(origLines);

    const score = scoreTokenSimilarity(hash, candidateLines);
    assert.equal(score, 0);
  });

  test("returns 0 when hash does not match and originalLines is empty", () => {
    const origLines = ["alpha beta gamma"];
    const hash = computeHash(origLines);
    const score = scoreTokenSimilarity(hash, ["completely different"], []);
    assert.equal(score, 0);
  });

  test("returns 0 when token sets are completely disjoint", () => {
    const origLines = ["alpha beta gamma"];
    const candidateLines = ["one two three"];
    const hash = computeHash(origLines);
    const score = scoreTokenSimilarity(hash, candidateLines, origLines);
    assert.equal(score, 0);
  });

  test("returns 1.0 when both sets are empty (normalise to same empty hash)", () => {
    const emptyHash = computeHash([""]);
    const score = scoreTokenSimilarity(emptyHash, [""]);
    assert.equal(score, 1.0);
  });

  test("returns 1.0 for identical multi-line content", () => {
    const lines = [
      "import React from react",
      "export const App = () => null",
    ];
    const hash = computeHash(lines);
    const score = scoreTokenSimilarity(hash, [...lines], lines);
    assert.equal(score, 1.0);
  });
});

describe("scorePositionalProximity", () => {
  test("returns 1.0 when old and candidate midpoints are identical", () => {
    const score = scorePositionalProximity([10, 20], [10, 20], 100);
    assert.equal(score, 1.0);
  });

  test("returns 1.0 for same midpoint even with different range widths", () => {
    const score = scorePositionalProximity([9, 21], [10, 20], 100);
    assert.equal(score, 1.0);
  });

  test("returns 0 when totalLines is 0", () => {
    const score = scorePositionalProximity([1, 5], [1, 5], 0);
    assert.equal(score, 0);
  });

  test("returns 0 when totalLines is negative", () => {
    const score = scorePositionalProximity([1, 5], [1, 5], -1);
    assert.equal(score, 0);
  });

  test("produces expected score for known midpoint distance", () => {
    const score = scorePositionalProximity([1, 1], [101, 101], 100);
    assert.ok(
      score >= 0 && score <= 1.0,
      "score should be in [0, 1]",
    );
    const expected = Math.max(0, 1 - 100 / 100);
    assert.ok(
      Math.abs(score - expected) < 0.001,
      `expected ${expected}, got ${score}`,
    );
  });

  test("scores decline as midpoints diverge", () => {
    const s1 = scorePositionalProximity([50, 50], [51, 51], 100);
    const s2 = scorePositionalProximity([50, 50], [70, 70], 100);
    const s3 = scorePositionalProximity([50, 50], [90, 90], 100);
    assert.ok(s1 > s2, "closer midpoint should score higher than farther");
    assert.ok(s2 > s3, "midpoint at 70 should score higher than at 90");
  });

  test("never returns below 0", () => {
    const score = scorePositionalProximity([1, 2], [1000, 1001], 10);
    assert.ok(score >= 0, `score should not be negative, got ${score}`);
  });
});
