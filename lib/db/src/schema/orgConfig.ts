// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { orgsTable } from "./orgs";

/**
 * Org-wide configuration defaults/policies (admin-managed).
 *
 * One row per org. Stores the settings an operator manages centrally in the
 * admin panel — the same knobs the CLI exposes via kodela.config.json — so repos
 * and developers inherit them instead of each editing their own file. The shape
 * of `config` is validated by the api-server route, not the DB, so new keys can
 * ship without a schema migration.
 */
export const orgConfigTable = pgTable("org_config", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => orgsTable.id, { onDelete: "cascade" }),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OrgConfig = typeof orgConfigTable.$inferSelect;

/** The admin-manageable org settings — the org-plane mirror of the CLI options. */
export const orgConfigValueSchema = z
  .object({
    serverUrl: z.string().url().optional(),
    storageMode: z.enum(["local", "central"]).optional(),
    readMode: z.enum(["local", "remote", "merge"]).optional(),
    ciEnforcement: z.enum(["advisory", "enforcement"]).optional(),
    captureTier: z.enum(["enforced", "assisted", "ambient"]).optional(),
    retentionDays: z.number().int().positive().optional(),
    allowedAiTools: z.array(z.string()).optional(),
    encryptionRequired: z.boolean().optional(),
    /** Keys that repos may NOT override — enforced server-side. */
    locked: z.array(z.string()).optional(),
  })
  .strict();

export type OrgConfigValue = z.infer<typeof orgConfigValueSchema>;
