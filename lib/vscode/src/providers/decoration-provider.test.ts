// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeDecorationRanges,
} from "./decoration-utils.js";
import type { ContextEntry } from "@kodela/core";

const HASH = "a".repeat(64);

function entry(
  id: string,
  filePath: string,
  start: number,
  end: number,
  status: ContextEntry["status"],
): ContextEntry {
  return {
    schemaVersion: "1.1.0",
    id,
    filePath,
    astAnchor: null,
    contentHash: HASH,
    lineRange: { start, end },
    note: "note",
    author: "alice",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    severity: "low",
    tags: [],
    source: "human",
    confidence: 0.9,
    status,
    reviewRequired: false,
  };
}

describe("computeDecorationRanges", () => {
  test("returns empty ranges when no entries match the file", () => {
    const ranges = computeDecorationRanges(
      [entry("1", "src/other.ts", 1, 5, "mapped")],
      "src/auth.ts",
    );
    assert.deepEqual(ranges, { mapped: [], uncertain: [], orphaned: [] });
  });

  test("assigns mapped entries to mapped bucket", () => {
    const ranges = computeDecorationRanges(
      [entry("1", "src/auth.ts", 10, 20, "mapped")],
      "src/auth.ts",
    );
    assert.deepEqual(ranges.mapped, [{ start: 10, end: 20 }]);
    assert.deepEqual(ranges.uncertain, []);
    assert.deepEqual(ranges.orphaned, []);
  });

  test("assigns uncertain entries to uncertain bucket", () => {
    const ranges = computeDecorationRanges(
      [entry("1", "src/auth.ts", 5, 8, "uncertain")],
      "src/auth.ts",
    );
    assert.deepEqual(ranges.uncertain, [{ start: 5, end: 8 }]);
  });

  test("assigns orphaned entries to orphaned bucket", () => {
    const ranges = computeDecorationRanges(
      [entry("1", "src/auth.ts", 1, 3, "orphaned")],
      "src/auth.ts",
    );
    assert.deepEqual(ranges.orphaned, [{ start: 1, end: 3 }]);
  });

  test("splits multiple entries across buckets correctly", () => {
    const entries: ContextEntry[] = [
      entry("1", "src/auth.ts", 1, 5, "mapped"),
      entry("2", "src/auth.ts", 10, 15, "uncertain"),
      entry("3", "src/auth.ts", 20, 25, "orphaned"),
      entry("4", "src/other.ts", 1, 100, "mapped"),
    ];
    const ranges = computeDecorationRanges(entries, "src/auth.ts");
    assert.equal(ranges.mapped.length, 1);
    assert.equal(ranges.uncertain.length, 1);
    assert.equal(ranges.orphaned.length, 1);
  });

  test("treats multiple mapped entries across lines independently", () => {
    const e1 = entry("1", "src/auth.ts", 1, 5, "mapped");
    const e2 = entry("2", "src/auth.ts", 10, 15, "mapped");
    const ranges = computeDecorationRanges([e1, e2], "src/auth.ts");
    assert.equal(ranges.mapped.length, 2);
    assert.deepEqual(ranges.mapped[0], { start: 1, end: 5 });
    assert.deepEqual(ranges.mapped[1], { start: 10, end: 15 });
  });
});
