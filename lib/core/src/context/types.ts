// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import type { IntentCluster } from "../schema/intent-cluster.schema.js";
import type { KodelaSession } from "../schema/session.schema.js";

export type QueryContext = {
  filePath?: string;
  intent?: string;
  sessionId?: string;
  clusterId?: string;
  tokenBudget?: number;
  debug?: boolean;
};

export type ExpansionConfig = {
  maxClusters: number;
  maxEntriesPerCluster: number;
  expansionDepth: 1 | 2;
  tokenBudget: number;
};

export const DEFAULT_EXPANSION_CONFIG: ExpansionConfig = {
  maxClusters: 5,
  maxEntriesPerCluster: 10,
  expansionDepth: 1,
  tokenBudget: 4000,
};

export type ScoringWeights = {
  recency: number;
  fileRelevance: number;
  intentMatch: number;
  confidence: number;
  usageSignal: number;
};

export const DEFAULT_WEIGHTS: ScoringWeights = {
  recency: 0.30,
  fileRelevance: 0.35,
  intentMatch: 0.20,
  confidence: 0.10,
  usageSignal: 0.05,
};

export type EntryScoreBreakdown = {
  recency: number;
  fileRelevance: number;
  intentMatch: number;
  confidence: number;
  usageSignal: number;
  finalScore: number;
};

export type ScoredEntryRow = {
  id: string;
  filePath: string;
  confidence: number;
  createdAt: string;
  scope: string | null;
  sessionId: string | null;
  clusterId: string | null;
  scores: EntryScoreBreakdown;
};

export type ClusterEntrySummary = {
  id: string;
  filePath: string;
  confidence: number;
  clusterId: string | null;
  sessionId: string | null;
  scope: string | null;
  createdAt: string;
};

export type TimingBreakdown = {
  queryMs: number;
  clusterMs: number;
  scoringMs: number;
  expansionMs: number;
  assemblyMs: number;
  totalMs: number;
};

export type DebugCandidate = {
  entryId: string;
  scores: EntryScoreBreakdown;
  weights: ScoringWeights;
  finalScore: number;
  selected: boolean;
  reason?: "low_score" | "token_budget_exceeded" | "max_cap";
};

export type DebugClusterSelection = {
  clusterId: string;
  score: number;
  selected: boolean;
  reason?: string;
};

export type DebugContext = {
  query: QueryContext;
  candidates: DebugCandidate[];
  clusterSelection: DebugClusterSelection[];
  timing: TimingBreakdown;
};

export type ProjectContextMeta = {
  tokenUsage: number;
  totalCandidates: number;
  selectedClusters: number;
  selectedEntries: number;
  droppedEntries?: number;
  reason?: "token_budget_exceeded" | "max_cap";
  timing?: TimingBreakdown;
};

export type ProjectContext = {
  clusters: IntentCluster[];
  entries: ClusterEntrySummary[];
  sessions: KodelaSession[];
  summary?: string;
  meta: ProjectContextMeta;
  warnings?: string[];
  debug?: DebugContext;
};
