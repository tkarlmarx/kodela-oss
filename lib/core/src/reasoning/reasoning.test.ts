// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Tests for Gap 53 — Reasoning Extraction Engine
 *
 * Covers:
 *   - buildExtractionPrompt — prompt construction
 *   - buildRetryPrompt — retry prompt construction
 *   - buildFallbackReasoning — deterministic fallback
 *   - validateReasoningResponse — JSON parse + schema validation
 *   - extractReasoning — idempotency guard + fallback when no API key
 */

import assert from "node:assert/strict";
import { describe, test, before, after } from "node:test";
import {
  buildExtractionPrompt,
  buildRetryPrompt,
  buildFallbackReasoning,
  validateReasoningResponse,
  extractReasoning,
} from "./index.js";
import type { ReasoningObject } from "./index.js";

// ---------------------------------------------------------------------------
// buildExtractionPrompt
// ---------------------------------------------------------------------------

describe("buildExtractionPrompt", () => {
  test("contains the file path", () => {
    const prompt = buildExtractionPrompt("src/auth/login.ts");
    assert.ok(prompt.includes("src/auth/login.ts"));
  });

  test("includes diff when provided", () => {
    const prompt = buildExtractionPrompt("src/foo.ts", "--- foo\n+++ foo\n+bar");
    assert.ok(prompt.includes("+bar"));
    assert.ok(prompt.includes("```diff"));
  });

  test("includes note when provided", () => {
    const prompt = buildExtractionPrompt("src/foo.ts", undefined, "Guards session expiry");
    assert.ok(prompt.includes("Guards session expiry"));
  });

  test("truncates long diffs to 3000 chars", () => {
    const longDiff = "x".repeat(4000);
    const prompt = buildExtractionPrompt("src/foo.ts", longDiff);
    assert.ok(prompt.includes("... (truncated)"));
    // The actual diff preview should be ≤ 3000 chars
    const start = prompt.indexOf("```diff\n") + "```diff\n".length;
    const end = prompt.indexOf("\n```", start);
    const diffContent = prompt.slice(start, end);
    assert.ok(diffContent.length <= 3020); // 3000 + "\n... (truncated)"
  });

  test("contains SYSTEM INSTRUCTION block", () => {
    const prompt = buildExtractionPrompt("src/x.ts");
    assert.ok(prompt.includes("[SYSTEM INSTRUCTION]"));
    assert.ok(prompt.includes("[END INSTRUCTION]"));
  });

  test("works with no diff and no note", () => {
    const prompt = buildExtractionPrompt("src/x.ts");
    assert.ok(prompt.length > 0);
    assert.ok(!prompt.includes("```diff"));
    assert.ok(!prompt.includes("annotation note"));
  });
});

// ---------------------------------------------------------------------------
// buildRetryPrompt
// ---------------------------------------------------------------------------

describe("buildRetryPrompt", () => {
  test("contains file path", () => {
    const p = buildRetryPrompt("src/db/query.ts");
    assert.ok(p.includes("src/db/query.ts"));
  });

  test("includes note when provided", () => {
    const p = buildRetryPrompt("src/db/query.ts", "Prevents SQL injection");
    assert.ok(p.includes("Prevents SQL injection"));
  });

  test("contains no markdown instruction", () => {
    const p = buildRetryPrompt("src/x.ts");
    assert.ok(p.includes("no markdown"));
  });
});

// ---------------------------------------------------------------------------
// buildFallbackReasoning
// ---------------------------------------------------------------------------

describe("buildFallbackReasoning", () => {
  test("returns a valid ReasoningObject", () => {
    const r = buildFallbackReasoning("src/auth/session.ts");
    assert.equal(r.extractionMethod, "diff-inference");
    assert.equal(r.confidence, "low");
    assert.ok(r.intent.length > 0);
    assert.equal(r.reasoning, "");
    assert.deepEqual(r.alternatives, []);
    assert.ok(r.extractedAt.length > 0);
  });

  test("uses note as intent when available", () => {
    const r = buildFallbackReasoning("src/x.ts", "Handles JWT refresh");
    assert.equal(r.intent, "Handles JWT refresh");
  });

  test("falls back to file path when note is absent", () => {
    const r = buildFallbackReasoning("src/payments/stripe.ts");
    assert.ok(r.intent.includes("src/payments/stripe.ts"));
  });

  test("truncates long notes to 120 chars", () => {
    const longNote = "A".repeat(150);
    const r = buildFallbackReasoning("src/x.ts", longNote);
    assert.ok(r.intent.endsWith("..."));
    assert.ok(r.intent.length <= 120);
  });

  test("extractedAt is an ISO-8601 datetime", () => {
    const r = buildFallbackReasoning("src/x.ts");
    assert.doesNotThrow(() => new Date(r.extractedAt));
    assert.ok(!isNaN(new Date(r.extractedAt).getTime()));
  });

  test("has no raw field", () => {
    const r = buildFallbackReasoning("src/x.ts");
    assert.equal(r.raw, undefined);
  });
});

