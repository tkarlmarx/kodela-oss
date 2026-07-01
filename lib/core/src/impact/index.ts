// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Diff impact analysis (Phase 2 — P2.3).
 *
 * Answers "what does this change touch?" on *both* axes competitors keep
 * separate:
 *   • structural blast-radius — the files that (transitively) import what you
 *     changed, so you see the ripple;
 *   • decision/risk blast-radius — the captured why, decisions and risk sitting
 *     on everything in that radius, so you see "this change relates to the
 *     ed25519 decision and touches critical-risk code".
 *
 * Pure and deterministic: the caller supplies the changed files, a reverse
 * dependency adjacency (file → files that import it), the whys per file, and an
 * optional file→decision map. No I/O, so it's reused by the CLI, a pre-commit
 * gate, and the dashboard alike.
 */

import type { WhyLink, DecisionLink } from "../comprehension/types.js";

export interface ImpactInput {
  /** Repo-relative paths that changed. */
  changedFiles: readonly string[];
  /** Reverse dependency edges: file → files that import it (its dependents). */
  dependents: Map<string, readonly string[]>;
  /** Captured whys per file. */
  whysByFile: Map<string, readonly WhyLink[]>;
  /** file → decisions fused onto it (optional). */
  decisionsByFile?: Map<string, readonly DecisionLink[]>;
}

export interface ImpactedFile {
  filePath: string;
  /** 0 = directly changed, 1 = direct importer, 2 = importer-of-importer, … */
  distance: number;
  whys: WhyLink[];
  decisions: DecisionLink[];
  riskLevel: "critical" | "high" | "medium" | "low" | "none";
}

export interface ImpactReport {
  changedFiles: string[];
  /** Everything in the blast radius (includes the changed files at distance 0). */
  impacted: ImpactedFile[];
  /** All distinct decisions touched across the radius (the fusion payload). */
  decisions: DecisionLink[];
  highestRisk: ImpactedFile["riskLevel"];
  stats: {
    changed: number;
    dependents: number;
    withWhy: number;
    decisions: number;
  };
}

export interface ComputeImpactOptions {
  /** How many dependency hops to follow. Default 2. */
  maxDepth?: number;
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

function riskFrom(whys: readonly WhyLink[]): ImpactedFile["riskLevel"] {
  let best: ImpactedFile["riskLevel"] = "none";
  for (const w of whys) {
    if ((SEVERITY_RANK[w.severity] ?? 0) > (SEVERITY_RANK[best] ?? 0)) best = w.severity;
  }
  return best;
}

export function computeImpact(input: ImpactInput, opts: ComputeImpactOptions = {}): ImpactReport {
  const maxDepth = opts.maxDepth ?? 2;
  const decisionsByFile = input.decisionsByFile ?? new Map<string, readonly DecisionLink[]>();

  // BFS over the reverse-dependency graph from every changed file, recording the
  // shortest distance at which each file enters the blast radius.
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const f of input.changedFiles) {
    if (!distance.has(f)) {
      distance.set(f, 0);
      queue.push(f);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const file = queue[head++]!;
    const d = distance.get(file)!;
    if (d >= maxDepth) continue;
    for (const dep of input.dependents.get(file) ?? []) {
      if (!distance.has(dep)) {
        distance.set(dep, d + 1);
        queue.push(dep);
      }
    }
  }

  const allDecisions = new Map<string, DecisionLink>();
  const impacted: ImpactedFile[] = [];
  for (const [filePath, d] of distance) {
    const whys = [...(input.whysByFile.get(filePath) ?? [])];
    const decisions = [...(decisionsByFile.get(filePath) ?? [])];
    for (const dec of decisions) allDecisions.set(dec.decisionId, dec);
    impacted.push({ filePath, distance: d, whys, decisions, riskLevel: riskFrom(whys) });
  }

  // Rank: closest to the change first, then by risk, then path.
  impacted.sort(
    (a, b) =>
      a.distance - b.distance ||
      (SEVERITY_RANK[b.riskLevel] ?? 0) - (SEVERITY_RANK[a.riskLevel] ?? 0) ||
      a.filePath.localeCompare(b.filePath),
  );

  let highestRisk: ImpactedFile["riskLevel"] = "none";
  for (const f of impacted) {
    if ((SEVERITY_RANK[f.riskLevel] ?? 0) > (SEVERITY_RANK[highestRisk] ?? 0)) {
      highestRisk = f.riskLevel;
    }
  }

  return {
    changedFiles: [...input.changedFiles],
    impacted,
    decisions: [...allDecisions.values()],
    highestRisk,
    stats: {
      changed: input.changedFiles.length,
      dependents: impacted.filter((f) => f.distance > 0).length,
      withWhy: impacted.filter((f) => f.whys.length > 0 || f.decisions.length > 0).length,
      decisions: allDecisions.size,
    },
  };
}
