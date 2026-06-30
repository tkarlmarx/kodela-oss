// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 20c — Scheduled reporting: debt-score ranking.
 *
 * Debt score per entry = age_days × (lineEnd − lineStart + 1).
 *
 * Only entries whose score exceeds `threshold` (default 500) are included.
 * Snoozed entries (snoozedUntil in the future) are excluded.
 * Results are sorted descending by debt score and capped at `top` items
 * (default 3) — "Top 3 most expensive debts this week."
 */

import { readIndex, readContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";

export type ReportOptions = {
  repoRoot: string;
  /** Minimum debt score to include (default 500). */
  threshold?: number;
  /** Maximum number of entries to return (default 3). */
  top?: number;
  /** Reference time for age calculation; defaults to Date.now(). */
  now?: number;
};

export type DebtEntry = {
  entry: ContextEntry;
  debtScore: number;
  ageDays: number;
  linesChanged: number;
};

export type ReportResult = {
  items: DebtEntry[];
  /** Threshold used for filtering. */
  threshold: number;
  /** Total entries above the threshold before applying the `top` cap. */
  totalAboveThreshold: number;
  /** Entries excluded because snoozedUntil is in the future. */
  snoozedCount: number;
};

/** Returns true when an entry is currently snoozed (snoozedUntil is in the future). */
export function isEntrySnoozed(entry: ContextEntry, now: number): boolean {
  if (!entry.snoozedUntil) return false;
  return new Date(entry.snoozedUntil).getTime() > now;
}

/** Computes the debt score for one entry at the given reference time. */
export function debtScore(entry: ContextEntry, now: number): number {
  const ageDays = Math.floor(
    (now - new Date(entry.createdAt).getTime()) / (1000 * 60 * 60 * 24),
  );
  const linesChanged = entry.lineRange.end - entry.lineRange.start + 1;
  return ageDays * linesChanged;
}

export async function runReport(opts: ReportOptions): Promise<ReportResult> {
  const { repoRoot, threshold = 500, top = 3 } = opts;
  const now = opts.now ?? Date.now();

  const index = await readIndex(repoRoot);
  const allEntries = await Promise.all(
    index.entries.map((id) => readContextEntry(repoRoot, id)),
  );

  let snoozedCount = 0;
  const scored: DebtEntry[] = [];

  for (const entry of allEntries) {
    if (isEntrySnoozed(entry, now)) {
      snoozedCount++;
      continue;
    }
    const score = debtScore(entry, now);
    if (score > threshold) {
      const ageDays = Math.floor(
        (now - new Date(entry.createdAt).getTime()) / (1000 * 60 * 60 * 24),
      );
      scored.push({
        entry,
        debtScore: score,
        ageDays,
        linesChanged: entry.lineRange.end - entry.lineRange.start + 1,
      });
    }
  }

  scored.sort((a, b) => b.debtScore - a.debtScore);
  const totalAboveThreshold = scored.length;
  const items = scored.slice(0, top);

  return { items, threshold, totalAboveThreshold, snoozedCount };
}

export function formatReportResult(result: ReportResult): string {
  const { items, threshold, totalAboveThreshold, snoozedCount } = result;

  if (totalAboveThreshold === 0) {
    const snoozedNote = snoozedCount > 0 ? ` (${snoozedCount} snoozed)` : "";
    return `Kodela debt report: no entries above the threshold of ${threshold}${snoozedNote}. All good!`;
  }

  const lines: string[] = [
    `Kodela debt report — Top ${items.length} of ${totalAboveThreshold} entries above score ${threshold}${snoozedCount > 0 ? ` (${snoozedCount} snoozed)` : ""}`,
    "─".repeat(60),
  ];

  for (let i = 0; i < items.length; i++) {
    const { entry, debtScore: score, ageDays, linesChanged } = items[i];
    const severityFlag = entry.severity !== "low" ? ` [${entry.severity}]` : "";
    lines.push(
      `${i + 1}. ${entry.filePath}:${entry.lineRange.start}–${entry.lineRange.end}${severityFlag}`,
    );
    lines.push(`   Score: ${score}  (${ageDays}d × ${linesChanged} lines)`);
    lines.push(`   Note: ${entry.note}`);
    lines.push(`   Status: ${entry.status}  |  Source: ${entry.source}`);
    lines.push(`   ID: ${entry.id}`);
    if (i < items.length - 1) lines.push("");
  }

  return lines.join("\n");
}
