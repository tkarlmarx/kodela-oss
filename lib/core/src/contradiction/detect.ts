// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Decision-contradiction detection engine.
 *
 * Flags when an incoming change (or a proposed decision) REVERSES or CONTRADICTS
 * an active recorded decision — the "empty market quadrant" the competitive
 * analysis identified (auto-captured why + contradiction detection). Ported and
 * typed from the Phase-0 prototype, which measured 100% precision / 0%
 * false-positive rate on the real decision store; see
 * `prototypes/contradiction-detection/` and
 * `docs/product/ai-dev-tooling-competitive-analysis.md`.
 *
 * Three tiers, all transparent (no LLM, no network) so every flag is auditable:
 *   Tier 1  topic gate     — only compare against a decision on the SAME entity.
 *   Tier 2a polarity       — the change asserts the opposite stance (0.90).
 *   Tier 2b primary slot   — the change claims a single-occupancy "primary"
 *                            slot a different mechanism already holds (0.75).
 *   Tier 3  supersession   — the change revives a stance a superseding decision
 *                            already reversed (0.60).
 *
 * Only decisions with status "active" are enforced (proposed decisions are not),
 * keeping precision the default. Recall is the tunable dimension for later phases.
 */
import { stanceOf, OPPOSED } from "./stance.js";
import type {
  ContradictionChange,
  ContradictionDecision,
  ContradictionFlag,
  DetectOptions,
  EntityStance,
} from "./types.js";

/** Compose the text the engine reasons over from a change's fields. */
export function changeText(change: ContradictionChange): string {
  if (change.text && change.text.trim().length > 0) return change.text;
  return [change.title, change.problem, change.decision, change.reason]
    .filter((s): s is string => Boolean(s))
    .join(". ");
}

/** Compose the text a decision reasons over from its fields. */
function decisionText(d: ContradictionDecision): string {
  return [d.title, d.problem, d.decision, d.reason]
    .filter((s): s is string => Boolean(s))
    .join(". ");
}

interface StancedDecision extends ContradictionDecision {
  stance: EntityStance[];
}

/**
 * Detect contradictions between `change` and the ACTIVE decisions in `decisions`.
 * Supersession revival is checked against decisions superseded by an active one.
 * Returns at most one flag per (decision, entity), keeping the highest confidence.
 */
export function detectContradictions(
  change: ContradictionChange,
  decisions: ContradictionDecision[],
  options: DetectOptions = {},
): ContradictionFlag[] {
  const minConfidence = options.minConfidence ?? 0;
  const staged: StancedDecision[] = decisions.map((d) => ({
    ...d,
    stance: stanceOf(decisionText(d), options),
  }));
  const active = staged.filter((d) => d.status === "active");
  const cs = stanceOf(changeText(change), options);
  const flags: ContradictionFlag[] = [];

  for (const d of active) {
    for (const a of cs) {
      const match = d.stance.find((s) => s.entity === a.entity);
      if (!match) continue; // Tier 1: not the same entity → never compared (kills false positives)

      // Tier 2a: opposite polarity on the same entity.
      if (
        a.polarity !== "mention" &&
        match.polarity !== "mention" &&
        OPPOSED[match.polarity]?.has(a.polarity)
      ) {
        flags.push({
          decisionId: d.id,
          decisionTitle: d.title,
          entity: a.entity,
          confidence: 0.9,
          kind: "polarity",
          reason: `Change ${a.polarity.toUpperCase()}S "${a.entity}" but active decision "${d.title}" ${match.polarity.toUpperCase()}S it.`,
          changeEvidence: a.evidence,
          decisionEvidence: match.evidence,
        });
      }
    }

    // Tier 2b: single-occupancy "primary" slot — the change makes entity X the
    // primary path while the active decision holds a different entity Y as primary.
    const cPrimary = cs.find((s) => s.primary && s.polarity === "adopt");
    const dPrimary = d.stance.find((s) => s.primary);
    if (cPrimary && dPrimary && cPrimary.entity !== dPrimary.entity) {
      flags.push({
        decisionId: d.id,
        decisionTitle: d.title,
        entity: `${cPrimary.entity} vs ${dPrimary.entity}`,
        confidence: 0.75,
        kind: "primary-slot",
        reason: `Change makes "${cPrimary.entity}" the PRIMARY path, but active decision "${d.title}" holds "${dPrimary.entity}" as primary (single-occupancy slot).`,
        changeEvidence: cPrimary.evidence,
        decisionEvidence: dPrimary.evidence,
      });
    }
  }

  // Tier 3: supersession revival — the change re-asserts a stance a decision that
  // has since been superseded once held. Guards against reviving a reversed choice.
  const supersededIds = new Set(active.flatMap((d) => d.supersedes ?? []));
  for (const old of staged.filter((d) => supersededIds.has(d.id))) {
    for (const a of cs) {
      const s = old.stance.find(
        (x) => x.entity === a.entity && x.polarity === a.polarity && a.polarity !== "mention",
      );
      if (s) {
        flags.push({
          decisionId: old.id,
          decisionTitle: old.title,
          entity: a.entity,
          confidence: 0.6,
          kind: "supersession",
          reason: `Change re-asserts "${a.polarity} ${a.entity}" — matching SUPERSEDED decision "${old.title}". Verify this isn't reviving a reversed choice.`,
          changeEvidence: a.evidence,
          decisionEvidence: s.evidence,
        });
      }
    }
  }

  // De-dupe by decision+entity, keeping the highest-confidence flag.
  const byKey = new Map<string, ContradictionFlag>();
  for (const f of flags) {
    const k = `${f.decisionId}|${f.entity}`;
    const prev = byKey.get(k);
    if (!prev || prev.confidence < f.confidence) byKey.set(k, f);
  }
  return [...byKey.values()]
    .filter((f) => f.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence);
}
