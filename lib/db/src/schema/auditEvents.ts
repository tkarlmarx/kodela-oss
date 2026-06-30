// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { orgsTable } from "./orgs";

export const AUDIT_EVENT_TYPES = [
  "context_added",
  "context_updated",
  "context_archived",
  "exception_approved",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const auditEventsTable = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type", {
    enum: AUDIT_EVENT_TYPES,
  })
    .notNull()
    .$type<AuditEventType>(),
  actor: text("actor").notNull(),
  filePath: text("file_path"),
  entryId: text("entry_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAuditEventSchema = createInsertSchema(auditEventsTable).omit({
  id: true,
  createdAt: true,
});

export type AuditEvent = typeof auditEventsTable.$inferSelect;
export type InsertAuditEvent = z.infer<typeof insertAuditEventSchema>;
