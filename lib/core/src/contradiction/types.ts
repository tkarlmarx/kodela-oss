// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Types for decision-contradiction detection.
 *
 * The engine is pure and storage-agnostic: callers (the MCP tool, the CLI, the
 * PR check) load decisions from wherever they live and map them to
 * `ContradictionDecision` before calling `detectContradictions`. Keeping the
 * input shape minimal means lib/core never depends on the decision store's row
 * type (which lives in the MCP server / db packages).
 */

/** Whether a piece of text ADOPTS, REJECTS, or DEFERS an entity — or merely mentions it. */
export type Stance = "adopt" | "reject" | "defer" | "mention";

/** A stance the text takes on a single canonical entity. */
export interface EntityStance {
  /** Canonical entity name (e.g. "MongoDB", "MCP", "tree-sitter"). */
  entity: string;
  polarity: Stance;
  /** True when the text claims the single-occupancy "primary" slot for this entity. */
  primary: boolean;
  /** Short human-readable snippet showing why this stance was inferred. */
  evidence: string;
}

/**
 * The minimal decision shape the engine needs. Maps from the decision store's
 * `DecisionRow` (MCP/db) or the CLI's local-graph read.
 */
export interface ContradictionDecision {
  id: string;
  title: string;
  /** "proposed" | "active" | "superseded" | "archived" | "rejected" (only "active" is enforced). */
  status: string;
  problem?: string | null;
  decision?: string | null;
  reason?: string | null;
  /** Ids of decisions THIS decision supersedes (reversed stances to guard against reviving). */
  supersedes?: string[];
}

/** An incoming change or a proposed decision to test against the active decisions. */
export interface ContradictionChange {
  /** Free-text description (commit message, PR title/body, proposed-decision text). */
  text?: string;
  title?: string | null;
  problem?: string | null;
  decision?: string | null;
  reason?: string | null;
}

/** Which detection tier produced a flag. */
export type ContradictionKind = "polarity" | "primary-slot" | "supersession" | "semantic";

/** A single detected contradiction between a change and a decision. */
export interface ContradictionFlag {
  decisionId: string;
  decisionTitle: string;
  entity: string;
  /** 0–1. Polarity reversal 0.9, primary-slot 0.75, supersession revival 0.6. */
  confidence: number;
  kind: ContradictionKind;
  reason: string;
  changeEvidence: string;
  decisionEvidence: string;
}

export interface DetectOptions {
  /**
   * Extra entity aliases merged over the built-in lexicon: `{ "kafka": "Kafka" }`.
   * Lets a repo teach the topic-gate its own stack without code changes.
   */
  aliases?: Record<string, string>;
  /** Drop flags below this confidence. Default 0 (keep all). */
  minConfidence?: number;
}

/** An embedding function (e.g. `@kodela/embed`'s ONNX embedder `.embed`). */
export type EmbedFn = (text: string) => Promise<number[]>;

/** The verdict an LLM-judge returns on a semantic candidate. */
export interface JudgeVerdict {
  isViolation: boolean;
  confidence: number;
  reason: string;
}

/**
 * An LLM-judge — decides whether a change reverses a decision when the cheap gate
 * can't tell (semantic candidates). Injected so the core stays offline; callers
 * wire an LLM.
 */
export type JudgeFn = (input: {
  changeText: string;
  decisionText: string;
  decisionTitle: string;
}) => Promise<JudgeVerdict>;

/**
 * The recall dial. The base regex engine stays the high-precision default; these
 * layer on top:
 *   - `embed`  widens the topic gate past the keyword lexicon (semantic match).
 *   - `judge`  decides violation on the candidates the gate surfaces.
 */
export interface AsyncDetectOptions extends DetectOptions {
  embed?: EmbedFn;
  /** Cosine-similarity floor for a semantic topic match. Default 0.72. */
  semanticThreshold?: number;
  judge?: JudgeFn;
  /**
   * When an embedder is set but no judge is, surface semantic topic matches as
   * low-confidence "review" flags (recall without a judge). Default false —
   * precision stays the default; a judge is required to assert a violation.
   */
  semanticReview?: boolean;
}
