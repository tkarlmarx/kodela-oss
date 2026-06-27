// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Tests for the kodela_get_fused_context tool (Sprint 1 / [E.4]).
 *
 * Asserts the wedge-demo invariant: a single call returns entries + sessions
 * for the queried file with the correct linkage between them (each session's
 * `linked_entries` matches the entry IDs returned in the same envelope).
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
  upsertCluster,
  upsertSession,
  writeContextEntry,
  writeSession,
  type EntryRow,
  type ContextEntry,
  type KodelaSession,
  type ClusterRow,
  type SessionRow,
} from "@kodela/core";
import { getFusedContext } from "./get-fused-context.js";

let tmpRepo: string;
let db: DatabaseSync;

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLUSTER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENTRY_A    = "11111111-1111-4111-8111-111111111111";
const ENTRY_B    = "22222222-2222-4222-8222-222222222222";

function makeEntry(id: string, filePath: string, note: string): ContextEntry {
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
    severity: "high",
    tags: [],
    source: "ai",
    aiTool: "claude-code",
    confidence: 0.9,
    status: "mapped",
    reviewRequired: false,
    sessionId: SESSION_ID,
    clusterId: CLUSTER_ID,
    summary: { intent: "fix", changeType: "modification", risk: "high", shortSummary: "fix" },
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
    sessionId: e.sessionId ?? null,
    clusterId: e.clusterId ?? null,
    reviewRequired: e.reviewRequired,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

before(async () => {
  tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-fused-test-"));
  await fs.mkdir(path.join(tmpRepo, ".kodela"), { recursive: true });
  db = openIndex(path.join(tmpRepo, ".kodela", "index.db"));

  const eA = makeEntry(ENTRY_A, "src/auth/session.ts", "Rotate refresh token on use");
  const eB = makeEntry(ENTRY_B, "src/auth/session.ts", "Stamp lastSeen on touch");
  for (const e of [eA, eB]) {
    await writeContextEntry(tmpRepo, e);
    upsertEntry(db, rowFor(e));
  }

  // The cluster-aware builder walks clusters → entries → sessions, so all
  // three rows must exist in the SQLite index for the entries to be returned.
  const cluster: ClusterRow = {
    id: CLUSTER_ID,
    sessionId: SESSION_ID,
    clusterIndex: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:15:00.000Z",
    triggerType: "new_prompt",
    goal: "rotate refresh token on every use",
    scope: "src/auth/",
    eventCount: 2,
    aggregatedRisk: "high",
    filesChanged: JSON.stringify(["src/auth/session.ts"]),
    version: 1,
    parentId: null,
    supersededBy: null,
  };
  upsertCluster(db, cluster);

  const sessionRow: SessionRow = {
    id: SESSION_ID,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:15:00.000Z",
    model: "claude-opus",
    clusterCount: 1,
    totalFiles: 1,
    aggregatedRisk: "high",
    filesChanged: JSON.stringify(["src/auth/session.ts"]),
  };
  upsertSession(db, sessionRow);

  // Also write the file-based session record (used by the storage helpers
  // outside the SQLite-index path).
  const session: KodelaSession = {
    id: SESSION_ID,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:15:00.000Z",
    entries: [ENTRY_A, ENTRY_B],
    aggregatedRisk: "high",
    filesChanged: ["src/auth/session.ts"],
    goal: "rotate refresh token on every use",
  } as KodelaSession;
  await writeSession(tmpRepo, session);
});

after(async () => {
  db.close();
  await fs.rm(tmpRepo, { recursive: true, force: true });
});

describe("kodela_get_fused_context", () => {
  test("envelope type is 'kodela.context.fused' (distinct from plain get_context)", () => {
    const envelope = getFusedContext(
      tmpRepo,
      { file_path: "src/auth/session.ts", token_budget: 4000 },
      db,
    );
    assert.equal(envelope.type, "kodela.context.fused");
    assert.equal(envelope.version, "1.0");
  });

  test("returns entries + sessions in one call (the wedge invariant)", () => {
    const envelope = getFusedContext(
      tmpRepo,
      { file_path: "src/auth/session.ts", token_budget: 4000 },
      db,
    );
    // Entries half (existing get_context shape)
    assert.ok(
      envelope.context.entries.length >= 2,
      `expected ≥2 entries, got ${envelope.context.entries.length}`,
    );
    // Sessions half (the NEW capability)
    assert.ok(envelope.context.sessions, "sessions array must be present");
    assert.equal(envelope.context.sessions!.length, 1);
    const sess = envelope.context.sessions![0]!;
    assert.equal(sess.session_id, SESSION_ID);
    assert.equal(sess.aggregated_risk, "high");
    assert.deepEqual(sess.files_changed, ["src/auth/session.ts"]);
    assert.equal(sess.entry_count, 2);
    // Note: session.goal comes from the cluster, not the session, in
    // buildProjectContext's output — so it's expected to be undefined here.
    // The cluster's goal is surfaced via `envelope.context.clusters[].label`.
  });

  test("linked_entries cross-references the entry IDs returned in the same envelope", () => {
    const envelope = getFusedContext(
      tmpRepo,
      { file_path: "src/auth/session.ts", token_budget: 4000 },
      db,
    );
    const sess = envelope.context.sessions![0]!;
    const returnedEntryIds = new Set(envelope.context.entries.map((e) => e.id));
    // Every linked_entries id must exist in the returned entries array.
    for (const linkedId of sess.linked_entries) {
      assert.ok(
        returnedEntryIds.has(linkedId),
        `linked_entries ${linkedId} not in returned entries`,
      );
    }
    // And we expect AT LEAST one linkage (otherwise the fusion isn't useful).
    assert.ok(sess.linked_entries.length >= 1);
  });

  test("omits sessions array when no sessions touch the queried file", () => {
    const envelope = getFusedContext(
      tmpRepo,
      { file_path: "src/unrelated/file.ts", token_budget: 4000 },
      db,
    );
    // No entries match this file; no sessions should be surfaced either.
    // The plain get_context fields still come back; sessions is omitted.
    assert.equal(envelope.context.sessions, undefined);
  });
});
