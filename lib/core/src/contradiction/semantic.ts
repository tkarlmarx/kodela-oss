// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * The recall dial for contradiction detection.
 *
 * The base engine (detect.ts) is regex-only and high-precision — the empty
 * quadrant's safe default. This adds the two layers the roadmap deferred, both
 * opt-in and injected so the core stays offline:
 *
 *   - EMBEDDING topic-match — widens the topic gate past the keyword lexicon.
 *     A change that reverses a decision but phrases the entity differently
 *     ("the elephant database" vs "Postgres") is caught by cosine similarity.
 *   - LLM-JUDGE — decides whether a semantic candidate really reverses the
 *     decision (the cheap gate can't read polarity without a lexicon entity).
 *
 * Precision stays the default: regex flags are always kept as-is; the semantic
 * layer only ADDS flags — judge-confirmed violations (or, with `semanticReview`,
 * low-confidence review candidates). A semantic candidate is never asserted as a
 * violation without a judge.
 */
import { detectContradictions } from "./detect.js";
import { changeText } from "./detect.js";
import type {
  AsyncDetectOptions,
  ContradictionChange,
  ContradictionDecision,
  ContradictionFlag,
} from "./types.js";

/** Cosine similarity of two equal-length vectors. Returns 0 on bad input. */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const decisionText = (d: ContradictionDecision): string =>
  [d.title, d.problem, d.decision, d.reason].filter((s): s is string => Boolean(s)).join(". ");

/**
 * Detect contradictions with the optional recall dial. Without `embed`/`judge`
 * this returns exactly the base regex result (so it's a safe drop-in).
 */
export async function detectContradictionsAsync(
  change: ContradictionChange,
  decisions: ContradictionDecision[],
  options: AsyncDetectOptions = {},
): Promise<ContradictionFlag[]> {
  const base = detectContradictions(change, decisions, options);
  if (!options.embed) return base;

  const threshold = options.semanticThreshold ?? 0.72;
  const minConfidence = options.minConfidence ?? 0;
  const flaggedIds = new Set(base.map((f) => f.decisionId));
  const active = decisions.filter((d) => d.status === "active" && !flaggedIds.has(d.id));
  if (active.length === 0) return base;

  const cText = changeText(change);
  if (cText.trim().length === 0) return base;

  // Embed the change once + each candidate decision; find semantic topic matches.
  const [cVec, dVecs] = await Promise.all([
    options.embed(cText),
    Promise.all(active.map((d) => options.embed!(decisionText(d)))),
  ]);
  const candidates = active
    .map((d, i) => ({ d, sim: cosine(cVec, dVecs[i]!) }))
    .filter((c) => c.sim >= threshold)
    .sort((a, b) => b.sim - a.sim);

  const added: ContradictionFlag[] = [];
  for (const { d, sim } of candidates) {
    if (options.judge) {
      const verdict = await options.judge({ changeText: cText, decisionText: decisionText(d), decisionTitle: d.title });
      if (verdict.isViolation) {
        added.push({
          decisionId: d.id,
          decisionTitle: d.title,
          entity: "(semantic)",
          confidence: verdict.confidence,
          kind: "semantic",
          reason: verdict.reason,
          changeEvidence: cText.slice(0, 120),
          decisionEvidence: decisionText(d).slice(0, 120),
        });
      }
    } else if (options.semanticReview) {
      added.push({
        decisionId: d.id,
        decisionTitle: d.title,
        entity: "(semantic)",
        confidence: 0.4,
        kind: "semantic",
        reason: `Change is semantically close (cosine ${sim.toFixed(2)}) to "${d.title}" but shares no known entity — review whether it reverses this decision.`,
        changeEvidence: cText.slice(0, 120),
        decisionEvidence: decisionText(d).slice(0, 120),
      });
    }
  }

  return [...base, ...added]
    .filter((f) => f.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence);
}
