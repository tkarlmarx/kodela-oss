// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { decisionsTable } from "./decisions";

/**
 * Fused-graph parity (PR #1) — the options considered for a decision (chosen
 * vs. rejected, with the rejection reason). SaaS mirror of the local
 * `decision_options` table.
 *
 * Unlike the local single-tenant store, `org_id` is carried here too so the
 * P6.6 row-filter audit holds even when options are queried without joining
 * `decisions`. `was_chosen` keeps the local 0/1 integer-boolean shape.
 */
export const decisionOptionsTable = pgTable(
  "decision_options",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    decisionId: text("decision_id")
      .notNull()
      .references(() => decisionsTable.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    description: text("description"),
    // JSON-encoded string arrays, mirroring the local store's TEXT columns.
    pros: text("pros"),
    cons: text("cons"),
    wasChosen: integer("was_chosen").notNull().default(0),
    rejectionReason: text("rejection_reason"),
    position: integer("position"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("decision_options_org_id_idx").on(t.orgId),
    index("decision_options_decision_id_idx").on(t.decisionId),
  ],
);

export type DecisionOptionRow = typeof decisionOptionsTable.$inferSelect;
export type InsertDecisionOption = typeof decisionOptionsTable.$inferInsert;
