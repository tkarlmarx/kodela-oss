// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * kodela_recall (Phase 1) — the agent-facing recall tool. Seeds a temp repo
 * (index + disk objects, like query.test.ts) and confirms recall (a) returns a
 * ranked, injectable block for an explicit query, (b) auto-derives the query
 * from the latest session goal when none is given, and (c) degrades to an
 * explicit "nothing to recall" note when there is neither a query nor a goal.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import {
  openIndex,
  upsertEntry,
  writeContextEntry,
  writeSession,
  type EntryRow,
  type ContextEntry,
  type KodelaSession,
} from "@kodela/core";
import { recallForMcp } from "./recall.js";

// Deterministic offline embedding engine (matches query.test.ts).
process.env["KODELA_EMBEDDING_PROVIDER"] = "local-hash";

let tmpRepo: string;
let db: DatabaseSync;

function makeEntry(
  id: string,
  filePath: string,
  note: string,
  intent: string,
  severity: ContextEntry["severity"],
): ContextEntry {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: "1.1.0",
    id,
    filePath,
    astAnchor: { kind: "function", name: "fn", blockHash: "deadbeef" },
    contentHash: "hash-" + id,
    lineRange: { start: 4, end: 12 },
    note,
    author: "tester",
    createdAt: now,
    updatedAt: now,
    severity,
    tags: ["auth"],
    source: "ai",
    aiTool: "claude-code",
    confidence: 0.9,
    status: "mapped",
    reviewRequired: false,
    summary: { intent, changeType: "modification", risk: "low", shortSummary: intent },
  };
}

function rowFor(e: ContextEntry): EntryRow {
  return {
    id: e.id,
    filePath: e.filePath,
    schemaVersion: e.schemaVersion,
    status: e.status,
    severity: e.severity,
    source: e.source,
    confidence: e.confidence,
    scope: null,
    sessionId: null,
    clusterId: null,
    reviewRequired: e.reviewRequired,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

const HIT_ID = "11111111-1111-4111-8111-111111111111";
const MISS_ID = "22222222-2222-4222-8222-222222222222";

before(async () => {
  tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-recall-mcp-"));
  await fs.mkdir(path.join(tmpRepo, ".kodela"), { recursive: true });
  db = openIndex(path.join(tmpRepo, ".kodela", "index.db"));

  const hit = makeEntry(
    HIT_ID,
    "src/auth/login.ts",
    "throttle brute force with a rate limit on the login endpoint to stop credential stuffing",
    "add a login rate limit",
    "high",
  );
  const miss = makeEntry(
    MISS_ID,
    "src/util/log.ts",
    "tidy the logger format string",
    "logging cleanup",
    "low",
  );
  for (const e of [hit, miss]) {
    await writeContextEntry(tmpRepo, e);
    upsertEntry(db, rowFor(e));
  }
});

after(async () => {
  db.close();
  await fs.rm(tmpRepo, { recursive: true, force: true });
});

describe("kodela_recall (Phase 1)", () => {
  test("explicit query returns a ranked, injectable block for the best hit", async () => {
    const r = await recallForMcp(tmpRepo, { query: "login rate limit", limit: 8 }, db);
    assert.equal(r.ok, true, `recall failed: ${r.error}`);
    assert.equal(r.auto_query, false);
    assert.ok(r.items!.length >= 1, "at least one item recalled");
    assert.equal(r.items![0]!.ref, "src/auth/login.ts:4-12", "the login answer ranks first");
    assert.match(r.block!, /## Relevant prior context for "login rate limit"/);
    assert.match(r.block!, /src\/auth\/login\.ts:4-12/);
  });

  test("no query auto-recalls from the latest session goal", async () => {
    const mkSession = (id: string, startedAt: string, goal: string): KodelaSession => ({
      id,
      startedAt,
      entries: [],
      aggregatedRisk: "low",
      filesChanged: [],
      goal,
    });
    await writeSession(tmpRepo, mkSession("s-old", "2026-04-01T00:00:00.000Z", "logging cleanup"));
    await writeSession(tmpRepo, mkSession("s-new", "2026-06-01T00:00:00.000Z", "login rate limit"));

    const r = await recallForMcp(tmpRepo, { limit: 8 }, db);
    assert.equal(r.ok, true, `recall failed: ${r.error}`);
    assert.equal(r.auto_query, true, "query was auto-derived");
    assert.equal(r.query, "login rate limit", "uses the most recent session goal");
    assert.match(r.block!, /for this task/);
    assert.equal(r.items![0]!.ref, "src/auth/login.ts:4-12");
  });

  test("no query and no session goal yields an explicit 'nothing to recall' note", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-recall-mcp-bare-"));
    await fs.mkdir(path.join(bare, ".kodela"), { recursive: true });
    const bareDb = openIndex(path.join(bare, ".kodela", "index.db"));
    try {
      const r = await recallForMcp(bare, { limit: 8 }, bareDb);
      assert.equal(r.ok, true);
      assert.equal(r.auto_query, false);
      assert.equal(r.items!.length, 0);
      assert.match(r.block!, /Nothing to recall/);
    } finally {
      bareDb.close();
      await fs.rm(bare, { recursive: true, force: true });
    }
  });
});
