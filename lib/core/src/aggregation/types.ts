// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { DiffResult } from "@kodela/diff";

export type FileChangeType = "minor" | "modify" | "rewrite";

export type RiskLevel = "low" | "medium" | "high";

export type ContextMappingResult = {
  contextId: string;
  status: "mapped" | "uncertain" | "orphaned";
  confidence: number;
};

export type FileChange = {
  filePath: string;
  linesChanged: number;
  changeType: FileChangeType;
  diff: DiffResult;
  contexts: ContextMappingResult[];
  timestamp: number;
};

export type ContextImpact = {
  mapped: number;
  uncertain: number;
  orphaned: number;
};

export type AggregatedFile = {
  filePath: string;
  module: string;
  linesChanged: number;
  risk: RiskLevel;
  contextImpact: ContextImpact;
};

export type AggregatedChangeSummary = {
  totalFiles: number;
  totalLinesChanged: number;
  modulesAffected: string[];
  riskScore: RiskLevel;
  highRiskFiles: AggregatedFile[];
  mediumRiskFiles: AggregatedFile[];
  lowRiskFiles: AggregatedFile[];
  aiDetected: boolean;
  summaryText: string;
};
