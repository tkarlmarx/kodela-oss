// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { z } from "zod";

export const IntentClusterTriggerSchema = z.enum([
  "new_prompt",
  "scope_shift",
  "time_gap",
  "session_end",
]);

export type IntentClusterTrigger = z.infer<typeof IntentClusterTriggerSchema>;

export const AggregatedRiskSchema = z.enum(["low", "medium", "high", "critical"]);
export type AggregatedRisk = z.infer<typeof AggregatedRiskSchema>;

export const IntentClusterSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string(),
  index: z.number().int().min(0),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  triggerType: IntentClusterTriggerSchema,
  goal: z.string().optional(),
  filesChanged: z.array(z.string()),
  eventCount: z.number().int().min(0),
  entryIds: z.array(z.string().uuid()),
  scope: z.string().optional(),
  aggregatedRisk: AggregatedRiskSchema.optional(),
  /**
   * Gap 111 — Cluster lineage version. Starts at 1. Incremented each time
   * this cluster is superseded or split into a newer cluster.
   * Absent for clusters created before Gap 111.
   */
  version: z.number().int().min(1).default(1),
  /**
   * Gap 111 — The cluster this one was forked or split from.
   * Absent when this is an original (root) cluster.
   */
  parentId: z.string().uuid().optional(),
  /**
   * Gap 111 — The cluster that replaced this one.
   * When set, callers MUST follow this reference to get current data.
   * Absent when this is the canonical latest version.
   */
  supersededBy: z.string().uuid().optional(),
});

export type IntentCluster = z.infer<typeof IntentClusterSchema>;

export const SessionRecordSchema = z.object({
  id: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  model: z.string().optional(),
  clusterCount: z.number().int().min(0).default(0),
  totalFiles: z.number().int().min(0).default(0),
  aggregatedRisk: AggregatedRiskSchema.optional(),
  filesChanged: z.array(z.string()),
  clusters: z.array(IntentClusterSchema),
});

export type SessionRecord = z.infer<typeof SessionRecordSchema>;
