// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { IntentCluster } from "../schema/intent-cluster.schema.js";
import type { ClusterEntrySummary, ExpansionConfig, ScoredEntryRow } from "./types.js";

export type BudgetState = {
  tokens: number;
};

export type ExpandedCluster = {
  cluster: IntentCluster;
  entries: ClusterEntrySummary[];
  droppedCount: number;
  droppedReason: "budget" | "cap" | null;
};

export function estimateTokens(entry: { filePath: string; scope: string | null }): number {
  const text = [entry.filePath, entry.scope].filter(Boolean).join(" ");
  return Math.max(10, Math.ceil(text.length / 4));
}

export function expandCluster(
  cluster: IntentCluster,
  scoredEntries: ScoredEntryRow[],
  config: ExpansionConfig,
  budget: BudgetState,
): ExpandedCluster {
  const sorted = [...scoredEntries].sort(
    (a, b) => b.scores.finalScore - a.scores.finalScore,
  );

  const selected: ClusterEntrySummary[] = [];
  let dropped = 0;
  let droppedReason: "budget" | "cap" | null = null;

  for (const scored of sorted) {
    if (selected.length >= config.maxEntriesPerCluster) {
      dropped++;
      droppedReason = "cap";
      break;
    }
    const cost = estimateTokens(scored);
    if (budget.tokens - cost < 0) {
      dropped++;
      droppedReason = "budget";
      break;
    }
    selected.push({
      id: scored.id,
      filePath: scored.filePath,
      confidence: scored.confidence,
      clusterId: scored.clusterId,
      sessionId: scored.sessionId,
      scope: scored.scope,
      createdAt: scored.createdAt,
    });
    budget.tokens -= cost;
  }

  return {
    cluster,
    entries: selected,
    droppedCount: dropped,
    droppedReason,
  };
}
