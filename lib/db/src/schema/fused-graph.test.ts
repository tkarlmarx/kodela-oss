// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Fused-graph parity (PR #1) — schema tests for the four SaaS tables that
 * mirror the local `.kodela/index.db` graph store: decisions, decision_options,
 * decision_links, graph_edges.
 *
 * Community Edition variant: only the "shape" suite ships here. It proves the
 * tables are registered in the barrel and carry the columns + dedup index the
 * dashboard readers depend on — all of which is verifiable from the schema
 * objects alone, with no database. The Postgres "round-trip" suite needs the
 * Drizzle `db` handle, which lives only in the upstream (commercial) repo and
 * is therefore not exported from the CE `lib/db` barrel; it stays in the
 * private/enterprise repo. (Mirrored to CE via `rewriteFiles` in
 * community.config.json.)
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  decisionsTable,
  decisionOptionsTable,
  decisionLinksTable,
  graphEdgesTable,
} from "../index.js";

describe("fused-graph schema — shape (no DB)", () => {
  const sqlNames = (table: Parameters<typeof getTableConfig>[0]) =>
    new Set(getTableConfig(table).columns.map((c) => c.name));

  test("decisions carries the columns the decisions reader needs", () => {
    const cols = sqlNames(decisionsTable);
    for (const c of ["id", "org_id", "repo_id", "title", "category", "status", "problem", "decision", "reason", "author_id", "decided_at"]) {
      assert.ok(cols.has(c), `decisions missing ${c}`);
    }
  });

  test("decision_options + decision_links are org-scoped and FK to decisions", () => {
    assert.ok(sqlNames(decisionOptionsTable).has("org_id"));
    assert.ok(sqlNames(decisionOptionsTable).has("decision_id"));
    assert.ok(sqlNames(decisionOptionsTable).has("was_chosen"));
    assert.ok(sqlNames(decisionLinksTable).has("org_id"));
    assert.ok(sqlNames(decisionLinksTable).has("decision_id"));
    assert.ok(sqlNames(decisionLinksTable).has("link_type"));
    assert.ok(sqlNames(decisionLinksTable).has("external_id"));
  });

  test("graph_edges carries the fused-edge columns + bitemporal validity", () => {
    const cols = sqlNames(graphEdgesTable);
    for (const c of ["id", "org_id", "repo_id", "edge_type", "source_node_type", "source_node_id", "target_node_type", "target_node_id", "metadata", "confidence", "valid_from", "valid_until"]) {
      assert.ok(cols.has(c), `graph_edges missing ${c}`);
    }
  });

  test("graph_edges has the unique dedup index (the ON CONFLICT target)", () => {
    const { indexes } = getTableConfig(graphEdgesTable);
    const dedup = indexes.find((i) => i.config.name === "ux_graph_edges_dedup");
    assert.ok(dedup, "ux_graph_edges_dedup index present");
    assert.equal(dedup?.config.unique, true);
    const onCols = (dedup?.config.columns ?? []).map((c) => (c as { name?: string }).name);
    for (const c of ["org_id", "repo_id", "edge_type", "source_node_id", "target_node_id"]) {
      assert.ok(onCols.includes(c), `dedup index missing ${c}`);
    }
  });
});

describe("fused-graph schema — round-trip (Postgres)", () => {
  test("skipped: Postgres round-trip lives in the commercial repo (CE is local SQLite)", () => {
    assert.ok(true);
  });
});
