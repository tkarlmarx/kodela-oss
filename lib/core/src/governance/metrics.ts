// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Governance metrics — the moat scorecard for engineering leaders.
 *
 * Phase 3 of the contradiction/governance roadmap
 * (`docs/product/ai-dev-tooling-competitive-analysis.md`). Turns the decision
 * graph + the contradiction engine into the two headline numbers the strategy
 * calls for — "decisions honored vs violated" and "% AI changes with captured
 * intent" — plus the supporting counts.
 *
 * Pure and general: callers supply the decisions and (optionally) the recent
 * changes with their text + attribution. The CLI computes the local view; the
 * dashboard/api-server can feed richer change history for full violation stats.
 */
import { detectContradictions } from "../contradiction/detect.js";
import type { ContradictionDecision, ContradictionFlag } from "../contradiction/types.js";

/** A change to score: its text (for violation detection), whether AI authored, and whether its why was captured. */
export interface GovernanceChange {
  id: string;
  /** Description used for contradiction detection (commit msg / captured why). Empty → skipped for violations. */
  text: string;
  isAi: boolean;
  hasCapturedIntent: boolean;
}

export interface GovernanceInput {
  decisions: ContradictionDecision[];
  changes?: GovernanceChange[];
}

export interface GovernanceViolation {
  changeId: string;
  flags: ContradictionFlag[];
}

export interface GovernanceScorecard {
  decisions: {
    total: number;
    active: number;
    superseded: number;
    proposed: number;
    archived: number;
    rejected: number;
  };
  /** superseded / (active + superseded) — how much of the decision record has been revised. */
  supersededRate: number;
  /** Changes with non-empty text that were checked for violations. */
  changesEvaluated: number;
  violatingChanges: number;
  violations: GovernanceViolation[];
  /** 100 when no changes were evaluated. */
  decisionsHonoredPct: number;
  /** Proposed/rejected decisions that conflict with an active decision. */
  proposedConflicts: number;
  aiChanges: number;
  aiChangesWithIntent: number;
  /** 100 when there are no AI changes. */
  intentCoveragePct: number;
  /** 0–100 blend of honored-rate and intent-coverage — the single headline number. */
  governanceScore: number;
}

const pct = (num: number, den: number): number => (den === 0 ? 100 : Math.round((num / den) * 1000) / 10);

const NON_ENFORCED = new Set(["active", "superseded", "archived"]);

export function computeGovernance(input: GovernanceInput): GovernanceScorecard {
  const decisions = input.decisions;
  const changes = input.changes ?? [];

  const byStatus = (s: string): number => decisions.filter((d) => d.status === s).length;
  const active = byStatus("active");
  const superseded = byStatus("superseded");

  // Decisions honored vs violated — run the engine over each change's text.
  const violations: GovernanceViolation[] = [];
  let changesEvaluated = 0;
  for (const c of changes) {
    if (!c.text || c.text.trim().length === 0) continue;
    changesEvaluated++;
    const flags = detectContradictions({ text: c.text }, decisions);
    if (flags.length > 0) violations.push({ changeId: c.id, flags });
  }
  const violatingChanges = violations.length;

  // Proposed decisions that conflict with an active one (decision-vs-decision).
  let proposedConflicts = 0;
  for (const d of decisions.filter((x) => !NON_ENFORCED.has(x.status))) {
    const flags = detectContradictions(
      { title: d.title, problem: d.problem, decision: d.decision, reason: d.reason },
      decisions,
    );
    if (flags.length > 0) proposedConflicts++;
  }

  // % AI changes with captured intent.
  const aiChangeList = changes.filter((c) => c.isAi);
  const aiChanges = aiChangeList.length;
  const aiChangesWithIntent = aiChangeList.filter((c) => c.hasCapturedIntent).length;

  const decisionsHonoredPct = pct(changesEvaluated - violatingChanges, changesEvaluated);
  const intentCoveragePct = pct(aiChangesWithIntent, aiChanges);
  const governanceScore = Math.round((decisionsHonoredPct + intentCoveragePct) / 2);

  return {
    decisions: {
      total: decisions.length,
      active,
      superseded,
      proposed: byStatus("proposed"),
      archived: byStatus("archived"),
      rejected: byStatus("rejected"),
    },
    supersededRate: pct(superseded, active + superseded),
    changesEvaluated,
    violatingChanges,
    violations,
    decisionsHonoredPct,
    proposedConflicts,
    aiChanges,
    aiChangesWithIntent,
    intentCoveragePct,
    governanceScore,
  };
}
