// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Project DNA synthesizer (internal design note) — MVP.
 *
 * Deterministic, compute-on-read. We do NOT build the doc 05 L1–L4 LLM
 * compression pipeline (Postgres `project_dna`/`file_rollups` tables, abstractive
 * Pass-2) — those are roadmap. Over a repo's handful of decisions + a small
 * graph, synthesizing on read is always-fresh and needs no distillation model.
 *
 * What powers the headline ≥90% "avoid rejected technologies" gate (internal design note):
 *   - rejected_alternatives — every losing decision option (`was_chosen=0`) with
 *     its rejection reason and the decisions that rejected it.
 *   - recent/active decisions and load-bearing decisions (by IMPLEMENTS-edge count).
 *
 * Business/Technical DNA is **seed-first** (internal design note):
 * read `.kodela/dna/project.json`. We only augment with unambiguous deterministic
 * facts (package manager from lockfile, source modules from top-level dirs). We do
 * NOT build a dependency→framework classifier.
 *
 * Integrity gate (internal design note): seeded claims (stack tokens, key_constraints) are cross-checked
 * against rejected_alternatives; a claim that names a rejected alternative is
 * dropped from the payload and reported in `meta.warnings`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  listDecisions,
  listRejectedAlternatives,
  type DecisionRow,
  type RejectedAlternative,
} from "./decisions-store.js";
import { incomingEdges } from "./graph-store.js";

// ── Seed ─────────────────────────────────────────────────────────────────────

export interface DnaSeed {
  project?: string;
  purpose?: string;
  stack?: string | string[];
  non_goals?: string[];
  key_constraints?: string[];
  /** Verbatim Technical DNA block (internal design note) — passed through to get_architecture. */
  technical?: Record<string, unknown>;
}

/** Load the hand-seeded Business/Technical DNA from `.kodela/dna/project.json`. */
export function loadDnaSeed(repoRoot: string): DnaSeed | null {
  const p = path.join(repoRoot, ".kodela", "dna", "project.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DnaSeed;
  } catch {
    return null;
  }
}

// ── Output ───────────────────────────────────────────────────────────────────

export interface DnaMeta {
  tokens_estimated: number;
  layers_consulted: string[];
  freshness: Record<string, string>;
  confidence: number;
  refreshed_at: string;
  source_event_count: number;
  warnings?: string[];
}

export interface DnaResult {
  payload: Record<string, unknown>;
  meta: DnaMeta;
  /** The technical block (seed + computed facts) — reused by get_architecture. */
  technical: Record<string, unknown>;
}

function estimateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

function detectPackageManager(repoRoot: string): string | null {
  if (existsSync(path.join(repoRoot, "pnpm-workspace.yaml")) || existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(repoRoot, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(repoRoot, "package-lock.json"))) return "npm";
  return null;
}

const SOURCE_DIR_HINTS = new Set(["lib", "src", "artifacts", "services", "packages", "app", "apps", "cmd", "internal"]);

