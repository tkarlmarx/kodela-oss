// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, checkCiThresholds, buildStatusResult } from "./metrics.js";
import { DEFAULT_CONFIG } from "../config/schema.js";
import type { ContextEntry } from "@kodela/core";

const PLACEHOLDER_HASH = "a".repeat(64);

function makeEntry(overrides: Partial<ContextEntry> = {}): ContextEntry {
  return {
    schemaVersion: "1.1.0",
    id: "550e8400-e29b-41d4-a716-446655440000",
    filePath: "src/auth/login.ts",
    astAnchor: null,
    contentHash: PLACEHOLDER_HASH,
    lineRange: { start: 1, end: 5 },
    note: "Test note",
    author: "alice",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    severity: "low",
    tags: [],
    source: "human",
    confidence: 0.9,
    status: "mapped",
    reviewRequired: false,
    ...overrides,
  };
}

describe("computeMetrics", () => {
  test("returns zeroed metrics for empty entries array", () => {
    const m = computeMetrics([]);
    assert.equal(m.total, 0);
    assert.equal(m.confidence_score, 1.0);
    assert.equal(m.orphaned_pct, 0);
    assert.equal(m.unresolved_critical_pct, 0);
  });

  test("counts statuses correctly", () => {
    const entries = [
      makeEntry({ id: "550e8400-e29b-41d4-a716-446655440001", status: "mapped", confidence: 0.9 }),
      makeEntry({ id: "550e8400-e29b-41d4-a716-446655440002", status: "uncertain", confidence: 0.6 }),
      makeEntry({ id: "550e8400-e29b-41d4-a716-446655440003", status: "orphaned", confidence: 0.0 }),
    ];
    const m = computeMetrics(entries);
    assert.equal(m.total, 3);
    assert.equal(m.mapped, 1);
    assert.equal(m.uncertain, 1);
    assert.equal(m.orphaned, 1);
  });

  test("calculates confidence_score as average", () => {
    const entries = [
      makeEntry({ id: "550e8400-e29b-41d4-a716-446655440001", confidence: 0.8 }),
      makeEntry({ id: "550e8400-e29b-41d4-a716-446655440002", confidence: 0.6 }),
    ];
    const m = computeMetrics(entries);
    assert.equal(m.confidence_score, 0.7);
  });

  test("calculates orphaned_pct correctly", () => {
    const entries = [
      makeEntry({ id: "550e8400-e29b-41d4-a716-446655440001", status: "orphaned", confidence: 0 }),
      makeEntry({ id: "550e8400-e29b-41d4-a716-446655440002", status: "mapped", confidence: 1 }),
      makeEntry({ id: "550e8400-e29b-41d4-a716-446655440003", status: "mapped", confidence: 1 }),
      makeEntry({ id: "550e8400-e29b-41d4-a716-446655440004", status: "mapped", confidence: 1 }),
    ];
    const m = computeMetrics(entries);
    assert.equal(m.orphaned_pct, 25);
  });

  test("calculates unresolved_critical_pct from high/critical entries needing review", () => {
    const entries = [
      makeEntry({ id: "550e8400-e29b-41d4-a716-446655440001", severity: "critical", status: "orphaned", confidence: 0 }),
      makeEntry({ id: "550e8400-e29b-41d4-a716-446655440002", severity: "critical", status: "mapped", reviewRequired: false, confidence: 0.9 }),
    ];
    const m = computeMetrics(entries);
    assert.equal(m.unresolved_critical_pct, 50);
  });
});

describe("checkCiThresholds", () => {
  test("passes when all metrics are within thresholds", () => {
    const m = computeMetrics([
      makeEntry({ id: "550e8400-e29b-41d4-a716-446655440001", confidence: 0.9, status: "mapped" }),
    ]);
    const { pass, breached } = checkCiThresholds(m, DEFAULT_CONFIG);
    assert.equal(pass, true);
    assert.equal(breached.length, 0);
  });

  test("fails when confidence_score is below threshold", () => {
    const m = {
      total: 1, mapped: 1, uncertain: 0, orphaned: 0,
      confidence_score: 0.5, orphaned_pct: 0, unresolved_critical_pct: 0,
      highContentDrift: 0,
    };
    const { pass, breached } = checkCiThresholds(m, DEFAULT_CONFIG);
    assert.equal(pass, false);
    assert.ok(breached.some((b) => b.field === "confidence_score"));
  });

  test("fails when orphaned_pct exceeds threshold", () => {
    const m = {
      total: 10, mapped: 8, uncertain: 0, orphaned: 2,
      confidence_score: 0.9, orphaned_pct: 20, unresolved_critical_pct: 0,
      highContentDrift: 0,
    };
    const { pass, breached } = checkCiThresholds(m, DEFAULT_CONFIG);
    assert.equal(pass, false);
    assert.ok(breached.some((b) => b.field === "orphaned_pct"));
  });
});

describe("buildStatusResult", () => {
  test("ci_pass is undefined when ciMode is false", () => {
    const r = buildStatusResult([], DEFAULT_CONFIG, false);
    assert.equal(r.ci_pass, undefined);
  });

  test("ci_pass is true in advisory mode even when thresholds breached", () => {
    const entries = [
      makeEntry({ id: "550e8400-e29b-41d4-a716-446655440001", confidence: 0.1, status: "orphaned" }),
    ];
    const r = buildStatusResult(entries, DEFAULT_CONFIG, true);
    assert.equal(r.ci_pass, true);
    assert.ok(r._breachedThresholds && r._breachedThresholds.length > 0);
  });

  test("ci_pass is false in enforcement mode when thresholds breached", () => {
    const entries = [
      makeEntry({ id: "550e8400-e29b-41d4-a716-446655440001", confidence: 0.1, status: "orphaned" }),
    ];
    const config = { ...DEFAULT_CONFIG, ci: { ...DEFAULT_CONFIG.ci, enforcement: "enforcement" as const } };
    const r = buildStatusResult(entries, config, true);
    assert.equal(r.ci_pass, false);
  });
});
