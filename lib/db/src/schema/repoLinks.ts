// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { orgsTable } from "./orgs";

export const repoLinksTable = pgTable(
  "repo_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["github", "gitlab", "local"] }).notNull(),
    repoFullName: text("repo_full_name").notNull(),
    encryptedToken: text("encrypted_token").notNull(),
    installationId: text("installation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ux_repo_links_org_provider_name").on(
      table.orgId,
      table.provider,
      table.repoFullName,
    ),
  ],
);

export const insertRepoLinkSchema = createInsertSchema(repoLinksTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertRepoLink = z.infer<typeof insertRepoLinkSchema>;
export type RepoLink = typeof repoLinksTable.$inferSelect;
