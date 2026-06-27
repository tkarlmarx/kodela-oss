// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 24 Phase B — UBA (User Behavior Analytics) fusion scoring engine.
 *
 * Combines five independent behavioral signals into a single classification
 * score. No single signal can produce a high-confidence AI classification
 * on its own — trust requires at least two strong signals (A or B).
 *
 * Signal weights:
 *   A — Edit pattern      0.35  (strongest: bulk insert vs incremental)
 *   B — Temporal          0.25  (burst vs cadenced editing)
 *   C — File scope        0.20  (multi-file batch vs single file)
 *   D — Structural change 0.10  (large contiguous block vs scattered edits)
 *   E — Environment       0.10  (weakest: IDE env var presence alone)
 *
 * Trust rules (invariants, not guidelines):
 *   1. `source: "ai"` with `confidence > 0.8` requires ≥ 2 strong signals (A or B ≥ 0.7).
 *   2. `classificationScore` in [0.50, 0.80] → always `source: "unknown"`, never "ai".
 *   3. `confidence: 1.0` is only emitted for `isExplicitAgentSignal` entries.
 *   4. Environment signal weight is capped at 0.10 regardless of how many env vars are set.
 *   5. Every result exposes `classificationSignals` for user explainability.
 *
 * This is the long-term fix for the false positives documented in Gap 23.
 */

/**
 * Input signals for the UBA fusion engine.
 * Callers populate from data already available in the watcher batch.
 */
export type UbaSignals = {
  /** Signal A — total net lines added across all files in this batch. */
  linesAdded: number;
  /** Signal A/B — number of distinct file-write events in this batch. */
  writeEventCount: number;
  /** Signal A/B — whether all changes arrived in a single debounce window. */
  isSingleBatch: boolean;
  /**
   * Signal B — milliseconds since the previous auto-annotate batch.
   * `undefined` on the first batch (no history); treated as neutral (0.5).
   */
  interBatchGapMs?: number;
  /** Signal C — number of distinct files changed in this batch. */
  fileCount: number;
  /**
   * Signal D — true when at least one hunk covers a single contiguous block
   * of 20+ lines (typical of agent-generated full-function rewrites).
   */
  hasLargeContiguousBlock: boolean;
  /**
   * Signal E — true when a known-AI IDE environment variable is present
   * (REPL_ID, CURSOR_SESSION_ID, etc.).
   */
  hasKnownEnvSignal: boolean;
  /**
   * Signal E — true only for fully explicit attribution: KODELA_AGENT env var
   * or .kodela/origin.json sidecar. Explicit signals may emit confidence: 1.0.
   */
  isExplicitAgentSignal: boolean;
};

