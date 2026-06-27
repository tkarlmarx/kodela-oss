// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { pgTable, text, real, integer, timestamp, index } from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

/**
 * P6.5 (doc 32) — `org_id` is the multi-tenant isolation column.  Every read
 * through `SqlBackend` MUST filter on `org_id` so a request authenticated as
 * org A cannot read entries belonging to org B.  The P6.6 row-filter audit
 * (next item in doc 27) walks every Drizzle query in `lib/core` + `api-server`
 * to confirm this invariant.  `NOT NULL` is intentional — a stray row with a
 * null `org_id` would bypass the filter silently.
 */
export const entriesTable = pgTable(
  "entries",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    repoId: text("repo_id").notNull(),
    filePath: text("file_path").notNull(),
    schemaVersion: text("schema_version").notNull(),
    status: text("status", { enum: ["mapped", "uncertain", "orphaned"] }).notNull(),
    severity: text("severity", { enum: ["critical", "high", "medium", "low"] }).notNull(),
    source: text("source", { enum: ["human", "ai", "import", "unknown"] }).notNull(),
    confidence: real("confidence").notNull(),
    scope: text("scope"),
    sessionId: text("session_id"),
    clusterId: text("cluster_id"),
    reviewRequired: integer("review_required").notNull().default(0),
    note: text("note").notNull(),
    author: text("author").notNull(),
    payload: text("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
  },
  (t) => [
    index("entries_org_id_idx").on(t.orgId),
    index("entries_repo_id_idx").on(t.repoId),
    index("entries_file_path_idx").on(t.filePath),
    index("entries_session_id_idx").on(t.sessionId),
    index("entries_cluster_id_idx").on(t.clusterId),
  ],
);
