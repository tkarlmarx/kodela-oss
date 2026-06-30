// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

/**
 * Fused-graph parity (doc `fused-graph-postgres-parity.md`, PR #1) — the SaaS
 * mirror of the local `.kodela/index.db` `decisions` table written by the MCP
 * server (`artifacts/mcp-server/src/lib/graph-store.ts`). A decision is the
 * human-authored *why* a file/function exists; the dashboard's decisions and
 * function-context readers resolve `graph_edges` IMPLEMENTS targets back to
 * these rows.
 *
 * `org_id` is the multi-tenant isolation column — every read MUST filter on it
 * (P6.5 / P6.6 row-filter audit). `status` / `category` / `visibility` stay
 * plain `text` to mirror the local store, whose value space evolves with the
 * MCP decision schema rather than the database.
 */
export const decisionsTable = pgTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    repoId: text("repo_id").notNull(),
    title: text("title").notNull(),
    category: text("category"),
    status: text("status").notNull(),
    visibility: text("visibility"),
    problem: text("problem").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason").notNull(),
    consequences: text("consequences"),
    tradeOffs: text("trade_offs"),
    outcome: text("outcome"),
    outcomeEvidence: text("outcome_evidence"),
    outcomeRecordedAt: timestamp("outcome_recorded_at", { withTimezone: true }),
    authorId: text("author_id").notNull(),
    // JSON-encoded string arrays, mirroring the local store's TEXT columns.
    approverIds: text("approver_ids"),
    tags: text("tags"),
    supersededBy: text("superseded_by"),
    supersedes: text("supersedes"),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    schemaVersion: text("schema_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("decisions_org_id_idx").on(t.orgId),
    index("decisions_repo_id_idx").on(t.repoId),
    index("decisions_org_repo_idx").on(t.orgId, t.repoId),
    index("decisions_status_idx").on(t.status),
  ],
);

export type DecisionRow = typeof decisionsTable.$inferSelect;
export type InsertDecision = typeof decisionsTable.$inferInsert;
