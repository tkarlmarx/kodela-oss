// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 21 — `kodela health`: kill-switch criteria checker.
 *
 * Reads `.kodela/telemetry.jsonl` and evaluates three kill-switch signals
 * over a configurable rolling window (default 30 days):
 *
 *  SIGNAL 1 — Low adoption
 *    annotation_count < min_annotations (default 5)
 *    Proxy for "adoption rate < 30% of AI PRs" from the spec.
 *
 *  SIGNAL 2 — High friction (prompt dismissal)
 *    dismissal_ratio = dismissed / (added + dismissed) > max_dismissal_ratio (default 0.70)
 *    Proxy for "nobody uses the shortcut — too many steps."
 *
 *  SIGNAL 3 — Nag fatigue
 *    nag_ignored_ratio = nag_ignored / (nag_ignored + annotation_added) > max_nag_ratio (default 0.50)
 *    Proxy for "false-positive nag rate > 50%."
 *
 * Exit code: 0 when all signals pass; 1 when any signal triggers a kill-switch.
 *
 * NOTE: "Merge conflict rate > 20% of PRs touch .kodela/" cannot be computed
 * automatically without git hook instrumentation.  `kodela health` reports
 * this as a MANUAL SIGNAL with instructions.
 */

import { readTelemetryEvents } from "@kodela/core";

export type HealthOptions = {
  repoRoot: string;
  /** Rolling window in days (default 30). */
  windowDays?: number;
  /** Annotation count below this triggers signal 1 (default 5). */
  minAnnotations?: number;
  /** Dismissal ratio above this triggers signal 2 (default 0.70). */
  maxDismissalRatio?: number;
  /** Nag-ignored ratio above this triggers signal 3 (default 0.50). */
  maxNagRatio?: number;
  /** Override reference time (Unix ms) for deterministic tests. */
  now?: number;
};

export type KillSwitchSignal = {
  name: string;
  pass: boolean;
  value: number | null;
  threshold: number | null;
  message: string;
};

export type HealthResult = {
  windowDays: number;
  annotationCount: number;
  hoverCount: number;
  dismissalCount: number;
  nagIgnoredCount: number;
  dismissalRatio: number | null;
  nagIgnoredRatio: number | null;
  signals: KillSwitchSignal[];
  /** true when ALL signals pass (no kill-switch triggered). */
  healthy: boolean;
};

