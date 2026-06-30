// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { decisionsTable } from "./decisions";

/**
 * Fused-graph parity (PR #1) — the typed links from a decision to the
 * artefacts that motivate or implement it (`link_type`: entry · session ·
 * ticket · incident · pr · commit · adr · document · discussion). SaaS mirror
 * of the local `decision_links` table; these rows are what the MCP server
 * projects into `graph_edges` IMPLEMENTS / MOTIVATES / INCLUDED_IN edges
 * (`LINK_TYPE_EDGE` in graph-store.ts).
 *
 * `org_id` is carried for the P6.6 row-filter invariant. `link_type` stays
 * plain `text` to mirror the local store's evolving value space.
 */
export const decisionLinksTable = pgTable(
  "decision_links",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    decisionId: text("decision_id")
      .notNull()
      .references(() => decisionsTable.id, { onDelete: "cascade" }),
    linkType: text("link_type").notNull(),
    externalId: text("external_id").notNull(),
    displayLabel: text("display_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("decision_links_org_id_idx").on(t.orgId),
    index("decision_links_decision_id_idx").on(t.decisionId),
    index("decision_links_external_idx").on(t.linkType, t.externalId),
  ],
);

export type DecisionLinkRow = typeof decisionLinksTable.$inferSelect;
export type InsertDecisionLink = typeof decisionLinksTable.$inferInsert;
