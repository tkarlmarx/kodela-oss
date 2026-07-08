// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { DatabaseSync } from "node:sqlite";
import type { IntentCluster } from "../schema/intent-cluster.schema.js";
import type { KodelaSession } from "../schema/session.schema.js";
import {
  queryEntries,
  queryClusters,
  getSession,
} from "../storage/sqlite-index.js";
import { scoreEntries } from "./scorer.js";
import { resolveClusterLineage } from "./lineage.js";
import { expandCluster, estimateTokens } from "./expander.js";
import { loadContextConfig } from "./config-loader.js";
import type {
  QueryContext,
  ExpansionConfig,
  ProjectContext,
  ProjectContextMeta,
  TimingBreakdown,
  DebugCandidate,
  DebugClusterSelection,
  DebugContext,
  ScoredEntryRow,
  ClusterEntrySummary,
} from "./types.js";

function now(): number {
  return performance.now();
}

function deduplicateById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function buildProjectContext(
  db: DatabaseSync,
  query: QueryContext,
  repoRoot: string = process.cwd(),
  overrideConfig?: Partial<ExpansionConfig>,
): ProjectContext {
  const t0 = now();

  const { scoring: weights, expansion: configExpansion } = loadContextConfig(repoRoot);
  const config: ExpansionConfig = { ...configExpansion, ...overrideConfig };
  if (query.tokenBudget !== undefined) {
    config.tokenBudget = query.tokenBudget;
  }

  const t1 = now();

  const entryFilter: Parameters<typeof queryEntries>[1] = {};
  if (query.filePath) entryFilter.filePath = query.filePath;
  if (query.sessionId) entryFilter.sessionId = query.sessionId;
  if (query.clusterId) entryFilter.clusterId = query.clusterId;

  const candidateRows = queryEntries(db, entryFilter);
  const totalCandidates = candidateRows.length;
  const t2 = now();

  const scored = scoreEntries(candidateRows, query, weights);
  const t3 = now();

  const clusterMap = new Map<string, ScoredEntryRow[]>();
  const noClusterEntries: ScoredEntryRow[] = [];
  for (const entry of scored) {
    if (entry.clusterId) {
      const existing = clusterMap.get(entry.clusterId) ?? [];
      existing.push(entry);
      clusterMap.set(entry.clusterId, existing);
    } else {
      noClusterEntries.push(entry);
    }
  }

  const clusterScores: Array<{ clusterId: string; score: number }> = [];
  for (const [clusterId, entries] of clusterMap.entries()) {
    const avgScore =
      entries.reduce((sum, e) => sum + e.scores.finalScore, 0) / entries.length;
    clusterScores.push({ clusterId, score: avgScore });
  }
  clusterScores.sort((a, b) => b.score - a.score);

  const clusterRows = queryClusters(db, {
    filePath: query.filePath,
    excludeSuperseded: false,
  });
  const allWarnings: string[] = [];
  const debugClusterSelections: DebugClusterSelection[] = [];

  const resolvedClusters: IntentCluster[] = [];
  for (const { clusterId, score } of clusterScores) {
    const selected = resolvedClusters.length < config.maxClusters;
    debugClusterSelections.push({ clusterId, score, selected });
    if (!selected) break;
    try {
      const { cluster, warnings } = resolveClusterLineage(clusterId, db);
      allWarnings.push(...warnings);
      resolvedClusters.push(cluster);
    } catch {
      allWarnings.push(`Cluster ${clusterId} could not be resolved — skipped`);
    }
  }

  if (resolvedClusters.length === 0 && clusterRows.length > 0) {
    const topRows = clusterRows.slice(0, config.maxClusters);
    for (const row of topRows) {
      try {
        const { cluster, warnings } = resolveClusterLineage(row.id, db);
        allWarnings.push(...warnings);
        if (!resolvedClusters.find((c) => c.id === cluster.id)) {
          resolvedClusters.push(cluster);
        }
      } catch {
        allWarnings.push(`Cluster ${row.id} could not be resolved — skipped`);
      }
    }
  }

  const t4 = now();

  const budget = { tokens: config.tokenBudget };
  const expandedClusters = resolvedClusters.map((cluster) => {
    const clusterEntries = clusterMap.get(cluster.id) ?? [];
    const parentCluster = cluster.parentId
      ? resolvedClusters.find((c) => c.id === cluster.parentId)
      : undefined;

    let entriesToExpand = clusterEntries;
    if (config.expansionDepth === 2 && parentCluster) {
      const parentEntries = clusterMap.get(parentCluster.id) ?? [];
      entriesToExpand = [...clusterEntries, ...parentEntries];
    }

    return expandCluster(cluster, entriesToExpand, config, budget);
  });

  const clusteredEntries = deduplicateById(expandedClusters.flatMap((e) => e.entries));

  // Entries not attached to any intent cluster must still surface. Clustering is
  // optional enrichment, not a precondition for retrieval — without this, a
  // get_context query returns *nothing* whenever the matched entries have not
  // been clustered (cluster_id NULL), which is the common case: the entries
  // exist, matched the filter, and scored, yet were silently dropped. Emit them
  // under the shared token budget, highest score first, capped like the
  // clustered path (maxClusters × maxEntriesPerCluster).
  const seenIds = new Set(clusteredEntries.map((e) => e.id));
  const unclusteredEntries: ClusterEntrySummary[] = [];
  let unclusteredDropped = 0;
  let unclusteredDropReason: "budget" | "cap" | null = null;
  const unclusteredCap = config.maxClusters * config.maxEntriesPerCluster;
  const sortedNoCluster = [...noClusterEntries].sort(
    (a, b) => b.scores.finalScore - a.scores.finalScore,
  );
  for (const scored of sortedNoCluster) {
    if (seenIds.has(scored.id)) continue;
    if (clusteredEntries.length + unclusteredEntries.length >= unclusteredCap) {
      unclusteredDropped++;
      unclusteredDropReason = "cap";
      break;
    }
    const cost = estimateTokens(scored);
    if (budget.tokens - cost < 0) {
      unclusteredDropped++;
      unclusteredDropReason = "budget";
      break;
    }
    unclusteredEntries.push({
      id: scored.id,
      filePath: scored.filePath,
      confidence: scored.confidence,
      clusterId: scored.clusterId,
      sessionId: scored.sessionId,
      scope: scored.scope,
      createdAt: scored.createdAt,
    });
    budget.tokens -= cost;
    seenIds.add(scored.id);
  }

  let totalDropped = unclusteredDropped;
  let dropReason: "token_budget_exceeded" | "max_cap" | undefined =
    unclusteredDropReason === "budget"
      ? "token_budget_exceeded"
      : unclusteredDropReason === "cap"
        ? "max_cap"
        : undefined;
  for (const expanded of expandedClusters) {
    totalDropped += expanded.droppedCount;
    if (expanded.droppedReason === "budget" && !dropReason) {
      dropReason = "token_budget_exceeded";
    } else if (expanded.droppedReason === "cap" && !dropReason) {
      dropReason = "max_cap";
    }
  }
  if (totalDropped > 0) {
    allWarnings.push(`${totalDropped} entries dropped due to ${dropReason ?? "limit"}`);
  }

  const t5 = now();

  const allEntries = deduplicateById([...clusteredEntries, ...unclusteredEntries]);

  const sessionIds = new Set<string>(
    allEntries.map((e) => e.sessionId).filter((s): s is string => Boolean(s)),
  );
  const sessions: KodelaSession[] = [];
  for (const sessionId of sessionIds) {
    const sessionRow = getSession(db, sessionId);
    if (!sessionRow) continue;
    sessions.push({
      id: sessionRow.id,
      startedAt: sessionRow.startedAt,
      endedAt: sessionRow.endedAt ?? undefined,
      model: sessionRow.model ?? undefined,
      entries: allEntries
        .filter((e) => e.sessionId === sessionId)
        .map((e) => e.id),
      goal: undefined,
      aggregatedRisk: (sessionRow.aggregatedRisk as "low" | "medium" | "high" | "critical") ?? "low",
      filesChanged: sessionRow.filesChanged ? (JSON.parse(sessionRow.filesChanged) as string[]) : [],
    });
  }

  const t6 = now();

  const tokenUsage = config.tokenBudget - budget.tokens;

  const timing: TimingBreakdown = {
    queryMs: Math.round(t2 - t1),
    clusterMs: Math.round(t4 - t3),
    scoringMs: Math.round(t3 - t2),
    expansionMs: Math.round(t5 - t4),
    assemblyMs: Math.round(t6 - t5),
    totalMs: Math.round(t6 - t0),
  };

  const meta: ProjectContextMeta = {
    tokenUsage,
    totalCandidates,
    selectedClusters: resolvedClusters.length,
    selectedEntries: allEntries.length,
    timing,
  };
  if (totalDropped > 0) {
    meta.droppedEntries = totalDropped;
    if (dropReason) meta.reason = dropReason;
  }

  if (timing.totalMs > 100) {
    process.stderr.write(
      `[kodela] context retrieval exceeded budget: ${timing.totalMs}ms` +
      ` (query=${timing.queryMs} cluster=${timing.clusterMs}` +
      ` scoring=${timing.scoringMs} expansion=${timing.expansionMs}` +
      ` assembly=${timing.assemblyMs})\n`,
    );
  }

  const result: ProjectContext = {
    clusters: deduplicateById(resolvedClusters),
    entries: allEntries,
    sessions,
    meta,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
  };

  if (query.debug) {
    const debugCandidates: DebugCandidate[] = scored.map((s) => {
      const isSelected = allEntries.some((e) => e.id === s.id);
      return {
        entryId: s.id,
        scores: s.scores,
        weights,
        finalScore: s.scores.finalScore,
        selected: isSelected,
        reason: isSelected
          ? undefined
          : s.scores.finalScore < 0.3
          ? "low_score"
          : "token_budget_exceeded",
      };
    });

    const debugContext: DebugContext = {
      query,
      candidates: debugCandidates,
      clusterSelection: debugClusterSelections,
      timing,
    };
    result.debug = debugContext;
  }

  return result;
}
