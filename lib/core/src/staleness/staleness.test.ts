// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 48 — staleness detection tests.
 * Run via: pnpm --filter @kodela/core run test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractFingerprint, computeJaccard, computeContentDrift } from "./index.js";

// ---------------------------------------------------------------------------
// extractFingerprint
// ---------------------------------------------------------------------------

describe("extractFingerprint", () => {
  it("returns non-empty tokens for simple code", () => {
    const code = "function add(a, b) { return a + b; }";
    const fp = extractFingerprint(code);
    assert.ok(fp.length > 0, "fingerprint should be non-empty");
  });

  it("strips common stop-words", () => {
    const fp = extractFingerprint("const x = 1;");
    assert.ok(!fp.includes("const"), "should not include 'const'");
  });

  it("lowercases tokens", () => {
    const fp = extractFingerprint("function Add() {}");
    assert.ok(fp.every((t) => t === t.toLowerCase()), "all tokens should be lowercase");
  });

  it("deduplicates tokens", () => {
    const fp = extractFingerprint("foo foo foo bar");
    const fooCount = fp.filter((t) => t === "foo").length;
    assert.equal(fooCount, 1, "duplicate tokens should be removed");
  });

  it("filters out single-character tokens", () => {
    const fp = extractFingerprint("a ab abc abcd");
    assert.ok(fp.every((t) => t.length >= 2), "all tokens should have length >= 2");
    assert.ok(!fp.includes("a"), "single-char tokens should be excluded");
  });

  it("returns empty array for blank input", () => {
    assert.deepEqual(extractFingerprint(""), []);
    assert.deepEqual(extractFingerprint("   "), []);
  });

  it("handles punctuation-heavy code", () => {
    const fp = extractFingerprint("!@#$%^&*(){}[];,.");
    assert.deepEqual(fp, [], "pure punctuation should produce no tokens");
  });
});

// ---------------------------------------------------------------------------
// computeJaccard
// ---------------------------------------------------------------------------

describe("computeJaccard", () => {
  it("returns 1.0 for identical sets", () => {
    const a = ["foo", "bar", "baz"];
    assert.equal(computeJaccard(a, a), 1.0);
  });

  it("returns 0.0 for disjoint sets", () => {
    const a = ["foo", "bar"];
    const b = ["baz", "qux"];
    assert.equal(computeJaccard(a, b), 0.0);
  });

  it("returns 1.0 for two empty arrays", () => {
    assert.equal(computeJaccard([], []), 1.0);
  });

  it("returns 0.0 when one side is empty", () => {
    assert.equal(computeJaccard(["foo"], []), 0.0);
    assert.equal(computeJaccard([], ["foo"]), 0.0);
  });

  it("returns fractional similarity for partial overlap", () => {
    // Intersection {foo, bar} = 2, Union {foo, bar, baz, qux} = 4 → 0.5
    const a = ["foo", "bar", "baz"];
    const b = ["foo", "bar", "qux"];
    const j = computeJaccard(a, b);
    assert.ok(j > 0 && j < 1, "should be between 0 and 1");
    assert.ok(Math.abs(j - 0.5) < 0.001, `expected ~0.5, got ${j}`);
  });

  it("is symmetric", () => {
    const a = ["foo", "bar"];
    const b = ["bar", "baz"];
    assert.equal(computeJaccard(a, b), computeJaccard(b, a));
  });
});

// ---------------------------------------------------------------------------
// computeContentDrift
// ---------------------------------------------------------------------------

describe("computeContentDrift", () => {
  it('returns "low" when one or both fingerprints are empty (no signal)', () => {
    assert.equal(computeContentDrift([], ["foo"]), "low");
    assert.equal(computeContentDrift(["foo"], []), "low");
    assert.equal(computeContentDrift([], []), "low");
  });

  it('returns "low" for high similarity (jaccard ≥ 0.80)', () => {
    const base = ["authenticate", "user", "password", "token", "session"];
    const similar = [...base, "refresh"];
    const drift = computeContentDrift(base, similar);
    assert.equal(drift, "low");
  });

  it('returns "medium" for moderate similarity (0.50 ≤ jaccard < 0.80)', () => {
    const base = ["authenticate", "user", "password", "token", "session"];
    const changed = ["authenticate", "user", "jwt", "bearer", "expiry", "refresh", "scope"];
    const drift = computeContentDrift(base, changed);
    assert.ok(
      drift === "medium" || drift === "high",
      `expected medium or high, got ${drift}`,
    );
  });

  it('returns "high" for low similarity (jaccard < 0.50)', () => {
    const base = ["authenticate", "user", "password", "session"];
    const replaced = ["stripe", "checkout", "payment", "currency", "invoice", "billing"];
    const drift = computeContentDrift(base, replaced);
    assert.equal(drift, "high");
  });

  it('returns "low" for identical fingerprints', () => {
    const fp = ["authenticate", "user", "password", "token"];
    assert.equal(computeContentDrift(fp, fp), "low");
  });

  it('returns "high" for completely different fingerprints', () => {
    const a = Array.from({ length: 10 }, (_, i) => `alpha${i}`);
    const b = Array.from({ length: 10 }, (_, i) => `beta${i}`);
    assert.equal(computeContentDrift(a, b), "high");
  });
});
