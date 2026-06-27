// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { pgTable, uuid, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

/**
 * Outbound webhooks (doc 26 Phase 4) — HTTP endpoints that Kodela posts events
 * to when context is captured, sessions complete, or PRs are blocked.
 *
 * `events` is stored as a JSON-encoded string array (Postgres text column so
 * the value stays portable with the SQLite adapter which also stores JSON text).
 */
export const webhooksTable = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    events: text("events").notNull().default("[]"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ix_webhooks_org").on(table.orgId)],
);

export type Webhook = typeof webhooksTable.$inferSelect;
