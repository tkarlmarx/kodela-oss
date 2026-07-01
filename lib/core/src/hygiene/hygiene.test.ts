// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Memory hygiene (Phase 1 — P1.3). Confirms analyzeHygiene detects each issue
 * kind, clusters overlapping annotations as contradiction candidates, ignores
 * archived entries, stays deterministic under an injected `now`, and produces a
 * health score that drops as memory degrades.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { analyzeHygiene } from "./index.js";
import type { ContextEntry } from "../schema/index.js";

const NOW = Date.parse("2026-07-01T00:00:00.000Z");

function entry(over: Partial<ContextEntry>): ContextEntry {
  return {
    schemaVersion: "1.1.0",
    id: "00000000-0000-0000-0000-000000000000",
    filePath: "src/x.ts",
    astAnchor: null,
    contentHash: "hash",
    lineRange: { start: 1, end: 5 },
    note: "note",
    author: "ai",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    severity: "low",
    tags: [],
    source: "ai",
    confidence: 0.9,
    status: "mapped",
    reviewRequired: false,
    ...over,
  };
}

describe("analyzeHygiene (Phase 1 memory hygiene)", () => {
  test("a clean, recent, mapped set scores 100 with no issues", () => {
    const r = analyzeHygiene(
      [
        entry({ id: "a", filePath: "src/a.ts", lineRange: { start: 1, end: 5 } }),
        entry({ id: "b", filePath: "src/b.ts", lineRange: { start: 1, end: 5 } }),
      ],
      { now: NOW },
    );
    assert.equal(r.issues.length, 0);
    assert.equal(r.flaggedEntries, 0);
    assert.equal(r.healthScore, 100);
    assert.equal(r.totalEntries, 2);
  });

  test("detects orphaned / drifted / review / low-confidence / stale", () => {
    const r = analyzeHygiene(
      [
        entry({ id: "orph", filePath: "src/o.ts", status: "orphaned" }),
        entry({ id: "drift", filePath: "src/d.ts", status: "uncertain" }),
        entry({ id: "rev", filePath: "src/r.ts", reviewRequired: true }),
        entry({ id: "low", filePath: "src/l.ts", confidence: 0.2 }),
        entry({ id: "old", filePath: "src/s.ts", updatedAt: "2025-01-01T00:00:00.000Z" }),
      ],
      { now: NOW, staleDays: 180, minConfidence: 0.5 },
    );
    assert.equal(r.byKind.orphaned, 1);
    assert.equal(r.byKind.drifted, 1);
    assert.equal(r.byKind["review-required"], 1);
    assert.equal(r.byKind["low-confidence"], 1);
    assert.equal(r.byKind.stale, 1);
    assert.equal(r.flaggedEntries, 5);
    // High-severity orphaned issue must sort to the front.
    assert.equal(r.issues[0]!.kind, "orphaned");
    assert.ok(r.healthScore < 100);
  });

  test("clusters overlapping annotations on the same file as an overlap issue", () => {
    const r = analyzeHygiene(
      [
        entry({ id: "e1", filePath: "src/auth.ts", lineRange: { start: 10, end: 20 } }),
        entry({ id: "e2", filePath: "src/auth.ts", lineRange: { start: 15, end: 25 } }),
        // Non-overlapping on the same file — must NOT be clustered with the above.
        entry({ id: "e3", filePath: "src/auth.ts", lineRange: { start: 90, end: 95 } }),
      ],
      { now: NOW },
    );
    const overlaps = r.issues.filter((i) => i.kind === "overlap");
    assert.equal(overlaps.length, 1, "exactly one overlap cluster");
    assert.deepEqual(overlaps[0]!.entryIds.sort(), ["e1", "e2"]);
    assert.ok(!overlaps[0]!.entryIds.includes("e3"), "the distant entry is not clustered");
  });

  test("orphaned entries are excluded from overlap clustering", () => {
    const r = analyzeHygiene(
      [
        entry({ id: "live", filePath: "src/f.ts", lineRange: { start: 1, end: 10 } }),
        entry({ id: "dead", filePath: "src/f.ts", lineRange: { start: 1, end: 10 }, status: "orphaned" }),
      ],
      { now: NOW },
    );
    assert.equal(r.byKind.overlap, 0, "an orphan doesn't count as overlapping live code");
    assert.equal(r.byKind.orphaned, 1);
  });

  test("archived entries are ignored entirely", () => {
    const archived = { ...entry({ id: "arch", status: "orphaned" }), archived: true } as ContextEntry;
    const r = analyzeHygiene([archived, entry({ id: "ok", filePath: "src/ok.ts" })], { now: NOW });
    assert.equal(r.totalEntries, 1, "archived entry not counted");
    assert.equal(r.issues.length, 0);
    assert.equal(r.healthScore, 100);
  });

  test("health score is deterministic and degrades with severity", () => {
    const a = entry({ id: "a", filePath: "src/a.ts" });
    const b = entry({ id: "b", filePath: "src/b.ts" });
    const c = entry({ id: "c", filePath: "src/c.ts" });
    const clean = analyzeHygiene([a, b, c], { now: NOW });
    const degradedInput = [{ ...a, status: "orphaned" as const }, b, c];
    const degraded = analyzeHygiene(degradedInput, { now: NOW });
    assert.equal(clean.healthScore, 100);
    assert.ok(degraded.healthScore < clean.healthScore);
    // Determinism: same input + same now → identical score.
    assert.equal(degraded.healthScore, analyzeHygiene(degradedInput, { now: NOW }).healthScore);
  });
});
