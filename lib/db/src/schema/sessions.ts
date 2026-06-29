// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

/**
 * P6.5 (internal design note) — KodelaSession persistence for SaaS mode.
 *
 * Local mode keeps the canonical session record as a JSON file at
 * `.kodela/sessions/<id>.json` (see `lib/core/src/storage/storage.ts`'s
 * writeSession / readSession / listSessions).  SaaS mode mirrors that record
 * into this table so the dashboard can query sessions across an org without
 * walking every customer's filesystem.
 *
 * The full KodelaSession (intent, actor, git snapshots, per-file annotation
 * blob) lives in `payload` as JSON — keeping it as a single JSONB column
 * rather than exploding every nested optional field into columns avoids the
 * schema churn every time the KodelaSessionSchema in `lib/core` evolves.
 * Indexable fields (org_id, repo_id, started_at) are surfaced as proper
 * columns for query performance.
 *
 * `org_id` is the multi-tenant isolation column — every read MUST filter
 * on it.  P6.6 row-filter audit walks every query to confirm.
 */
export const sessionsTable = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    repoId: text("repo_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    outcome: text("outcome", { enum: ["success", "partial", "abandoned"] }),
    aggregatedRisk: text("aggregated_risk", {
      enum: ["low", "medium", "high", "critical"],
    }),
    payload: text("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sessions_org_id_idx").on(t.orgId),
    index("sessions_repo_id_idx").on(t.repoId),
    index("sessions_started_at_idx").on(t.startedAt),
  ],
);

export type SessionRow = typeof sessionsTable.$inferSelect;
export type InsertSession = typeof sessionsTable.$inferInsert;
