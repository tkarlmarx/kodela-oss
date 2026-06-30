// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { orgsTable } from "./orgs";

/**
 * API tokens (internal design note) — machine credentials for CI / scripts hitting
 * the Kodela API, separate from the per-license `apiSecret`.
 *
 * Security: we store ONLY a SHA-256 hash of the token, plus a short prefix for
 * display ("kdl_ab12…"). The plaintext is shown to the admin exactly once at
 * creation and never persisted. Revocation is a soft delete (`revokedAt`).
 */
export const apiTokensTable = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Display-only prefix, e.g. "kdl_ab12cd34". Never the full token. */
    prefix: text("prefix").notNull(),
    /** SHA-256 hex of the full token. The plaintext is never stored. */
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("ix_api_tokens_org").on(table.orgId)],
);

export const insertApiTokenSchema = createInsertSchema(apiTokensTable).omit({
  id: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
});

export type InsertApiToken = z.infer<typeof insertApiTokenSchema>;
export type ApiToken = typeof apiTokensTable.$inferSelect;
