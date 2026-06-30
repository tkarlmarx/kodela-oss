// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import {
  pgTable,
  uuid,
  timestamp,
  doublePrecision,
  integer,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { repoLinksTable } from "./repoLinks";

export const snapshotsTable = pgTable("snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoLinkId: uuid("repo_link_id")
    .notNull()
    .references(() => repoLinksTable.id, { onDelete: "cascade" }),
  capturedAt: timestamp("captured_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  totalEntries: integer("total_entries").notNull().default(0),
  mappedEntries: integer("mapped_entries").notNull().default(0),
  aiGeneratedPct: doublePrecision("ai_generated_pct").notNull().default(0),
  unresolvedCriticalPct: doublePrecision("unresolved_critical_pct")
    .notNull()
    .default(0),
  orphanedPct: doublePrecision("orphaned_pct").notNull().default(0),
  confidenceScore: doublePrecision("confidence_score").notNull().default(0),
});

export const insertSnapshotSchema = createInsertSchema(snapshotsTable).omit({
  id: true,
});

export type InsertSnapshot = z.infer<typeof insertSnapshotSchema>;
export type Snapshot = typeof snapshotsTable.$inferSelect;
