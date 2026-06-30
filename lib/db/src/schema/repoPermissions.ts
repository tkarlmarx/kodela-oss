// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { pgTable, uuid, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

/**
 * Per-repo access grants (internal design note).
 *
 * Without a row here a member inherits org-level access (role determines what
 * they can read/write). A row with `access: "none"` explicitly blocks a member
 * from a specific repo. A row with `access: "read"` or `"write"` scopes them
 * below their org role.
 *
 * `principalId` is either a userId (membership) or `"*"` for the org default.
 * `repoId` matches `repo_links.id`.
 */
export const repoPermissionsTable = pgTable(
  "repo_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    repoId: text("repo_id").notNull(),
    principalId: text("principal_id").notNull(),
    access: text("access").notNull().default("write"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ix_repo_permissions_org_repo").on(table.orgId, table.repoId),
    unique("ux_repo_permissions_org_repo_principal").on(table.orgId, table.repoId, table.principalId),
  ],
);

export type RepoPermission = typeof repoPermissionsTable.$inferSelect;
