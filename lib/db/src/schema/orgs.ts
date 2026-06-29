// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const orgsTable = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name"),
  /**
   * Fingerprint of the org's currently-installed signed license — the SHA-256
   * of the verified `kodela.license.json`. Repurposed from the formerly dormant
   * `license_key` column (internal design note) so there is exactly ONE license notion:
   * the signed file is the source of truth, and this caches its identity for
   * server-side seat lookups without trusting client-sent data. Nullable: free
   * orgs have no license.
   */
  licenseFingerprint: text("license_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertOrgSchema = createInsertSchema(orgsTable).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertOrg = z.infer<typeof insertOrgSchema>;
export type Org = typeof orgsTable.$inferSelect;
