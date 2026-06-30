// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Gap 51 — GitHub / GitLab PR diff view integration (Phase C: deduplication).
 *
 * Each row records that a Kodela inline review comment has already been
 * posted for a given (repo, PR, entry) triple.  On subsequent pushes to the
 * same PR the webhook handler skips entries that are already tracked here,
 * preventing duplicate inline annotations.
 *
 * `provider_comment_id` is the GitHub `pull_request_review_comment.id` or
 * GitLab `discussion.id` returned when the comment was first created.
 * It is stored as TEXT to accommodate both numeric (GitHub) and string
 * (GitLab) identifiers.
 */
export const prCommentsTable = pgTable("pr_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoId: text("repo_id").notNull(),
  provider: text("provider").notNull(),
  prNumber: integer("pr_number").notNull(),
  entryId: text("entry_id").notNull(),
  commitSha: text("commit_sha").notNull(),
  providerCommentId: text("provider_comment_id").notNull(),
  filePath: text("file_path").notNull(),
  line: integer("line").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPrCommentSchema = createInsertSchema(prCommentsTable).omit({
  id: true,
  createdAt: true,
});

export type PrCommentRow = typeof prCommentsTable.$inferSelect;
export type InsertPrComment = z.infer<typeof insertPrCommentSchema>;
