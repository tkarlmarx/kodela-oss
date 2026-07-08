// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteStorage } from "./sqlite.js";
import type { UpsertEntryData } from "../storage.js";

function entry(over: Partial<UpsertEntryData> & { payload?: string }): UpsertEntryData {
  const id = over.id ?? "e1";
  const payload =
    over.payload ??
    JSON.stringify({
      id,
      note: over.note ?? "why this changed",
      tags: ["auth", "tokens"],
      lineRange: { start: 5, end: 20 },
    });
  return {
    id,
    orgId: "org-1",
    repoId: "repo-1",
    sessionId: "sess-1",
    clusterId: null,
    filePath: "src/auth/session.ts",
    schemaVersion: "1.1.0",
    status: "mapped",
    severity: "medium",
    source: "ai",
    confidence: 0.9,
    scope: null,
    reviewRequired: false,
    note: over.note ?? "why this changed",
    author: "dev",
    payload,
    ...over,
  };
}

describe("SqliteStorage — getRecallEntriesForRepo (shared-memory recall source)", () => {
  let dir: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-recall-"));
    storage = new SqliteStorage(path.join(dir, "recall.db"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("returns note + tags + lineRange reconstructed from payload", async () => {
    await storage.upsertEntry(entry({ id: "e1", note: "rotate refresh tokens on reuse" }));
    const rows = await storage.getRecallEntriesForRepo("org-1", "repo-1");
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r.note, "rotate refresh tokens on reuse");
    assert.deepEqual(r.tags, ["auth", "tokens"]);
    assert.deepEqual(r.lineRange, { start: 5, end: 20 });
    assert.equal(r.filePath, "src/auth/session.ts");
  });

  test("scopes strictly by (org, repo)", async () => {
    await storage.upsertEntry(entry({ id: "mine", orgId: "org-1", repoId: "repo-1" }));
    await storage.upsertEntry(entry({ id: "other-org", orgId: "org-2", repoId: "repo-1" }));
    await storage.upsertEntry(entry({ id: "other-repo", orgId: "org-1", repoId: "repo-2" }));
    const rows = await storage.getRecallEntriesForRepo("org-1", "repo-1");
    assert.deepEqual(rows.map((r) => r.id), ["mine"]);
  });

  test("degrades to safe defaults on a malformed payload (never throws)", async () => {
    await storage.upsertEntry(entry({ id: "bad", note: "kept", payload: "{not json" }));
    const rows = await storage.getRecallEntriesForRepo("org-1", "repo-1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.note, "kept", "note column survives a bad payload");
    assert.deepEqual(rows[0]!.tags, []);
    assert.deepEqual(rows[0]!.lineRange, { start: 0, end: 0 });
  });
});