// ---------------------------------------------------------------------------
// validateReasoningResponse
// ---------------------------------------------------------------------------

describe("validateReasoningResponse", () => {
  test("parses a valid response", () => {
    const raw = JSON.stringify({
      intent: "Adds session expiry check",
      reasoning: "Prevents stale tokens from being accepted.",
      alternatives: ["Check expiry in middleware", "Use JWT exp claim"],
      confidence: "high",
    });
    const result = validateReasoningResponse(raw);
    assert.ok(result !== null);
    assert.equal(result!.intent, "Adds session expiry check");
    assert.equal(result!.confidence, "high");
    assert.deepEqual(result!.alternatives, ["Check expiry in middleware", "Use JWT exp claim"]);
    assert.equal(result!.extractionMethod, "prompt");
  });

  test("strips markdown fences before parsing", () => {
    const raw =
      '```json\n{"intent":"X","reasoning":"Y","alternatives":[],"confidence":"medium"}\n```';
    const result = validateReasoningResponse(raw);
    assert.ok(result !== null);
    assert.equal(result!.intent, "X");
  });

  test("strips plain code fences", () => {
    const raw =
      '```\n{"intent":"Z","reasoning":"","alternatives":[],"confidence":"low"}\n```';
    const result = validateReasoningResponse(raw);
    assert.ok(result !== null);
    assert.equal(result!.intent, "Z");
  });

  test("returns null for invalid JSON", () => {
    const result = validateReasoningResponse("not json at all");
    assert.equal(result, null);
  });

  test("returns null for missing intent", () => {
    const raw = JSON.stringify({
      reasoning: "Some reasoning",
      alternatives: [],
      confidence: "high",
    });
    assert.equal(validateReasoningResponse(raw), null);
  });

  test("returns null for empty string intent", () => {
    const raw = JSON.stringify({
      intent: "  ",
      reasoning: "",
      alternatives: [],
      confidence: "high",
    });
    assert.equal(validateReasoningResponse(raw), null);
  });

  test("returns null for invalid confidence value", () => {
    const raw = JSON.stringify({
      intent: "Some intent",
      reasoning: "",
      alternatives: [],
      confidence: "very-high",
    });
    assert.equal(validateReasoningResponse(raw), null);
  });

  test("accepts empty reasoning string", () => {
    const raw = JSON.stringify({
      intent: "Fix bug",
      reasoning: "",
      alternatives: [],
      confidence: "low",
    });
    const result = validateReasoningResponse(raw);
    assert.ok(result !== null);
    assert.equal(result!.reasoning, "");
  });

  test("filters non-string alternatives", () => {
    const raw = JSON.stringify({
      intent: "Fix bug",
      reasoning: "Some reasoning",
      alternatives: ["valid", 42, null, "also valid"],
      confidence: "medium",
    });
    const result = validateReasoningResponse(raw);
    assert.ok(result !== null);
    assert.deepEqual(result!.alternatives, ["valid", "also valid"]);
  });

  test("accepts missing alternatives (coerces to empty array)", () => {
    const raw = JSON.stringify({
      intent: "Fix bug",
      reasoning: "Some reasoning",
      confidence: "high",
    });
    const result = validateReasoningResponse(raw);
    assert.ok(result !== null);
    assert.deepEqual(result!.alternatives, []);
  });

  test("respects extractionMethod override", () => {
    const raw = JSON.stringify({
      intent: "Fix",
      reasoning: "",
      alternatives: [],
      confidence: "low",
    });
    const result = validateReasoningResponse(raw, "hook");
    assert.ok(result !== null);
    assert.equal(result!.extractionMethod, "hook");
  });

  test("stores raw in result", () => {
    const raw = JSON.stringify({
      intent: "Fix",
      reasoning: "",
      alternatives: [],
      confidence: "low",
    });
    const result = validateReasoningResponse(raw);
    assert.ok(result !== null);
    assert.equal(result!.raw, raw);
  });
});

