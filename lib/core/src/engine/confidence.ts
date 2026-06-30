// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { MappingStatus } from "../schema/index.js";

export const CONFIDENCE_THRESHOLD = {
  MAPPED: 0.85,
  UNCERTAIN_MIN: 0.5,
} as const;

export function classifyConfidence(confidence: number): MappingStatus {
  if (confidence < 0 || confidence > 1) {
    throw new RangeError(
      `Confidence must be between 0.0 and 1.0, received ${confidence}`,
    );
  }
  if (confidence > CONFIDENCE_THRESHOLD.MAPPED) return "mapped";
  if (confidence >= CONFIDENCE_THRESHOLD.UNCERTAIN_MIN) return "uncertain";
  return "orphaned";
}

/**
 * Per-component scores used to compute the final confidence value.
 * Exposed for diagnostic/verbose output; may be absent when a mapping layer
 * does not perform a token + position split (e.g. AST or git-diff layers).
 */
export type ScoreBreakdown = {
  token: number;
  position: number;
};

export type MappingResult = {
  confidence: number;
  status: MappingStatus;
  updatedLineRange: { start: number; end: number };
  /**
   * Optional breakdown of the individual scoring components.
   * Present when the mapping layer computes token and positional scores
   * separately (e.g. the token-hash window-scoring path).
   */
  scoreBreakdown?: ScoreBreakdown;
  /**
   * Gap 42 — Sub-layer hint from the AST layer.
   * "astBlockHash" → matched by exact kind:name hash (Tier 1, no rewrite).
   * "astSymbol"    → matched by symbolId or name only (Tier 0/2); blockHash
   *                  changed, indicating a partial rewrite. Status is forced
   *                  to "uncertain" regardless of raw confidence.
   * "astBodyHash"  → matched by normalised body hash (Tier 3, rename resilience).
   * Absent for non-AST layers.
   */
  layerHint?: "astBlockHash" | "astSymbol" | "astBodyHash";
};
