// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { pgTable, text, integer, real, timestamp, index } from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";

/**
 * P6.5 (internal design note) — `org_id` is the multi-tenant isolation column.  Every cluster
 * query through SqlBackend MUST filter on it.  Clusters are dashboard-rendered
 * groupings of entries from the same session, so org-isolation here matches
 * the entry-level invariant.
 */
export const intentClustersTable = pgTable(
  "intent_clusters",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    repoId: text("repo_id").notNull(),
    sessionId: text("session_id").notNull(),
    clusterIndex: integer("cluster_index").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    triggerType: text("trigger_type", {
      enum: ["new_prompt", "scope_shift", "time_gap", "session_end"],
    }).notNull(),
    goal: text("goal"),
    scope: text("scope"),
    eventCount: integer("event_count").notNull().default(0),
    entryCount: integer("entry_count").notNull().default(0),
    aggregatedRisk: text("aggregated_risk", {
      enum: ["low", "medium", "high", "critical"],
    }),
    filesChanged: text("files_changed").notNull().default("[]"),
    goalEmbeddingModel: text("goal_embedding_model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("intent_clusters_org_id_idx").on(t.orgId),
    index("intent_clusters_repo_id_idx").on(t.repoId),
    index("intent_clusters_session_id_idx").on(t.sessionId),
  ],
);

export const intentClusterEmbeddingsTable = pgTable("intent_cluster_embeddings", {
  clusterId: text("cluster_id")
    .primaryKey()
    .references(() => intentClustersTable.id, { onDelete: "cascade" }),
  vector: text("vector").notNull(),
  model: text("model").notNull(),
  embeddedAt: timestamp("embedded_at", { withTimezone: true }).notNull().defaultNow(),
});
