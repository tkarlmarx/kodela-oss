// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Memory hygiene (Phase 1 — P1.3).
 *
 * A pure analyzer over the whole context-entry set that surfaces memory that has
 * gone *bad*: mappings that lost their anchor (orphaned), notes that no longer
 * match their code (uncertain / drifted), entries a human flagged for review,
 * low-confidence guesses, entries that have sat untouched for a long time, and
 * — the contradiction signal TrueMemory has and Kodela lacked — multiple
 * annotations piled on the SAME lines of the SAME file, which is where stale and
 * conflicting *why* accumulates.
 *
 * This is a *reviewable list*, not an auto-fixer. Kodela never silently deletes
 * or rewrites captured why (see project DNA: humans author/resolve). The report
 * ranks issues so a developer — or `kodela hygiene` in CI — can act on the worst
 * first. No I/O here: callers load entries and pass them in, so it is trivially
 * testable and reused by the CLI, the MCP tool, and the dashboard alike.
 */

import type { ContextEntry } from "../schema/index.js";

export type HygieneIssueKind =
  | "orphaned"
  | "drifted"
  | "review-required"
  | "low-confidence"
  | "stale"
  | "overlap";

export type HygieneSeverity = "high" | "medium" | "low";

export interface HygieneIssue {
  kind: HygieneIssueKind;
  severity: HygieneSeverity;
  /** Entry ids this issue concerns (one for most kinds; 2+ for `overlap`). */
  entryIds: string[];
  filePath: string;
  /** Human-readable, specific — safe to print straight into a report. */
  detail: string;
  /** What a human should do about it. */
  suggestion: string;
}

export interface HygieneReport {
  totalEntries: number;
  /** Entries that raised at least one issue (deduped across kinds). */
  flaggedEntries: number;
  byKind: Record<HygieneIssueKind, number>;
  issues: HygieneIssue[];
  /** A 0–100 score: 100 = pristine, lower = more (and more severe) issues. */
  healthScore: number;
}

export interface HygieneOptions {
  /** Entries not updated in this many days are `stale`. Default 180. */
  staleDays?: number;
  /** confidence below this is `low-confidence`. Default 0.5. */
  minConfidence?: number;
  /**
   * "Now" as an epoch ms — injected so the analyzer stays pure/deterministic.
   * Defaults to Date.now() when omitted (callers in tests pass a fixed value).
   */
  now?: number;
}

const SEVERITY_WEIGHT: Record<HygieneSeverity, number> = { high: 5, medium: 2, low: 1 };
const DAY_MS = 86_400_000;

/** True when [aStart,aEnd] and [bStart,bEnd] share at least one line. */
function rangesOverlap(a: ContextEntry, b: ContextEntry): boolean {
  return a.lineRange.start <= b.lineRange.end && b.lineRange.start <= a.lineRange.end;
}

/**
 * Analyze a set of context entries for hygiene issues. Pure and deterministic
 * (pass `now` to pin time). Archived entries are ignored — hygiene is about the
 * *live* memory an agent would actually read.
 */
