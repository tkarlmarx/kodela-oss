// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { findRepoRoot, loadAllEntries, saveEntry, removeEntry } from "./bridge.js";
import { writeContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { runInit } from "@kodela/cli";

const PLACEHOLDER_HASH = "a".repeat(64);

function makeEntry(id: string, filePath = "src/auth.ts"): ContextEntry {
  return {
    schemaVersion: "1.1.0",
    id,
    filePath,
    astAnchor: null,
    contentHash: PLACEHOLDER_HASH,
    lineRange: { start: 1, end: 5 },
    note: "Test annotation",
    author: "alice",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    severity: "low",
    tags: [],
    source: "human",
    confidence: 0.9,
    status: "mapped",
    reviewRequired: false,
  };
}

describe("findRepoRoot", () => {
  test("returns the input directory when not a git repo", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-bridge-"));
    try {
      const result = await findRepoRoot(tmpDir);
      assert.equal(result, tmpDir);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns a non-empty string for any directory", async () => {
    const result = await findRepoRoot(process.cwd());
    assert.ok(typeof result === "string" && result.length > 0);
  });
});

describe("loadAllEntries", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-bridge-entries-"));
    await runInit(tmpDir);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array for fresh repo", async () => {
    const entries = await loadAllEntries(tmpDir);
    assert.deepEqual(entries, []);
  });

  test("returns entries after writing them", async () => {
    const entry = makeEntry("550e8400-e29b-41d4-a716-446655440001");
    await writeContextEntry(tmpDir, entry);
    const entries = await loadAllEntries(tmpDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, "550e8400-e29b-41d4-a716-446655440001");
  });

  test("returns empty array when directory does not exist", async () => {
    const entries = await loadAllEntries("/nonexistent/path/xyz");
    assert.deepEqual(entries, []);
  });
});

describe("saveEntry and removeEntry", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-bridge-save-"));
    await runInit(tmpDir);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("saveEntry persists an entry readable by loadAllEntries", async () => {
    const entry = makeEntry("550e8400-e29b-41d4-a716-446655440002");
    await saveEntry(tmpDir, entry);
    const entries = await loadAllEntries(tmpDir);
    assert.ok(entries.some((e) => e.id === "550e8400-e29b-41d4-a716-446655440002"));
  });

  test("removeEntry deletes an entry from storage", async () => {
    const entry = makeEntry("550e8400-e29b-41d4-a716-446655440003");
    await saveEntry(tmpDir, entry);
    await removeEntry(tmpDir, "550e8400-e29b-41d4-a716-446655440003");
    const entries = await loadAllEntries(tmpDir);
    assert.ok(!entries.some((e) => e.id === "550e8400-e29b-41d4-a716-446655440003"));
  });
});
