// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { orgsTable } from "./orgs";

/**
 * Gap 45 — Structured AI code review sign-off workflow.
 *
 * Stores sign-off records pushed from the CLI or created via the dashboard.
 * Each row represents a single reviewer acknowledging an AI-generated change.
 *
 * `org_id` (P6.5 / doc 32) is the multi-tenant isolation column — every read
 * through SqlBackend MUST filter on it.  `repo_id` corresponds to the
 * `repo_links.id` foreign key and scopes records to a specific repository so
 * the audit endpoint can filter by repo within an org.
 */
export const signOffRecordsTable = pgTable(
  "sign_off_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    repoId: text("repo_id").notNull(),
    entryId: text("entry_id").notNull(),
    reviewer: text("reviewer").notNull(),
    signedOffAt: timestamp("signed_off_at", { withTimezone: true }).notNull(),
    comment: text("comment"),
    filePath: text("file_path"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sign_off_records_org_id_idx").on(t.orgId),
    index("sign_off_records_entry_id_idx").on(t.entryId),
  ],
);

export const insertSignOffRecordSchema = createInsertSchema(signOffRecordsTable).omit({
  id: true,
  createdAt: true,
});

export type SignOffRecordRow = typeof signOffRecordsTable.$inferSelect;
export type InsertSignOffRecord = z.infer<typeof insertSignOffRecordSchema>;