export function analyzeHygiene(
  entries: readonly ContextEntry[],
  opts: HygieneOptions = {},
): HygieneReport {
  const staleDays = opts.staleDays ?? 180;
  const minConfidence = opts.minConfidence ?? 0.5;
  const now = opts.now ?? Date.now();

  // Consider only live memory; anything archived is intentionally retired.
  const live = entries.filter((e) => (e as { archived?: boolean }).archived !== true);

  const issues: HygieneIssue[] = [];
  const flagged = new Set<string>();
  const flag = (issue: HygieneIssue) => {
    issues.push(issue);
    for (const id of issue.entryIds) flagged.add(id);
  };

  for (const e of live) {
    if (e.status === "orphaned") {
      flag({
        kind: "orphaned",
        severity: "high",
        entryIds: [e.id],
        filePath: e.filePath,
        detail: `Annotation lost its anchor in ${e.filePath} — the code it described is gone or moved.`,
        suggestion: "Re-anchor with `kodela heal`, or archive it if the context is obsolete.",
      });
    } else if (e.status === "uncertain") {
      flag({
        kind: "drifted",
        severity: "medium",
        entryIds: [e.id],
        filePath: e.filePath,
        detail: `Mapping for ${e.filePath}:${e.lineRange.start}-${e.lineRange.end} is uncertain — the code drifted from the note.`,
        suggestion: "Review the note against the current code; `kodela heal` may re-map it.",
      });
    }

    if (e.reviewRequired) {
      flag({
        kind: "review-required",
        severity: "medium",
        entryIds: [e.id],
        filePath: e.filePath,
        detail: `Entry on ${e.filePath} is flagged reviewRequired and hasn't been confirmed.`,
        suggestion: "Confirm or correct the note (`kodela enrich` / `kodela correct`).",
      });
    }

    if (e.confidence < minConfidence) {
      flag({
        kind: "low-confidence",
        severity: "low",
        entryIds: [e.id],
        filePath: e.filePath,
        detail: `Low-confidence context (${e.confidence.toFixed(2)}) on ${e.filePath} — may be a weak auto-guess.`,
        suggestion: "Enrich the note so future recall trusts it, or remove it.",
      });
    }

    const ageDays = (now - Date.parse(e.updatedAt)) / DAY_MS;
    if (Number.isFinite(ageDays) && ageDays > staleDays) {
      flag({
        kind: "stale",
        severity: "low",
        entryIds: [e.id],
        filePath: e.filePath,
        detail: `Untouched for ${Math.round(ageDays)} days (> ${staleDays}) — ${e.filePath} may have moved on since.`,
        suggestion: "Re-confirm it still holds, or let it age out via `kodela archive`.",
      });
    }
  }

  // Contradiction candidates: 2+ live, mapped entries piled on overlapping lines
  // of the same file. We don't judge WHICH is right — we surface the pile-up so a
  // human reconciles it (that's where conflicting/stale why hides).
  const byFile = new Map<string, ContextEntry[]>();
  for (const e of live) {
    if (e.status === "orphaned") continue; // an orphan isn't really "on" those lines
    (byFile.get(e.filePath) ?? byFile.set(e.filePath, []).get(e.filePath)!).push(e);
  }
  for (const [filePath, group] of byFile) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.lineRange.start - b.lineRange.start);
    for (let i = 0; i < sorted.length; i++) {
      const cluster = [sorted[i]!];
      for (let j = i + 1; j < sorted.length; j++) {
        if (rangesOverlap(sorted[i]!, sorted[j]!)) cluster.push(sorted[j]!);
      }
      if (cluster.length >= 2) {
        const ids = cluster.map((c) => c.id);
        flag({
          kind: "overlap",
          severity: "medium",
          entryIds: ids,
          filePath,
          detail:
            `${cluster.length} annotations overlap on ${filePath}:` +
            `${cluster[0]!.lineRange.start}-${Math.max(...cluster.map((c) => c.lineRange.end))} — possible duplicate or contradictory why.`,
          suggestion: "Reconcile them: keep the current reason, archive the superseded ones.",
        });
        // Advance past the cluster so we don't re-report every pair.
        i += cluster.length - 1;
      }
    }
  }

  const byKind = {
    orphaned: 0,
    drifted: 0,
    "review-required": 0,
    "low-confidence": 0,
    stale: 0,
    overlap: 0,
  } as Record<HygieneIssueKind, number>;
  let penalty = 0;
  for (const issue of issues) {
    byKind[issue.kind] += 1;
    penalty += SEVERITY_WEIGHT[issue.severity];
  }

  // Health = share of the weighted "worst case" avoided, mapped to 0–100. The
  // denominator scales with corpus size so one bad entry in 1000 barely dents it.
  const worstCase = Math.max(1, live.length) * SEVERITY_WEIGHT.high;
  const healthScore = Math.round(Math.max(0, 1 - penalty / worstCase) * 100);

  // Rank: severity first, then group multi-entry (overlap) issues up.
  issues.sort(
    (a, b) =>
      SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] ||
      b.entryIds.length - a.entryIds.length,
  );

  return {
    totalEntries: live.length,
    flaggedEntries: flagged.size,
    byKind,
    issues,
    healthScore,
  };
}
