// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import type { FileChange, RiskLevel } from "./types.js";
import { classifyScope, SENSITIVE_SCOPES } from "../scope/classifier.js";

const HIGH_LINES_THRESHOLD = 100;
const MEDIUM_LINES_MIN = 20;
const HIGH_CONFIDENCE_THRESHOLD = 0.7;
const MEDIUM_CONFIDENCE_MIN = 0.7;
const MEDIUM_CONFIDENCE_MAX = 0.85;

/**
 * Classify a single file change as "high", "medium", or "low" risk.
 *
 * HIGH if any of:
 *   - linesChanged > 100
 *   - changeType === "rewrite"
 *   - any context is orphaned
 *   - average confidence < 0.7
 *   - file path contains a sensitive segment
 *
 * MEDIUM if any of (and not already HIGH):
 *   - linesChanged between 20 and 100 (inclusive)
 *   - any context is uncertain
 *   - average confidence between 0.7 and 0.85
 *
 * LOW otherwise.
 *
 * Pure function — no side effects, no I/O.
 */
export function classifyRisk(file: FileChange): RiskLevel {
  const { filePath, linesChanged, changeType, contexts } = file;

  const avgConfidence =
    contexts.length > 0
      ? contexts.reduce((sum, c) => sum + c.confidence, 0) / contexts.length
      : 1.0;

  const hasOrphaned = contexts.some((c) => c.status === "orphaned");
  const hasUncertain = contexts.some((c) => c.status === "uncertain");

  const scope = classifyScope(filePath);
  const hasSensitivePath = SENSITIVE_SCOPES.has(scope);

  if (
    linesChanged > HIGH_LINES_THRESHOLD ||
    changeType === "rewrite" ||
    hasOrphaned ||
    avgConfidence < HIGH_CONFIDENCE_THRESHOLD ||
    hasSensitivePath
  ) {
    return "high";
  }

  if (
    (linesChanged >= MEDIUM_LINES_MIN && linesChanged <= HIGH_LINES_THRESHOLD) ||
    hasUncertain ||
    (avgConfidence >= MEDIUM_CONFIDENCE_MIN && avgConfidence <= MEDIUM_CONFIDENCE_MAX)
  ) {
    return "medium";
  }

  return "low";
}
