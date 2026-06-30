// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { readLocalGraph } from "./readLocalGraph.js";

describe("readLocalGraph", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-graph-read-"));
    await fs.mkdir(path.join(tmp, ".kodela"), { recursive: true });
    const db = new DatabaseSync(path.join(tmp, ".kodela", "index.db"));
    db.exec(`
      CREATE TABLE decisions (id TEXT PRIMARY KEY, org_id TEXT, repo_id TEXT, title TEXT, category TEXT,
        status TEXT, visibility TEXT, problem TEXT, decision TEXT, reason TEXT, consequences TEXT,
        trade_offs TEXT, outcome TEXT, outcome_evidence TEXT, author_id TEXT, approver_ids TEXT, tags TEXT,
        superseded_by TEXT, supersedes TEXT, last_reviewed_at TEXT, decided_at TEXT, schema_version TEXT);
      CREATE TABLE decision_options (id TEXT PRIMARY KEY, decision_id TEXT, label TEXT, description TEXT,
        pros TEXT, cons TEXT, was_chosen INTEGER, rejection_reason TEXT, position INTEGER);
      CREATE TABLE decision_links (id TEXT PRIMARY KEY, decision_id TEXT, link_type TEXT, external_id TEXT, display_label TEXT);
      CREATE TABLE graph_edges (id TEXT PRIMARY KEY, org_id TEXT, edge_type TEXT, source_node_type TEXT,
        source_node_id TEXT, target_node_type TEXT, target_node_id TEXT, metadata TEXT, confidence REAL,
        extracted_by TEXT, capture_path TEXT, created_at TEXT, valid_from TEXT, valid_until TEXT, schema_version TEXT);
    `);
    db.prepare("INSERT INTO decisions (id, repo_id, title, status, problem, decision, reason, trade_offs, author_id, decided_at, schema_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("DEC-0001", "local-repo", "Tax on rounded subtotal", "active", "p", "d", "r", "churn", "human:dana", "2026-05-20T00:00:00.000Z", "1.0.0");
    db.prepare("INSERT INTO decision_options (id, decision_id, label, was_chosen) VALUES (?,?,?,?)")
      .run("opt-1", "DEC-0001", "Round then tax", 1);
    db.prepare("INSERT INTO decision_links (id, decision_id, link_type, external_id) VALUES (?,?,?,?)")
      .run("lnk-1", "DEC-0001", "entry", "entry-1");
    // one valid edge, one already-superseded edge (must be excluded)
    db.prepare("INSERT INTO graph_edges (id, org_id, edge_type, source_node_type, source_node_id, target_node_type, target_node_id, metadata, confidence, valid_from, valid_until) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("e1", "_default", "IMPLEMENTS", "FILE_CHANGE", "entry-1", "DECISION", "DEC-0001", '{"k":"v"}', 1, "2026-05-20T00:00:00.000Z", null);
    db.prepare("INSERT INTO graph_edges (id, org_id, edge_type, source_node_type, source_node_id, target_node_type, target_node_id, metadata, confidence, valid_from, valid_until) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("e2", "_default", "PRODUCED", "AI_SESSION", "sess-1", "FILE_CHANGE", "entry-1", "{}", 1, "2026-05-19T00:00:00.000Z", "2026-05-20T00:00:00.000Z");
    db.close();
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("dumps decisions/options/links + only currently-valid edges, in wire shape", async () => {
    const g = await readLocalGraph(tmp);
    assert.ok(g, "graph payload present");
    assert.equal(g!.decisions.length, 1);
    assert.equal(g!.decisions[0]!.tradeOffs, "churn"); // camelCase alias of trade_offs
    assert.equal(g!.decisions[0]!.authorId, "human:dana");
    assert.equal(g!.decisions[0]!.decidedAt, "2026-05-20T00:00:00.000Z");

    assert.equal(g!.decisionOptions.length, 1);
    assert.equal(g!.decisionOptions[0]!.decisionId, "DEC-0001");
    assert.equal(g!.decisionOptions[0]!.wasChosen, 1);

    assert.equal(g!.decisionLinks.length, 1);
    assert.equal(g!.decisionLinks[0]!.linkType, "entry");

    // only the still-valid edge travels; the superseded one is excluded
    assert.equal(g!.edges.length, 1);
    assert.equal(g!.edges[0]!.edgeType, "IMPLEMENTS");
    assert.deepEqual(g!.edges[0]!.metadata, { k: "v" }); // parsed from TEXT JSON
  });

  test("returns null when there is no .kodela/index.db", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-graph-none-"));
    try {
      assert.equal(await readLocalGraph(empty), null);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});
