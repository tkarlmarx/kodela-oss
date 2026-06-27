// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runArchive, formatArchiveResult } from "./archive.js";
import { runInit } from "./init.js";
import { writeContextEntry, readIndex } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";

const PLACEHOLDER_HASH = "a".repeat(64);

function makeOldOrphan(id: string, filePath: string): ContextEntry {
  return {
    schemaVersion: "1.1.0",
    id,
    filePath,
    astAnchor: null,
    contentHash: PLACEHOLDER_HASH,
    lineRange: { start: 1, end: 5 },
    note: "Old orphaned entry",
    author: "alice",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    severity: "low",
    tags: [],
    source: "human",
    confidence: 0,
    status: "orphaned",
    reviewRequired: false,
  };
}

describe("runArchive", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-archive-test-"));
    await runInit(tmpDir);
    await writeContextEntry(tmpDir, makeOldOrphan(
      "550e8400-e29b-41d4-a716-446655440001",
      "old-file.ts",
    ));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("archives orphaned entries older than maxDays", async () => {
    const result = await runArchive({ repoRoot: tmpDir, maxDays: 1 });
    assert.equal(result.archived, 1);
    assert.equal(result.archivedEntries[0]?.filePath, "old-file.ts");
    assert.ok(result.archivePath);
  });

  test("entry is removed from index after archiving", async () => {
    const index = await readIndex(tmpDir);
    assert.equal(index.entries.length, 0);
  });

  test("returns zero archived for fresh entries (not old enough)", async () => {
    const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-archive-fresh-"));
    try {
      await runInit(freshDir);
      await writeContextEntry(freshDir, makeOldOrphan(
        "550e8400-e29b-41d4-a716-446655440002",
        "fresh.ts",
      ));
      const result = await runArchive({ repoRoot: freshDir, maxDays: 9999 });
      assert.equal(result.archived, 0);
    } finally {
      await fs.rm(freshDir, { recursive: true, force: true });
    }
  });

  test("dry run does not delete from index", async () => {
    const dryDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-archive-dry-"));
    try {
      await runInit(dryDir);
      await writeContextEntry(dryDir, makeOldOrphan(
        "550e8400-e29b-41d4-a716-446655440003",
        "dry.ts",
      ));
      const result = await runArchive({ repoRoot: dryDir, maxDays: 1, dryRun: true });
      assert.equal(result.archived, 1);
      assert.equal(result.dryRun, true);
      assert.equal(result.archivePath, undefined);
      const index = await readIndex(dryDir);
      assert.equal(index.entries.length, 1);
    } finally {
      await fs.rm(dryDir, { recursive: true, force: true });
    }
  });
});

describe("formatArchiveResult", () => {
  test("shows archived count when entries were archived", () => {
    const msg = formatArchiveResult({
      total: 5, archived: 2, skipped: 3,
      archivedEntries: [], dryRun: false, archivePath: "archives/test.json",
    });
    assert.ok(msg.includes("Archived 2 entr"));
  });

  test("shows no eligible entries when archived is 0", () => {
    const msg = formatArchiveResult({
      total: 5, archived: 0, skipped: 5, archivedEntries: [], dryRun: false,
    });
    assert.ok(msg.includes("No entries eligible"));
  });
});
