// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Smoke test for kodela_query's entry disk-walk.
 *
 * The decisions branch is covered in decisions.test.ts; this exercises the
 * harder path: getEntryIds (SQLite index) → readContextEntry (disk object) →
 * weighted scoring → filters → facets. Entries are written both to the index
 * (upsertEntry) and to disk (writeContextEntry) because the walk reads ids from
 * the index but text from the object files.
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
  buildEmbeddingIndex,
  embedTextLocal,
  type EntryRow,
  type ContextEntry,
} from "@kodela/core";
import { queryForMcp } from "./query.js";

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
    lineRange: { start: 1, end: 10 },
    note,
    author: "tester",
    createdAt: now,
    updatedAt: now,
    severity,
    tags: ["alpha"],
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

// Pin the embedding engine to the dependency-free hash so the query side
// resolves the SAME 256-dim vectors the fixtures are built with — deterministic
// whether or not the host has the optional ONNX runtime installed.
process.env["KODELA_EMBEDDING_PROVIDER"] = "local-hash";

before(async () => {
  tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-query-test-"));
  await fs.mkdir(path.join(tmpRepo, ".kodela"), { recursive: true });
  db = openIndex(path.join(tmpRepo, ".kodela", "index.db"));

  const hit = makeEntry(
    "11111111-1111-4111-8111-111111111111",
    "src/payments/processor.ts",
    "Chose Drizzle ORM for the payment ledger writes.",
    "migrate payment writes to Drizzle",
    "high",
  );
  const miss = makeEntry(
    "22222222-2222-4222-8222-222222222222",
    "src/util/log.ts",
    "Adjusted the logger format string.",
    "tidy logging output",
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

describe("kodela_query (entry disk-walk)", () => {
  test("finds the matching entry, excludes the non-match, populates facets", async () => {
    const r = await queryForMcp(
      tmpRepo,
      {
        query: "Drizzle",
        mode: "keyword",
        include: { entries: true, decisions: false, sessions: false },
        limit: 20,
        token_budget: 8000,
      },
      db,
    );
    assert.equal(r.ok, true, `query failed: ${r.error}`);
    const entryResults = r.results!.filter((x) => x.kind === "entry");
    assert.equal(entryResults.length, 1, "expected exactly one entry match");
    assert.equal(entryResults[0].id, "11111111-1111-4111-8111-111111111111");
    assert.equal(entryResults[0].metadata.file_path, "src/payments/processor.ts");
    assert.equal(r.meta!.entries_scanned, 2);
    assert.equal(r.meta!.scan_capped, false);
    assert.equal(r.facets!.by_severity.high, 1);
    assert.equal(r.facets!.by_source.ai, 1);
  });

  test("severity filter narrows the entry set", async () => {
    const r = await queryForMcp(
      tmpRepo,
      {
        query: "Drizzle",
        mode: "keyword",
        filters: { severity: ["low"] },
        include: { entries: true, decisions: false, sessions: false },
        limit: 20,
        token_budget: 8000,
      },
      db,
    );
    assert.equal(r.ok, true);
    // The only "Drizzle" entry is severity=high, so a low-only filter drops it.
    assert.equal(r.results!.filter((x) => x.kind === "entry").length, 0);
  });

  test("semantic mode ranks the vector-relevant entry via embeddings", async () => {
    // Generate embeddings (offline, local) for the two fixture notes.
    await buildEmbeddingIndex(
      tmpRepo,
      [
        { entryId: "11111111-1111-4111-8111-111111111111", note: "Chose Drizzle ORM for the payment ledger writes." },
        { entryId: "22222222-2222-4222-8222-222222222222", note: "Adjusted the logger format string." },
      ],
      (t: string) => embedTextLocal(t),
    );

    // Query shares VOCABULARY with the hit (ledger, payment) but no contiguous
    // substring, so only the vector path can surface it — keyword score is 0.
    const r = await queryForMcp(
      tmpRepo,
      {
        query: "ledger payment persistence layer",
        mode: "semantic",
        include: { entries: true, decisions: false, sessions: false },
        limit: 20,
        token_budget: 8000,
      },
      db,
    );
    assert.equal(r.ok, true, `query failed: ${r.error}`);
    assert.equal(r.meta!.mode_used, "semantic");
    const entries = r.results!.filter((x) => x.kind === "entry");
    assert.ok(entries.length >= 1, "semantic search should surface the ledger entry");
    assert.equal(entries[0].id, "11111111-1111-4111-8111-111111111111");
  });

  test("hybrid mode fuses keyword + vector via RRF, normalised to [0,1]", async () => {
    await buildEmbeddingIndex(
      tmpRepo,
      [
        { entryId: "11111111-1111-4111-8111-111111111111", note: "Chose Drizzle ORM for the payment ledger writes." },
        { entryId: "22222222-2222-4222-8222-222222222222", note: "Adjusted the logger format string." },
      ],
      (t: string) => embedTextLocal(t),
    );
    const r = await queryForMcp(
      tmpRepo,
      {
        query: "Drizzle", // matches the hit in BOTH keyword and vector
        mode: "hybrid",
        include: { entries: true, decisions: false, sessions: false },
        limit: 20,
        token_budget: 8000,
      },
      db,
    );
    assert.equal(r.ok, true, `query failed: ${r.error}`);
    assert.equal(r.meta!.mode_used, "hybrid");
    const entries = r.results!.filter((x) => x.kind === "entry");
    assert.equal(entries[0]!.id, "11111111-1111-4111-8111-111111111111");
    assert.ok(entries[0]!.score > 0 && entries[0]!.score <= 1, "RRF score normalised to [0,1]");
  });
});
