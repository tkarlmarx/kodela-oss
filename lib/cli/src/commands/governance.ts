// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela governance` — the governance scorecard for engineering leaders.
 *
 * Surfaces the Phase-3 moat metrics over the local decision graph + captured
 * memory: decision status breakdown, proposed decisions that conflict with an
 * active one, AI attribution, and % of AI changes with captured intent, rolled
 * into a single governance score.
 *
 *   kodela governance            human scorecard
 *   kodela governance -o json    machine-readable
 *   kodela governance --ci       exit non-zero below --min-score
 *
 * Reads `.kodela/index.db` read-only; offline.
 */
import fs from "node:fs";
import path from "node:path";
import { computeGovernance, type GovernanceChange, type GovernanceScorecard } from "@kodela/core";
import { loadLocalDecisions } from "./check.js";

/** Read entries for AI-attribution + intent coverage. Empty if no store. */
async function loadEntryChanges(repoRoot: string): Promise<GovernanceChange[]> {
  const dbPath = path.join(repoRoot, ".kodela", "index.db");
  if (!fs.existsSync(dbPath)) return [];
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return [];
  }
  let db: import("node:sqlite").DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const has = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries'")
      .get();
    if (!has) return [];
    const rows = db
      .prepare("SELECT id, source, status, session_id FROM entries")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const source = String(r.source ?? "");
      return {
        id: String(r.id),
        text: "", // local entries carry no change-text; violations come from the PR/commit path
        isAi: source === "ai" || source === "mixed",
        // A "mapped" entry linked to a session was captured with an explicit why.
        hasCapturedIntent: String(r.status ?? "") === "mapped" && r.session_id != null,
      };
    });
  } finally {
    db.close();
  }
}

export interface GovernanceCommandResult {
  scorecard: GovernanceScorecard;
  hasStore: boolean;
}

export async function runGovernance(options: { repoRoot: string }): Promise<GovernanceCommandResult> {
  const decisions = await loadLocalDecisions(options.repoRoot);
  const changes = await loadEntryChanges(options.repoRoot);
  const scorecard = computeGovernance({ decisions, changes });
  return { scorecard, hasStore: decisions.length > 0 || changes.length > 0 };
}

export function formatGovernance(result: GovernanceCommandResult): string {
  const s = result.scorecard;
  if (!result.hasStore) {
    return "No memory recorded yet — nothing to govern. Run `kodela connect` and start capturing.";
  }
  const bar = (n: number): string => {
    const filled = Math.round((n / 100) * 20);
    return "█".repeat(filled) + "░".repeat(20 - filled);
  };
  const lines: string[] = [];
  lines.push("Kodela governance scorecard");
  lines.push("");
  lines.push(`  Governance score        ${bar(s.governanceScore)} ${s.governanceScore}/100`);
  lines.push("");
  lines.push(`  Decisions               ${s.decisions.total} total — ${s.decisions.active} active, ${s.decisions.proposed} proposed, ${s.decisions.superseded} superseded`);
  lines.push(`  Superseded rate         ${s.supersededRate}%`);
  lines.push(`  Proposed conflicts      ${s.proposedConflicts}${s.proposedConflicts > 0 ? "  ⚠ proposed decisions that reverse an active one" : ""}`);
  lines.push("");
  lines.push(`  AI-authored changes     ${s.aiChanges}`);
  lines.push(`  …with captured intent   ${s.aiChangesWithIntent} (${s.intentCoveragePct}%)`);
  lines.push("");
  if (s.changesEvaluated > 0) {
    lines.push(`  Decisions honored       ${s.decisionsHonoredPct}% (${s.changesEvaluated} changes checked, ${s.violatingChanges} violation(s))`);
  } else {
    lines.push(`  Decisions honored       — (no change history to check; PR check + kodela check evaluate live changes)`);
  }
  return lines.join("\n");
}
