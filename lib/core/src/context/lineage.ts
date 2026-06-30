// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { DatabaseSync } from "node:sqlite";
import type { ClusterRow } from "../storage/sqlite-index.js";
import { getCluster } from "../storage/sqlite-index.js";
import { IntentClusterSchema } from "../schema/intent-cluster.schema.js";
import type { IntentCluster } from "../schema/intent-cluster.schema.js";

const MAX_LINEAGE_DEPTH = 10;

function clusterRowToIntentCluster(row: ClusterRow): IntentCluster {
  return IntentClusterSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    index: row.clusterIndex,
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? undefined,
    triggerType: row.triggerType,
    goal: row.goal ?? undefined,
    filesChanged: row.filesChanged ? (JSON.parse(row.filesChanged) as string[]) : [],
    eventCount: row.eventCount,
    entryIds: [],
    scope: row.scope ?? undefined,
    aggregatedRisk: row.aggregatedRisk ?? undefined,
    version: row.version,
    parentId: row.parentId ?? undefined,
    supersededBy: row.supersededBy ?? undefined,
  });
}

export type LineageResult = {
  cluster: IntentCluster;
  hops: string[];
  warnings: string[];
};

export function resolveClusterLineage(
  clusterId: string,
  db: DatabaseSync,
): LineageResult {
  const warnings: string[] = [];
  const hops: string[] = [];
  let currentId = clusterId;

  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
    const row = getCluster(db, currentId);
    if (!row) {
      warnings.push(`Cluster ${currentId} not found in index — lineage resolution stopped`);
      break;
    }
    const cluster = clusterRowToIntentCluster(row);
    if (!cluster.supersededBy) {
      return { cluster, hops, warnings };
    }
    const nextId = cluster.supersededBy;
    warnings.push(`Cluster ${currentId} superseded by ${nextId}`);
    hops.push(currentId);
    currentId = nextId;
  }

  const finalRow = getCluster(db, currentId);
  if (!finalRow) {
    const originalRow = getCluster(db, clusterId);
    if (!originalRow) {
      throw new Error(`Cluster ${clusterId} not found in index`);
    }
    warnings.push(`Lineage depth exceeded (>${MAX_LINEAGE_DEPTH} hops) — returning last resolved cluster`);
    return { cluster: clusterRowToIntentCluster(originalRow), hops, warnings };
  }

  warnings.push(`Lineage depth cap reached (>${MAX_LINEAGE_DEPTH} hops) — returning last resolved cluster`);
  return { cluster: clusterRowToIntentCluster(finalRow), hops, warnings };
}

export { clusterRowToIntentCluster };
