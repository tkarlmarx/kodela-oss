// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela hygiene` (Phase 1 — P1.3 memory hygiene).
 *
 * Scans the whole captured memory for entries that have gone bad — orphaned
 * mappings, drifted notes, review backlog, low-confidence guesses, stale
 * entries, and overlapping (contradiction-candidate) annotations — and prints a
 * ranked, reviewable report with a 0–100 health score. It never mutates memory;
 * it tells a human (or CI) what to reconcile. `--ci --min-score N` fails the
 * build when memory health drops below the threshold.
 */
import { analyzeHygiene, type HygieneReport, type HygieneSeverity } from "@kodela/core/hygiene";
import { readAllEntries } from "./status.js";

export interface HygieneOptions {
  repoRoot: string;
  staleDays?: number;
  minConfidence?: number;
  /** Only show issues of this severity or worse. */
  minSeverity?: HygieneSeverity;
  limit?: number;
}

export interface HygieneRunResult {
  report: HygieneReport;
  /** The (possibly severity-filtered, limited) issues actually shown. */
  shown: HygieneReport["issues"];
}

const SEVERITY_RANK: Record<HygieneSeverity, number> = { high: 3, medium: 2, low: 1 };

export async function runHygiene(opts: HygieneOptions): Promise<HygieneRunResult> {
  const entries = await readAllEntries(opts.repoRoot);
  const report = analyzeHygiene(entries, {
    staleDays: opts.staleDays,
    minConfidence: opts.minConfidence,
  });

  let shown = report.issues;
  if (opts.minSeverity) {
    const floor = SEVERITY_RANK[opts.minSeverity];
    shown = shown.filter((i) => SEVERITY_RANK[i.severity] >= floor);
  }
  if (typeof opts.limit === "number" && opts.limit >= 0) {
    shown = shown.slice(0, opts.limit);
  }
  return { report, shown };
}

const SEVERITY_ICON: Record<HygieneSeverity, string> = { high: "●", medium: "◐", low: "○" };

export function formatHygieneResult(result: HygieneRunResult, output: "text" | "json"): string {
  if (output === "json") {
    return JSON.stringify({ ...result.report, shown: result.shown }, null, 2);
  }

  const { report, shown } = result;
  const lines: string[] = [];
  const bar = "█".repeat(Math.round(report.healthScore / 5)).padEnd(20, "░");
  lines.push(`Memory health: ${report.healthScore}/100  [${bar}]`);
  lines.push(
    `${report.totalEntries} live entr${report.totalEntries === 1 ? "y" : "ies"} · ` +
      `${report.flaggedEntries} flagged · ${report.issues.length} issue${report.issues.length === 1 ? "" : "s"}`,
  );

  if (report.issues.length === 0) {
    lines.push("");
    lines.push("✓ Memory is clean — no hygiene issues found.");
    return lines.join("\n");
  }

  const counts = Object.entries(report.byKind)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}:${n}`)
    .join("  ");
  lines.push(`by kind: ${counts}`);
  lines.push("");

  for (const issue of shown) {
    lines.push(`${SEVERITY_ICON[issue.severity]} [${issue.severity}] ${issue.kind} — ${issue.detail}`);
    lines.push(`    ↳ ${issue.suggestion}`);
    lines.push(`    entries: ${issue.entryIds.join(", ")}`);
  }

  const hidden = report.issues.length - shown.length;
  if (hidden > 0) {
    lines.push("");
    lines.push(`… and ${hidden} more (raise --limit or lower --min-severity to see them).`);
  }
  return lines.join("\n");
}
