// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteStorage } from "./sqlite.js";
import type { UpsertEntryData } from "../storage.js";

function entry(over: Partial<UpsertEntryData>): UpsertEntryData {
  return {
    id: "e1",
    orgId: "org-1",
    repoId: "repo-1",
    sessionId: "sess-1",
    clusterId: null,
    filePath: "src/a.ts",
    schemaVersion: "1.0.0",
    status: "mapped",
    severity: "info",
    source: "ai",
    confidence: 0.9,
    scope: null,
    reviewRequired: false,
    note: "why",
    author: "dev",
    payload: "{}",
    ...over,
  };
}

describe("SqliteStorage — getEntriesForRepo (shared-memory read source)", () => {
  let dir: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-efr-"));
    storage = new SqliteStorage(path.join(dir, "efr.db"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("returns index-shaped rows scoped to (org, repo)", async () => {
    await storage.upsertEntry(entry({ id: "e1", clusterId: "c1", reviewRequired: true }));
    await storage.upsertEntry(entry({ id: "e2", filePath: "src/b.ts" }));

    const rows = await storage.getEntriesForRepo("org-1", "repo-1");
    assert.equal(rows.length, 2);
    const e1 = rows.find((r) => r.id === "e1")!;
    assert.equal(e1.filePath, "src/a.ts");
    assert.equal(e1.clusterId, "c1");
    assert.equal(e1.reviewRequired, true, "boolean coerced from integer column");
    assert.equal(typeof e1.confidence, "number");
    // encrypted note/payload are intentionally excluded from the context row
    assert.equal("note" in e1, false);
    assert.equal("payload" in e1, false);
  });

  test("never reads across tenants or repos", async () => {
    await storage.upsertEntry(entry({ id: "mine", orgId: "org-1", repoId: "repo-1" }));
    await storage.upsertEntry(entry({ id: "other-org", orgId: "org-2", repoId: "repo-1" }));
    await storage.upsertEntry(entry({ id: "other-repo", orgId: "org-1", repoId: "repo-2" }));

    const rows = await storage.getEntriesForRepo("org-1", "repo-1");
    assert.deepEqual(
      rows.map((r) => r.id),
      ["mine"],
      "only the (org-1, repo-1) entry is returned",
    );
  });

  test("returns [] when nothing matches", async () => {
    assert.deepEqual(await storage.getEntriesForRepo("org-1", "nope"), []);
  });
});
