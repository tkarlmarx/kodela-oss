// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
export { aggregateChanges } from "./aggregation.js";
export { classifyRisk } from "./classify.js";
export { detectModule } from "./module.js";
export { detectAIChange } from "./ai-detect.js";
export type {
  FileChange,
  FileChangeType,
  ContextMappingResult,
  ContextImpact,
  AggregatedFile,
  AggregatedChangeSummary,
  RiskLevel,
} from "./types.js";
