// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { pgTable, text, real, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

/**
 * Fused-graph parity (PR #1) — the SaaS mirror of the local `.kodela/index.db`
 * `graph_edges` table (`artifacts/mcp-server/src/lib/graph-store.ts`). This is
 * the heart of the fused memory graph: every typed edge between two nodes
 * (FILE_CHANGE —IMPLEMENTS→ DECISION, AI_SESSION —PRODUCED→ FILE_CHANGE,
 * FILE_CHANGE —CONTAINS_FUNCTION→ CODE_FUNCTION, …). The dashboard's
 * function-context traversal walks these edges to answer "what decision/PR/
 * incident is behind this function?".
 *
 * Bitemporal: a still-valid edge has `valid_until IS NULL`; superseding an edge
 * stamps `valid_until` rather than deleting, so `asOf` queries can reconstruct
 * the graph at any past time. Mirrors the local store's column space, with two
 * deliberate SaaS additions: `repo_id` (the local store is one DB per repo, so
 * it has no repo column) and `jsonb` metadata (the local store keeps it as a
 * TEXT JSON blob). The dedup unique key matches the local `ON CONFLICT` target
 * plus `repo_id`, so the same edge can exist independently per repo in an org.
 *
 * `edge_type` / `*_node_type` stay plain `text` — the node/edge taxonomy
 * (GraphNodeType / GraphEdgeType in graph-store.ts) is the source of truth and
 * evolves there, not in the database.
 */
export const graphEdgesTable = pgTable(
  "graph_edges",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    repoId: text("repo_id").notNull(),
    edgeType: text("edge_type").notNull(),
    sourceNodeType: text("source_node_type").notNull(),
    sourceNodeId: text("source_node_id").notNull(),
    targetNodeType: text("target_node_type").notNull(),
    targetNodeId: text("target_node_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    confidence: real("confidence").notNull().default(1),
    extractedBy: text("extracted_by").notNull().default("rule"),
    capturePath: text("capture_path").notNull().default("mcp"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    schemaVersion: text("schema_version").notNull().default("1.1.0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("graph_edges_org_id_idx").on(t.orgId),
    index("graph_edges_org_repo_idx").on(t.orgId, t.repoId),
    index("graph_edges_source_idx").on(t.sourceNodeType, t.sourceNodeId),
    index("graph_edges_target_idx").on(t.targetNodeType, t.targetNodeId),
    index("graph_edges_type_idx").on(t.edgeType),
    index("graph_edges_valid_idx").on(t.validFrom, t.validUntil),
    // Dedup key — also the ON CONFLICT target for idempotent upserts. Mirrors
    // the local store's unique index, scoped per repo.
    uniqueIndex("ux_graph_edges_dedup").on(
      t.orgId,
      t.repoId,
      t.edgeType,
      t.sourceNodeType,
      t.sourceNodeId,
      t.targetNodeType,
      t.targetNodeId,
    ),
  ],
);

export type GraphEdgeRow = typeof graphEdgesTable.$inferSelect;
export type InsertGraphEdge = typeof graphEdgesTable.$inferInsert;