/** Scored output from the UBA fusion engine. */
export type UbaResult = {
  /** Weighted combination of all five signals in [0, 1]. */
  classificationScore: number;
  /** Classification output: "ai" | "human" | "unknown". */
  source: "ai" | "human" | "unknown";
  /** How confident we are in the classification. In [0, 1]. */
  confidence: number;
  /** Mapping status derived from the classification. */
  status: "mapped" | "uncertain";
  /** Whether this entry should be flagged for human review. */
  reviewRequired: boolean;
  /**
   * Per-signal scores for explainability (each in [0, 1]).
   * 0 = strong human indicator, 1 = strong AI indicator, 0.5 = uncertain.
   */
  classificationSignals: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Individual signal scoring functions (0 = human, 1 = AI, 0.5 = uncertain)
// ---------------------------------------------------------------------------

function scoreEditPattern(
  linesAdded: number,
  eventCount: number,
  isSingleBatch: boolean,
  hasKnownEnvSignal: boolean,
): number {
  if (linesAdded > 40 && isSingleBatch && eventCount <= 2) {
    return 0.9;
  }
  if (linesAdded > 40 && eventCount <= 2) {
    return 0.8;
  }
  if (linesAdded <= 10 && eventCount > 3) {
    return 0.1;
  }
  if (linesAdded <= 5) {
    // Gap 65 fix — in a known AI environment (REPL_ID, Cursor, etc.) small
    // changes are neutral rather than strongly human-indicating.  A targeted
    // 5-line AI fix is as plausible as a human typing it, so lift the floor
    // from 0.2 to 0.35 to keep the overall score in the uncertain zone
    // (≥ 0.50) for real AI agents rather than forcing a human classification.
    return hasKnownEnvSignal ? 0.35 : 0.2;
  }
  return 0.5;
}

function scoreTemporalSignature(
  interBatchGapMs: number | undefined,
  eventCount: number,
  linesAdded: number,
): number {
  if (interBatchGapMs === undefined) {
    return 0.5;
  }
  if (eventCount === 1 && interBatchGapMs < 100 && linesAdded > 20) {
    return 0.8;
  }
  if (interBatchGapMs < 500 && eventCount <= 2 && linesAdded > 10) {
    return 0.7;
  }
  if (interBatchGapMs >= 150 && eventCount > 3) {
    return 0.2;
  }
  if (interBatchGapMs > 5_000) {
    return 0.3;
  }
  return 0.5;
}

function scoreFileScope(fileCount: number): number {
  if (fileCount >= 4) return 0.8;
  if (fileCount >= 2) return 0.6;
  return 0.3;
}

function scoreStructuralChange(hasLargeContiguousBlock: boolean): number {
  return hasLargeContiguousBlock ? 0.7 : 0.4;
}

function scoreEnvironment(
  hasKnownEnvSignal: boolean,
  isExplicitAgentSignal: boolean,
): number {
  if (isExplicitAgentSignal) return 1.0;
  if (hasKnownEnvSignal) return 0.6;
  return 0.2;
}

// ---------------------------------------------------------------------------
// Main fusion engine
// ---------------------------------------------------------------------------

/**
 * Compute the UBA classification score from behavioral signals and apply
 * the five trust rules to produce a final source/confidence/status result.
 */
export function ubaScore(signals: UbaSignals): UbaResult {
  const signalA = scoreEditPattern(
    signals.linesAdded,
    signals.writeEventCount,
    signals.isSingleBatch,
    signals.hasKnownEnvSignal,
  );
  const signalB = scoreTemporalSignature(
    signals.interBatchGapMs,
    signals.writeEventCount,
    signals.linesAdded,
  );
  const signalC = scoreFileScope(signals.fileCount);
  const signalD = scoreStructuralChange(signals.hasLargeContiguousBlock);
  const signalE = scoreEnvironment(
    signals.hasKnownEnvSignal,
    signals.isExplicitAgentSignal,
  );

  const classificationScore =
    0.35 * signalA +
    0.25 * signalB +
    0.20 * signalC +
    0.10 * signalD +
    0.10 * signalE;

  const classificationSignals: Record<string, number> = {
    editPattern: signalA,
    temporalSignature: signalB,
    fileScope: signalC,
    structuralChange: signalD,
    environment: signalE,
  };

  // Trust rule 1: high-confidence AI classification requires ≥ 2 strong signals
  // from A or B (the behavioral signals). Environment alone cannot trigger this.
  const strongBehavioralSignals = [signalA, signalB].filter((s) => s >= 0.7).length;

  let source: "ai" | "human" | "unknown";
  let confidence: number;
  let status: "mapped" | "uncertain";
  let reviewRequired: boolean;

  if (classificationScore > 0.80 && strongBehavioralSignals >= 2) {
    // Trust rule 1 satisfied: two independent behavioral signals agree → AI
    source = "ai";
    confidence = classificationScore;
    status = "mapped";
    reviewRequired = true;
  } else if (classificationScore > 0.80) {
    // High score but only one strong behavioral signal → downgrade to unknown
    // (trust rule 1 prevents false-positive AI classification)
    source = "unknown";
    confidence = classificationScore;
    status = "uncertain";
    reviewRequired = false;
  } else if (classificationScore >= 0.50) {
    // Trust rule 2: uncertain zone always resolves to "unknown"
    source = "unknown";
    confidence = classificationScore;
    status = "uncertain";
    reviewRequired = false;
  } else {
    // Below 0.50 → human indicator; confidence = 1 - score
    source = "human";
    confidence = 1 - classificationScore;
    status = "mapped";
    reviewRequired = false;
  }

  // Trust rule 3: confidence: 1.0 is reserved for explicit agent signals only.
  // For all other cases, cap at 0.89 to distinguish from certainty.
  if (!signals.isExplicitAgentSignal && confidence >= 1.0) {
    confidence = 0.89;
  }

  return {
    classificationScore,
    source,
    confidence,
    status,
    reviewRequired,
    classificationSignals,
  };
}