function detectModules(repoRoot: string): string[] {
  try {
    return readdirSync(repoRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && SOURCE_DIR_HINTS.has(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function toStackTokens(stack: string | string[] | undefined): string[] {
  if (!stack) return [];
  if (Array.isArray(stack)) return stack.map((s) => s.trim()).filter(Boolean);
  return stack.split(/[•·,|]/).map((s) => s.trim()).filter(Boolean);
}

// ── Synthesis ────────────────────────────────────────────────────────────────

export interface BuildDnaOptions {
  orgId: string;
  tokenBudget: number;
  includeDecisions: boolean;
}

/**
 * Build the Project DNA for a repo. Pocket tier (token_budget ≤ 2048) returns the
 * irreducible identity + rejected-tech list (the session-start injection); larger
 * budgets add the technical block, full active-decision list, and load-bearing
 * decisions.
 */
export function buildProjectDna(
  repoRoot: string,
  db: DatabaseSync,
  opts: BuildDnaOptions,
): DnaResult {
  const seed = loadDnaSeed(repoRoot);
  const warnings: string[] = [];
  const refreshedAt = new Date().toISOString();

  // ── Decisions + rejected alternatives (the gate engine) ────────────────────
  const rejected: RejectedAlternative[] = listRejectedAlternatives(db, opts.orgId);
  let active: DecisionRow[] = listDecisions(db, { org_id: opts.orgId, status: "active", limit: 10 });
  if (active.length === 0) {
    // No active decisions yet — fall back to most recent of any status so the DNA
    // isn't empty, but flag it.
    active = listDecisions(db, { org_id: opts.orgId, limit: 10 });
    if (active.length > 0) warnings.push("No 'active' decisions; showing most recent decisions of any status.");
  }

  // Load-bearing rank: decisions with the most FILE_CHANGE/AI_SESSION —IMPLEMENTS→ edges.
  const loadBearing = active
    .map((d) => ({
      decision_id: d.id,
      title: d.title,
      implements_count: incomingEdges(db, "DECISION", d.id, { edgeTypes: ["IMPLEMENTS"] }).length,
    }))
    .filter((x) => x.implements_count > 0)
    .sort((a, b) => b.implements_count - a.implements_count);

  // ── Seed-derived identity + integrity check (internal design note) ───────────────────
  const project = seed?.project ?? path.basename(repoRoot);
  const purpose = seed?.purpose ?? null;
  const nonGoals = seed?.non_goals ?? [];

  // Cross-check seeded claims against rejected alternatives: a claim that NAMES a
  // rejected option is self-contradictory — drop it and warn (this is the gate's
  // integrity check, not cosmetic).
  const rejectedLabelsLower = rejected.map((r) => r.label.toLowerCase());
  const contradicts = (claim: string): RejectedAlternative | null => {
    const c = claim.toLowerCase();
    for (let i = 0; i < rejected.length; i++) {
      if (c.includes(rejectedLabelsLower[i])) return rejected[i];
    }
    return null;
  };

  const stackTokens = toStackTokens(seed?.stack);
  const keptStack: string[] = [];
  for (const tok of stackTokens) {
    const hit = contradicts(tok);
    if (hit) {
      warnings.push(`Seeded stack item "${tok}" names rejected alternative "${hit.label}" (${hit.decision_ids.join(", ")}); omitted from DNA.`);
    } else {
      keptStack.push(tok);
    }
  }
  const keptConstraints: string[] = [];
  for (const kc of seed?.key_constraints ?? []) {
    const hit = contradicts(kc);
    if (hit) {
      warnings.push(`Seeded constraint "${kc}" names rejected alternative "${hit.label}" (${hit.decision_ids.join(", ")}); omitted from DNA.`);
    } else {
      keptConstraints.push(kc);
    }
  }

  // ── Technical block (seed-first + unambiguous facts) ───────────────────────
  const technical: Record<string, unknown> = {
    ...(seed?.technical ?? {}),
    package_manager: (seed?.technical?.package_manager as string | undefined) ?? detectPackageManager(repoRoot) ?? undefined,
    modules: (seed?.technical?.modules as unknown) ?? detectModules(repoRoot),
  };

  // ── Confidence (deterministic — reflects how much real data backs the DNA) ──
  let confidence = 0.3;
  if (seed) confidence += 0.3;            // hand-seeded Business DNA (internal design note)
  if (active.length > 0) confidence += 0.2;
  if (rejected.length > 0) confidence += 0.2;
  confidence = Math.min(1, Number(confidence.toFixed(2)));
  if (!seed) warnings.push("No .kodela/dna/project.json seed — purpose/stack/non-goals are unavailable. Seed it for richer DNA.");
  if (confidence < 0.6) warnings.push("Low-confidence DNA: limited captured context. Treat as provisional.");

  // ── Tier shaping ───────────────────────────────────────────────────────────
  const pocket = opts.tokenBudget <= 2048;

  const recentDecisions = active.slice(0, 5).map((d) => ({
    id: d.id, title: d.title, category: d.category, status: d.status, decided_at: d.decided_at,
  }));
  const rejectedForPayload = rejected.map((r) => ({
    label: r.label,
    times_rejected: r.count,
    reason: r.reasons[0] ?? null,
    decisions: r.decision_ids,
  }));

  const payload: Record<string, unknown> = {
    project,
    purpose,
    stack: keptStack.length > 0 ? keptStack : null,
    key_constraints: keptConstraints,
    non_goals: nonGoals,
    rejected_alternatives: rejectedForPayload, // ← the "avoid rejected tech" signal
  };
  if (opts.includeDecisions) payload.recent_decisions = recentDecisions;

  const layers = ["decisions", "graph"];
  if (seed) layers.push("seed");

  if (!pocket) {
    // Standard / full tiers add the technical block + full active decisions + load-bearing.
    payload.technical = technical;
    payload.active_decisions = active.map((d) => ({
      id: d.id, title: d.title, category: d.category, status: d.status,
    }));
    payload.load_bearing = loadBearing;
    layers.push("technical");
  }

  const meta: DnaMeta = {
    tokens_estimated: estimateTokens(payload),
    layers_consulted: layers,
    // Compute-on-read ⇒ always fresh; staleness machinery (internal design note) is roadmap.
    freshness: { mode: "compute-on-read", refreshed_at: refreshedAt },
    confidence,
    refreshed_at: refreshedAt,
    source_event_count: active.length + rejected.reduce((s, r) => s + r.count, 0) + loadBearing.length,
    warnings: warnings.length > 0 ? warnings : undefined,
  };

  return { payload, meta, technical };
}
