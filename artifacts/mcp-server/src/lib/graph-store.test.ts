// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 3 of docs/Business/execution-plan/23-catch-up-implementation-plan-2026q3.md.
 *
 * Pins the bitemporal contract on graph_edges: idempotent migration,
 * valid_from backfill on legacy rows, the (valid_from, valid_until)
 * window query, and supersedeEdge atomicity.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ensureGraphTables,
  insertEdge,
  selectEdgesValidAt,
  supersedeEdge,
} from "./graph-store.js";

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kodela-graphstore-test-"));
  dbPath = path.join(tmpDir, "index.db");
  db = new DatabaseSync(dbPath);
});

after(() => {
  try { db.close(); } catch { /* swallow */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper — fetch every row from graph_edges for direct field assertions. */
function readAllRows(): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM graph_edges").all() as Array<Record<string, unknown>>;
}

describe("graph-store bitemporal migration", () => {
  test("ensureGraphTables is idempotent — running twice produces identical schema", () => {
    ensureGraphTables(db);
    ensureGraphTables(db);

    const cols = db.prepare("PRAGMA table_info(graph_edges)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    assert.ok(names.includes("valid_from"));
    assert.ok(names.includes("valid_until"));
    assert.ok(names.includes("created_at"));
  });

  test("backfills valid_from = created_at on a legacy row", () => {
    // Simulate a pre-bitemporal row by writing one then nulling valid_from.
    const legacyId = "legacy-edge-aaa";
    db.exec(
      `INSERT INTO graph_edges (
         id, org_id, edge_type,
         source_node_type, source_node_id, target_node_type, target_node_id,
         metadata, confidence, extracted_by, capture_path,
         created_at, valid_from, valid_until, schema_version
       ) VALUES (
         '${legacyId}', '_default', 'AUTHORED',
         'USER', 'alice', 'DECISION', 'DEC-0001',
         '{}', 1.0, 'rule', 'mcp',
         '2026-01-01T00:00:00.000Z', NULL, NULL, '1.0.0'
       )`,
    );

    // The migration should fill the null valid_from on next ensure.
    ensureGraphTables(db);

    const row = db
      .prepare("SELECT valid_from, created_at FROM graph_edges WHERE id = ?")
      .get(legacyId) as { valid_from: string; created_at: string };
    assert.equal(row.valid_from, row.created_at);
    assert.equal(row.valid_from, "2026-01-01T00:00:00.000Z");
  });
});

describe("insertEdge bitemporal stamping", () => {
  test("stamps valid_from = now on first insert and leaves valid_until NULL", () => {
    const now = "2026-06-20T00:00:00.000Z";
    insertEdge(db, {
      edge_type: "AUTHORED",
      source_node_type: "USER",
      source_node_id: "bob",
      target_node_type: "DECISION",
      target_node_id: "DEC-0002",
    }, now);

    const row = db
      .prepare(
        "SELECT valid_from, valid_until FROM graph_edges WHERE source_node_id = ?",
      )
      .get("bob") as { valid_from: string; valid_until: string | null };
    assert.equal(row.valid_from, now);
    assert.equal(row.valid_until, null);
  });

  test("ON CONFLICT does not reset valid_from on a re-assertion", () => {
    const first = "2026-06-21T00:00:00.000Z";
    const second = "2026-06-22T00:00:00.000Z";
    insertEdge(db, {
      edge_type: "AUTHORED",
      source_node_type: "USER",
      source_node_id: "carol",
      target_node_type: "DECISION",
      target_node_id: "DEC-0003",
      confidence: 0.5,
    }, first);

    insertEdge(db, {
      edge_type: "AUTHORED",
      source_node_type: "USER",
      source_node_id: "carol",
      target_node_type: "DECISION",
      target_node_id: "DEC-0003",
      confidence: 0.9,
    }, second);

    const row = db
      .prepare(
        "SELECT valid_from, valid_until, confidence FROM graph_edges WHERE source_node_id = ?",
      )
      .get("carol") as { valid_from: string; valid_until: string | null; confidence: number };
    assert.equal(row.valid_from, first, "valid_from must NOT change on re-assertion");
    assert.equal(row.valid_until, null);
    assert.equal(row.confidence, 0.9, "MAX(confidence) wins");
  });

  test("re-asserting a previously-superseded edge clears valid_until", () => {
    const created = "2026-06-23T00:00:00.000Z";
    const retired = "2026-06-24T00:00:00.000Z";
    const re_asserted = "2026-06-25T00:00:00.000Z";

    insertEdge(db, {
      edge_type: "AUTHORED",
      source_node_type: "USER",
      source_node_id: "dave",
      target_node_type: "DECISION",
      target_node_id: "DEC-0004",
    }, created);

    const edgeId = (db
      .prepare("SELECT id FROM graph_edges WHERE source_node_id = ?")
      .get("dave") as { id: string }).id;
    supersedeEdge(db, edgeId, retired);

    insertEdge(db, {
      edge_type: "AUTHORED",
      source_node_type: "USER",
      source_node_id: "dave",
      target_node_type: "DECISION",
      target_node_id: "DEC-0004",
    }, re_asserted);

    const row = db
      .prepare("SELECT valid_until FROM graph_edges WHERE id = ?")
      .get(edgeId) as { valid_until: string | null };
    assert.equal(row.valid_until, null, "re-assertion must clear valid_until");
  });
});

describe("supersedeEdge", () => {
  test("sets valid_until to the provided instant and returns 1", () => {
    insertEdge(db, {
      edge_type: "APPROVED",
      source_node_type: "USER",
      source_node_id: "erin",
      target_node_type: "DECISION",
      target_node_id: "DEC-0005",
    }, "2026-06-26T00:00:00.000Z");

    const edgeId = (db
      .prepare("SELECT id FROM graph_edges WHERE source_node_id = ?")
      .get("erin") as { id: string }).id;

    const retired = "2026-06-27T00:00:00.000Z";
    const changes = supersedeEdge(db, edgeId, retired);
    assert.equal(changes, 1);

    const row = db
      .prepare("SELECT valid_until FROM graph_edges WHERE id = ?")
      .get(edgeId) as { valid_until: string };
    assert.equal(row.valid_until, retired);
  });

  test("returns 0 when called on a non-existent edge id", () => {
    const changes = supersedeEdge(db, "no-such-edge", "2026-06-28T00:00:00.000Z");
    assert.equal(changes, 0);
  });
});

describe("selectEdgesValidAt", () => {
  before(() => {
    // Drop and re-seed a small fixture so the asOf assertions are precise.
    db.exec("DELETE FROM graph_edges");

    insertEdge(db, {
      edge_type: "AUTHORED",
      source_node_type: "USER",
      source_node_id: "still-valid",
      target_node_type: "DECISION",
      target_node_id: "DEC-A",
    }, "2026-05-01T00:00:00.000Z");

    insertEdge(db, {
      edge_type: "AUTHORED",
      source_node_type: "USER",
      source_node_id: "retired",
      target_node_type: "DECISION",
      target_node_id: "DEC-B",
    }, "2026-05-05T00:00:00.000Z");
    // Retire the 'retired' edge as of 2026-05-10.
    const retiredId = (db
      .prepare("SELECT id FROM graph_edges WHERE source_node_id = ?")
      .get("retired") as { id: string }).id;
    supersedeEdge(db, retiredId, "2026-05-10T00:00:00.000Z");

    insertEdge(db, {
      edge_type: "AUTHORED",
      source_node_type: "USER",
      source_node_id: "future",
      target_node_type: "DECISION",
      target_node_id: "DEC-C",
    }, "2026-07-01T00:00:00.000Z");
  });

  test("returns only edges valid at the asOf instant (point-in-time)", () => {
    const rows = selectEdgesValidAt(db, "2026-06-15T00:00:00.000Z");
    const sources = rows.map((r) => r.source_node_id).sort();
    assert.deepEqual(sources, ["still-valid"]);
  });

  test("includes retired edge when asOf is before the retirement", () => {
    const rows = selectEdgesValidAt(db, "2026-05-07T00:00:00.000Z");
    const sources = rows.map((r) => r.source_node_id).sort();
    assert.deepEqual(sources, ["retired", "still-valid"]);
  });

  test("excludes a still-future edge when asOf is before its valid_from", () => {
    const rows = selectEdgesValidAt(db, "2026-06-15T00:00:00.000Z");
    assert.ok(!rows.some((r) => r.source_node_id === "future"));
  });

  test("hydrates valid_from + valid_until on the returned EdgeRow", () => {
    const rows = selectEdgesValidAt(db, "2026-06-15T00:00:00.000Z");
    const stillValid = rows.find((r) => r.source_node_id === "still-valid")!;
    assert.equal(stillValid.valid_from, "2026-05-01T00:00:00.000Z");
    assert.equal(stillValid.valid_until, null);
  });

  test("orgId filter respected when provided", () => {
    const rows = selectEdgesValidAt(db, "2026-06-15T00:00:00.000Z", { orgId: "_default" });
    assert.ok(rows.length >= 1);
    const wrong = selectEdgesValidAt(db, "2026-06-15T00:00:00.000Z", { orgId: "no-such-org" });
    assert.equal(wrong.length, 0);
  });
});
