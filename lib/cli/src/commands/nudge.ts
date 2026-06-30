// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 20a — Nudge: CI / PR-bot adoption guardrail.
 *
 * `kodela nudge` scans the repository for entries that need attention and
 * outputs a CI-friendly report — either plain text, JSON, or a Markdown
 * block ready to post as a PR comment (default).
 *
 * Categories surfaced:
 *   - Orphaned entries (code was deleted or moved without updating the annotation)
 *   - Uncertain entries (line-number drift — manual review needed)
 *   - Entries flagged as `reviewRequired: true`
 *
 * Exit code: 0 when all clean; 1 when any entries need attention.
 * This lets CI step authors use `kodela nudge || post_pr_comment` directly.
 */

import { readIndex, readContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";

export type NudgeOptions = {
  repoRoot: string;
  format?: "text" | "comment" | "json";
};

export type NudgeResult = {
  orphaned: ContextEntry[];
  uncertain: ContextEntry[];
  reviewRequired: ContextEntry[];
  /** true when any of the above lists is non-empty */
  needsAttention: boolean;
};

export async function runNudge(opts: NudgeOptions): Promise<NudgeResult> {
  const { repoRoot } = opts;

  const index = await readIndex(repoRoot);
  const allEntries = await Promise.all(
    index.entries.map((id) => readContextEntry(repoRoot, id)),
  );

  const orphaned = allEntries.filter((e) => e.status === "orphaned");
  const uncertain = allEntries.filter(
    (e) => e.status === "uncertain" && !orphaned.includes(e),
  );
  const reviewRequired = allEntries.filter(
    (e) => e.reviewRequired && e.status === "mapped",
  );

  return {
    orphaned,
    uncertain,
    reviewRequired,
    needsAttention:
      orphaned.length > 0 || uncertain.length > 0 || reviewRequired.length > 0,
  };
}

export function formatNudgeResult(
  result: NudgeResult,
  format: "text" | "comment" | "json" = "comment",
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        needsAttention: result.needsAttention,
        orphaned: result.orphaned.map(nudgeSummary),
        uncertain: result.uncertain.map(nudgeSummary),
        reviewRequired: result.reviewRequired.map(nudgeSummary),
      },
      null,
      2,
    );
  }

  if (!result.needsAttention) {
    const msg = "Kodela: all annotations are healthy — nothing to nudge.";
    if (format === "comment") {
      return `> ✅ **Kodela context check passed.** All annotations are healthy.`;
    }
    return msg;
  }

  if (format === "comment") {
    return formatCommentBlock(result);
  }
  return formatTextBlock(result);
}

function nudgeSummary(e: ContextEntry): {
  id: string;
  filePath: string;
  lineRange: { start: number; end: number };
  note: string;
  status: string;
} {
  return {
    id: e.id,
    filePath: e.filePath,
    lineRange: e.lineRange,
    note: e.note,
    status: e.status,
  };
}

function formatCommentBlock(result: NudgeResult): string {
  const lines: string[] = [
    `> ⚠️ **Kodela context annotations need attention.**`,
    `>`,
    `> Run \`kodela heal\` or \`kodela explain <file>\` to review.`,
    `>`,
  ];

  if (result.orphaned.length > 0) {
    lines.push(`> **✗ Orphaned** (${result.orphaned.length}) — code was deleted or moved:`);
    for (const e of result.orphaned.slice(0, 5)) {
      lines.push(`> - \`${e.filePath}:${e.lineRange.start}–${e.lineRange.end}\` — ${e.note}`);
    }
    if (result.orphaned.length > 5) {
      lines.push(`> - _…and ${result.orphaned.length - 5} more_`);
    }
    lines.push(`>`);
  }

  if (result.uncertain.length > 0) {
    lines.push(`> **⚠ Uncertain** (${result.uncertain.length}) — line-number drift detected:`);
    for (const e of result.uncertain.slice(0, 5)) {
      lines.push(`> - \`${e.filePath}:${e.lineRange.start}–${e.lineRange.end}\` — ${e.note}`);
    }
    if (result.uncertain.length > 5) {
      lines.push(`> - _…and ${result.uncertain.length - 5} more_`);
    }
    lines.push(`>`);
  }

  if (result.reviewRequired.length > 0) {
    lines.push(`> **🔍 Review required** (${result.reviewRequired.length}):`);
    for (const e of result.reviewRequired.slice(0, 5)) {
      lines.push(`> - \`${e.filePath}:${e.lineRange.start}–${e.lineRange.end}\` — ${e.note}`);
    }
    if (result.reviewRequired.length > 5) {
      lines.push(`> - _…and ${result.reviewRequired.length - 5} more_`);
    }
  }

  return lines.join("\n");
}

function formatTextBlock(result: NudgeResult): string {
  const lines: string[] = ["Kodela nudge — annotations needing attention", "─".repeat(50)];

  if (result.orphaned.length > 0) {
    lines.push(`\n✗ Orphaned (${result.orphaned.length}):`);
    for (const e of result.orphaned) {
      lines.push(`  ${e.filePath}:${e.lineRange.start}–${e.lineRange.end}  ${e.note}`);
    }
  }
  if (result.uncertain.length > 0) {
    lines.push(`\n⚠ Uncertain (${result.uncertain.length}):`);
    for (const e of result.uncertain) {
      lines.push(`  ${e.filePath}:${e.lineRange.start}–${e.lineRange.end}  ${e.note}`);
    }
  }
  if (result.reviewRequired.length > 0) {
    lines.push(`\n🔍 Review required (${result.reviewRequired.length}):`);
    for (const e of result.reviewRequired) {
      lines.push(`  ${e.filePath}:${e.lineRange.start}–${e.lineRange.end}  ${e.note}`);
    }
  }

  return lines.join("\n");
}
