// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { orgsTable } from "./orgs";

/**
 * Gap 44 — Annotation discussion threads.
 *
 * Stores discussion comments for annotation entries in team/dashboard mode.
 * In solo mode, comments are stored locally at `.kodela/comments/<entryId>.json`.
 *
 * `org_id` scopes comments to the organisation; `repo_id` is the `repo_links.id`
 * foreign key so the discussion endpoint can filter by repository.  P6.5 (doc
 * 32) added the missing FK to orgs and the org_id index — pre-P6.5 the orgId
 * column existed without referential integrity.
 */
export const commentsTable = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    repoId: text("repo_id").notNull(),
    entryId: text("entry_id").notNull(),
    author: text("author").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("comments_org_id_idx").on(t.orgId),
    index("comments_entry_id_idx").on(t.entryId),
  ],
);

export const insertCommentSchema = createInsertSchema(commentsTable).omit({
  id: true,
  createdAt: true,
});

export type CommentRow = typeof commentsTable.$inferSelect;
export type InsertComment = z.infer<typeof insertCommentSchema>;
