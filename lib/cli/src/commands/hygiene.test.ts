// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 1 — `kodela hygiene` end-to-end. Seeds a temp repo with a clean entry
 * and an orphaned one, then confirms runHygiene surfaces the issue, the health
 * score drops below 100, severity filtering + limit work, and the text/json
 * formatters render the report.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { writeContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { runHygiene, formatHygieneResult } from "./hygiene.js";

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

const CLEAN = entry({
  id: "11111111-1111-4111-8111-111111111111",
  filePath: "src/clean.ts",
});
const ORPHAN = entry({
  id: "22222222-2222-4222-8222-222222222222",
  filePath: "src/gone.ts",
  status: "orphaned",
});

describe("kodela hygiene (Phase 1)", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-hygiene-"));
    await writeContextEntry(tmp, CLEAN);
    await writeContextEntry(tmp, ORPHAN);
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("surfaces the orphaned entry and drops the health score below 100", async () => {
    const result = await runHygiene({ repoRoot: tmp });
    assert.equal(result.report.totalEntries, 2);
    assert.equal(result.report.byKind.orphaned, 1);
    assert.equal(result.report.flaggedEntries, 1);
    assert.ok(result.report.healthScore < 100, "health score reflects the orphan");
    assert.equal(result.shown[0]?.entryIds[0], ORPHAN.id);
  });

  test("--min-severity high hides low-severity issues", async () => {
    const all = await runHygiene({ repoRoot: tmp });
    const highOnly = await runHygiene({ repoRoot: tmp, minSeverity: "high" });
    assert.ok(highOnly.shown.every((i) => i.severity === "high"));
    assert.ok(highOnly.shown.length <= all.shown.length);
    // The orphan is high-severity, so it survives the filter.
    assert.ok(highOnly.shown.some((i) => i.kind === "orphaned"));
  });

  test("limit caps the shown issues without changing the underlying report", async () => {
    const result = await runHygiene({ repoRoot: tmp, limit: 0 });
    assert.equal(result.shown.length, 0);
    assert.ok(result.report.issues.length >= 1, "report still holds all issues");
  });

  test("text and json formatters render the report", async () => {
    const result = await runHygiene({ repoRoot: tmp });
    const text = formatHygieneResult(result, "text");
    assert.match(text, /Memory health: \d+\/100/);
    assert.match(text, /orphaned/);
    const json = JSON.parse(formatHygieneResult(result, "json"));
    assert.equal(typeof json.healthScore, "number");
    assert.ok(Array.isArray(json.issues));
  });
});