export async function runHealth(opts: HealthOptions): Promise<HealthResult> {
  const {
    repoRoot,
    windowDays = 30,
    minAnnotations = 5,
    maxDismissalRatio = 0.70,
    maxNagRatio = 0.50,
  } = opts;
  const now = opts.now ?? Date.now();
  const afterMs = now - windowDays * 24 * 60 * 60 * 1000;

  const events = await readTelemetryEvents(repoRoot, { afterMs });

  let annotationCount = 0;
  let hoverCount = 0;
  let dismissalCount = 0;
  let nagIgnoredCount = 0;

  for (const e of events) {
    if (e.type === "annotation_added") annotationCount++;
    else if (e.type === "hover_viewed") hoverCount++;
    else if (e.type === "prompt_dismissed") dismissalCount++;
    else if (e.type === "nag_ignored") nagIgnoredCount++;
  }

  const dismissalDenominator = annotationCount + dismissalCount;
  const dismissalRatio =
    dismissalDenominator > 0 ? dismissalCount / dismissalDenominator : null;

  const nagDenominator = annotationCount + nagIgnoredCount;
  const nagIgnoredRatio =
    nagDenominator > 0 ? nagIgnoredCount / nagDenominator : null;

  // ── Signal 1: Low adoption ──────────────────────────────────────────────
  const adoptionPass = annotationCount >= minAnnotations;
  const adoptionSignal: KillSwitchSignal = {
    name: "adoption",
    pass: adoptionPass,
    value: annotationCount,
    threshold: minAnnotations,
    message: adoptionPass
      ? `${annotationCount} annotations added in the last ${windowDays} days — above minimum of ${minAnnotations}.`
      : `⚠ Only ${annotationCount} annotations in the last ${windowDays} days (minimum: ${minAnnotations}).  Fix friction before wider rollout.`,
  };

  // ── Signal 2: High friction (dismissal ratio) ───────────────────────────
  const frictionPass =
    dismissalRatio === null || dismissalRatio <= maxDismissalRatio;
  const frictionSignal: KillSwitchSignal = {
    name: "friction",
    pass: frictionPass,
    value: dismissalRatio !== null ? Math.round(dismissalRatio * 1000) / 1000 : null,
    threshold: maxDismissalRatio,
    message:
      dismissalRatio === null
        ? `No dismissal data yet — insufficient sample.`
        : frictionPass
          ? `Dismissal ratio ${(dismissalRatio * 100).toFixed(1)}% — within acceptable range (max ${(maxDismissalRatio * 100).toFixed(0)}%).`
          : `⚠ Dismissal ratio ${(dismissalRatio * 100).toFixed(1)}% exceeds ${(maxDismissalRatio * 100).toFixed(0)}% threshold.  The annotation flow has too many steps.`,
  };

  // ── Signal 3: Nag fatigue ──────────────────────────────────────────────
  const nagPass = nagIgnoredRatio === null || nagIgnoredRatio <= maxNagRatio;
  const nagSignal: KillSwitchSignal = {
    name: "nag_fatigue",
    pass: nagPass,
    value: nagIgnoredRatio !== null ? Math.round(nagIgnoredRatio * 1000) / 1000 : null,
    threshold: maxNagRatio,
    message:
      nagIgnoredRatio === null
        ? `No nag data yet — insufficient sample.`
        : nagPass
          ? `Nag-ignored ratio ${(nagIgnoredRatio * 100).toFixed(1)}% — within acceptable range (max ${(maxNagRatio * 100).toFixed(0)}%).`
          : `⚠ Nag-ignored ratio ${(nagIgnoredRatio * 100).toFixed(1)}% exceeds ${(maxNagRatio * 100).toFixed(0)}% threshold.  Raise minInsertionLines or reduce report frequency.`,
  };

  // ── Manual signal (merge conflicts) ────────────────────────────────────
  const mergeConflictSignal: KillSwitchSignal = {
    name: "merge_conflicts",
    pass: true, // must be evaluated manually
    value: null,
    threshold: null,
    message:
      "MANUAL CHECK: If >20% of PRs touch .kodela/ with merge conflicts, switch to per-entry file storage (Gap 17).",
  };

  const signals = [adoptionSignal, frictionSignal, nagSignal, mergeConflictSignal];
  const healthy = signals.every((s) => s.pass);

  return {
    windowDays,
    annotationCount,
    hoverCount,
    dismissalCount,
    nagIgnoredCount,
    dismissalRatio,
    nagIgnoredRatio,
    signals,
    healthy,
  };
}

export function formatHealthResult(
  result: HealthResult,
  format: "text" | "json" = "text",
): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  const { windowDays, annotationCount, hoverCount, dismissalCount, nagIgnoredCount } = result;

  const lines: string[] = [
    `Kodela health check — last ${windowDays} days`,
    "─".repeat(55),
    `  Annotations added   : ${annotationCount}`,
    `  Hovers viewed       : ${hoverCount}`,
    `  Prompts dismissed   : ${dismissalCount}`,
    `  Nags ignored        : ${nagIgnoredCount}`,
    "",
    "Kill-switch signals:",
    "─".repeat(55),
  ];

  for (const signal of result.signals) {
    const icon = signal.pass ? "✔" : "✖";
    lines.push(`  ${icon} [${signal.name}] ${signal.message}`);
  }

  lines.push("─".repeat(55));
  if (result.healthy) {
    lines.push("Overall: HEALTHY — no kill-switch thresholds triggered.");
  } else {
    lines.push("Overall: KILL-SWITCH — one or more thresholds triggered. See above.");
  }

  return lines.join("\n");
}
