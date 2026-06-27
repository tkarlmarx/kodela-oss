// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
export { buildProjectContext } from "./builder.js";

export { scoreEntry, scoreEntries } from "./scorer.js";

export { resolveClusterLineage, clusterRowToIntentCluster } from "./lineage.js";
export type { LineageResult } from "./lineage.js";

export { expandCluster, estimateTokens } from "./expander.js";
export type { ExpandedCluster, BudgetState } from "./expander.js";

export { loadContextConfig } from "./config-loader.js";
export type { ContextConfig } from "./config-loader.js";

export type {
  QueryContext,
  ExpansionConfig,
  ScoringWeights,
  EntryScoreBreakdown,
  ScoredEntryRow,
  ClusterEntrySummary,
  TimingBreakdown,
  DebugCandidate,
  DebugClusterSelection,
  DebugContext,
  ProjectContextMeta,
  ProjectContext,
} from "./types.js";

export { DEFAULT_EXPANSION_CONFIG, DEFAULT_WEIGHTS } from "./types.js";
