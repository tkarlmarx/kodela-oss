// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { orgsTable } from "./orgs";
import { usersTable } from "./users";

/**
 * Org membership — the join between users and orgs, and the unit a seat is
 * counted against (internal design note).
 *
 * Seat counting: COUNT(*) WHERE org_id = ? AND status = 'active'. The seat cap
 * comes from the org's signed license (`maxSeats`). Enforced server-side in
 * the membership-create path via `requireSeatAvailable`.
 *
 * `status`:
 *   - invited:   added but not yet accepted (does NOT consume a seat)
 *   - active:    consumes a seat
 *   - suspended: retained but not active (does NOT consume a seat)
 */
export const membershipsTable = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] }).notNull().default("member"),
    status: text("status", { enum: ["invited", "active", "suspended"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ux_memberships_org_user").on(table.orgId, table.userId),
    index("ix_memberships_org_status").on(table.orgId, table.status),
  ],
);

export const insertMembershipSchema = createInsertSchema(membershipsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertMembership = z.infer<typeof insertMembershipSchema>;
export type Membership = typeof membershipsTable.$inferSelect;
