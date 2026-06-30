// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { runInit, runAdd } from "@kodela/cli";
import { runReport, formatReportResult, debtScore, isEntrySnoozed } from "./report.js";
import type { ContextEntry } from "@kodela/core";

const HASH = "a".repeat(64);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<ContextEntry> & { id: string }): ContextEntry {
  return {
    schemaVersion: "1.1.0",
    id: overrides.id,
    filePath: overrides.filePath ?? "src/auth.ts",
    astAnchor: null,
    contentHash: HASH,
    lineRange: overrides.lineRange ?? { start: 1, end: 10 },
    note: overrides.note ?? "Test note for the entry",
    author: "alice",
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
    severity: overrides.severity ?? "medium",
    tags: [],
    source: "human",
    confidence: 0.9,
    status: overrides.status ?? "mapped",
    reviewRequired: false,
    ...(overrides.snoozedUntil !== undefined ? { snoozedUntil: overrides.snoozedUntil } : {}),
  } as ContextEntry;
}

describe("debtScore", () => {
  test("computes age_days × lines_changed", () => {
    const now = new Date("2024-02-11T00:00:00.000Z").getTime(); // 41 days after 2024-01-01
    const entry = makeEntry({ id: "e1", lineRange: { start: 1, end: 10 } }); // 10 lines
    assert.equal(debtScore(entry, now), 41 * 10);
  });

  test("returns 0 for a brand-new entry", () => {
    const now = new Date("2024-01-01T00:00:00.000Z").getTime();
    const entry = makeEntry({ id: "e1", lineRange: { start: 1, end: 10 } });
    assert.equal(debtScore(entry, now), 0);
  });

  test("lineRange of 1 line counts as 1", () => {
    const now = new Date("2024-01-11T00:00:00.000Z").getTime(); // 10 days
    const entry = makeEntry({ id: "e1", lineRange: { start: 5, end: 5 } });
    assert.equal(debtScore(entry, now), 10 * 1);
  });
});

describe("isEntrySnoozed", () => {
  test("returns false when snoozedUntil is absent", () => {
    const entry = makeEntry({ id: "e1" });
    assert.ok(!isEntrySnoozed(entry, Date.now()));
  });

  test("returns true when snoozedUntil is in the future", () => {
    const future = new Date(Date.now() + 1_000_000).toISOString();
    const entry = makeEntry({ id: "e1", snoozedUntil: future });
    assert.ok(isEntrySnoozed(entry, Date.now()));
  });

  test("returns false when snoozedUntil has expired", () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    const entry = makeEntry({ id: "e1", snoozedUntil: past });
    assert.ok(!isEntrySnoozed(entry, Date.now()));
  });
});

// ---------------------------------------------------------------------------
// Integration: runReport against a real temp repo
// ---------------------------------------------------------------------------

describe("runReport", () => {
  let tmpDir: string;

  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty result for fresh repo", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-report-"));
    await runInit(tmpDir);
    const result = await runReport({ repoRoot: tmpDir });
    assert.equal(result.items.length, 0);
    assert.equal(result.totalAboveThreshold, 0);
    assert.equal(result.snoozedCount, 0);
  });

  test("surfaces entries with high debt score", async () => {
    // Add an entry with a createdAt far in the past so it has a large debt score
    await runAdd({
      repoRoot: tmpDir,
      filePath: "src/auth.ts",
      lineStart: 1,
      lineEnd: 100, // 100 lines
      note: "Legacy auth middleware — untouched for months",
      severity: "high",
      source: "human",
      tags: [],
    });

    // Backdate the entry's createdAt to 10 days ago (score = 10 × 100 = 1000)
    const objectsDir = path.join(tmpDir, ".kodela", "objects");
    const objectFiles = await fs.readdir(objectsDir);
    const entryPath = path.join(objectsDir, objectFiles[0]);
    const raw = JSON.parse(await fs.readFile(entryPath, "utf-8")) as { createdAt: string; updatedAt: string };
    raw.createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    raw.updatedAt = raw.createdAt;
    await fs.writeFile(entryPath, JSON.stringify(raw));

    const result = await runReport({ repoRoot: tmpDir, threshold: 500 });
    assert.ok(result.totalAboveThreshold >= 1, "should find at least one entry above threshold");
    assert.ok(result.items.length >= 1);
    assert.ok(result.items[0].debtScore > 500);
  });

  test("threshold filters out low-score entries", async () => {
    // Use a very high threshold — no entries should appear
    const result = await runReport({ repoRoot: tmpDir, threshold: 9999 });
    assert.equal(result.totalAboveThreshold, 0);
    assert.equal(result.items.length, 0);
  });

  test("top cap limits results", async () => {
    const result = await runReport({ repoRoot: tmpDir, threshold: 0, top: 1 });
    assert.ok(result.items.length <= 1);
  });
});

// ---------------------------------------------------------------------------
// formatReportResult
// ---------------------------------------------------------------------------

describe("formatReportResult", () => {
  test("shows 'All good' message when no entries above threshold", () => {
    const result = formatReportResult({
      items: [],
      threshold: 500,
      totalAboveThreshold: 0,
      snoozedCount: 0,
    });
    assert.ok(result.includes("All good"), `expected 'All good', got: ${result}`);
  });

  test("includes entry details when items are present", () => {
    const entry = makeEntry({
      id: "abc",
      filePath: "src/login.ts",
      lineRange: { start: 10, end: 20 },
      note: "Legacy session handling",
    });
    const result = formatReportResult({
      items: [{ entry, debtScore: 800, ageDays: 40, linesChanged: 20 }],
      threshold: 500,
      totalAboveThreshold: 1,
      snoozedCount: 0,
    });
    assert.ok(result.includes("src/login.ts"), "file path should appear");
    assert.ok(result.includes("Legacy session handling"), "note should appear");
    assert.ok(result.includes("800"), "debt score should appear");
  });

  test("mentions snoozed count when > 0", () => {
    const result = formatReportResult({
      items: [],
      threshold: 500,
      totalAboveThreshold: 0,
      snoozedCount: 3,
    });
    assert.ok(result.includes("3 snoozed") || result.includes("snoozed"), `expected snoozed mention, got: ${result}`);
  });
});