// ---------------------------------------------------------------------------
// extractReasoning — idempotency guard and fallback path (no network)
// ---------------------------------------------------------------------------

describe("extractReasoning — no API key", () => {
  let savedKey: string | undefined;

  before(() => {
    savedKey = process.env["KODELA_AI_API_KEY"];
    delete process.env["KODELA_AI_API_KEY"];
  });

  after(() => {
    if (savedKey !== undefined) {
      process.env["KODELA_AI_API_KEY"] = savedKey;
    } else {
      delete process.env["KODELA_AI_API_KEY"];
    }
  });

  test("returns fallback reasoning when no API key is set", async () => {
    const result = await extractReasoning("src/auth/session.ts", {
      note: "Checks session expiry",
    });
    assert.equal(result.extractionMethod, "diff-inference");
    assert.equal(result.confidence, "low");
    assert.equal(result.intent, "Checks session expiry");
  });

  test("returns fallback with file path as intent when note absent", async () => {
    const result = await extractReasoning("src/payments/stripe.ts");
    assert.ok(result.intent.includes("src/payments/stripe.ts"));
  });
});

describe("extractReasoning — idempotency guard", () => {
  let savedKey: string | undefined;

  before(() => {
    savedKey = process.env["KODELA_AI_API_KEY"];
    delete process.env["KODELA_AI_API_KEY"];
  });

  after(() => {
    if (savedKey !== undefined) {
      process.env["KODELA_AI_API_KEY"] = savedKey;
    } else {
      delete process.env["KODELA_AI_API_KEY"];
    }
  });

  test("returns existing reasoning when it is fresh (< 30 days)", async () => {
    const existing: ReasoningObject = {
      intent: "Existing intent",
      reasoning: "Existing reasoning",
      alternatives: [],
      confidence: "high",
      extractedAt: new Date().toISOString(), // just now
      extractionMethod: "prompt",
    };

    const result = await extractReasoning("src/x.ts", {
      existingReasoning: existing,
    });

    assert.equal(result.intent, "Existing intent");
    assert.equal(result.extractionMethod, "prompt");
    assert.equal(result.confidence, "high");
  });

  test("does not return existing reasoning when it is stale (>= 30 days)", async () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const existing: ReasoningObject = {
      intent: "Old intent",
      reasoning: "Old reasoning",
      alternatives: [],
      confidence: "high",
      extractedAt: thirtyOneDaysAgo,
      extractionMethod: "prompt",
    };

    // No API key → falls back to diff-inference
    const result = await extractReasoning("src/x.ts", {
      existingReasoning: existing,
      note: "Refreshed note",
    });

    // Should have re-extracted (fallback since no API key)
    assert.equal(result.extractionMethod, "diff-inference");
    assert.equal(result.intent, "Refreshed note");
  });

  test("respects custom reextractAfterDays", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const existing: ReasoningObject = {
      intent: "Existing 1-day-old intent",
      reasoning: "",
      alternatives: [],
      confidence: "medium",
      extractedAt: twoDaysAgo,
      extractionMethod: "hook",
    };

    // With reextractAfterDays: 1, the 2-day-old entry should be re-extracted
    const result = await extractReasoning("src/x.ts", {
      existingReasoning: existing,
      reextractAfterDays: 1,
      note: "Fresh note",
    });

    assert.equal(result.extractionMethod, "diff-inference");
    assert.equal(result.intent, "Fresh note");
  });

  test("with reextractAfterDays: 7 and 2-day-old entry — returns existing", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const existing: ReasoningObject = {
      intent: "Two-day-old intent",
      reasoning: "",
      alternatives: [],
      confidence: "high",
      extractedAt: twoDaysAgo,
      extractionMethod: "hook",
    };

    const result = await extractReasoning("src/x.ts", {
      existingReasoning: existing,
      reextractAfterDays: 7,
    });

    assert.equal(result.intent, "Two-day-old intent");
  });
});
