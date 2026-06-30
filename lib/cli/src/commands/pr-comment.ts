// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 51 — GitHub / GitLab PR diff view integration.
 *
 * CLI Phase B — `kodela pr-comment`
 *
 * Reads the local `.kodela/` store and a unified diff (from `git diff` or
 * stdin), finds all annotations that overlap with changed hunks, and
 * outputs a rich Markdown PR comment body.
 *
 * Gap 55 Phase E — session grouping
 * Matched annotations are grouped by their `session_id`. For each session
 * with a group, the PR comment shows a collapsible section with the session
 * goal, file count, and aggregated risk. Annotations with no session_id go
 * into an "Ungrouped changes" section.
 *
 * Modes:
 *   kodela pr-comment                    — diff between working tree and HEAD
 *   kodela pr-comment --base <sha>       — diff between base SHA and HEAD
 *   kodela pr-comment --stdin            — read patch from stdin
 *   kodela pr-comment --output json      — output JSON instead of Markdown
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readIndex, readContextEntry, readSession } from "@kodela/core";
import {
  parsePatchHunks,
  findAnnotationsInDiff,
} from "@kodela/core";
import type { ParsedDiff, AnnotationInDiff } from "@kodela/core";
import type { ContextEntry, KodelaSession, AggregatedRisk } from "@kodela/core";

const execFileAsync = promisify(execFile);

export type SessionGroup = {
  sessionId: string;
  session: KodelaSession | null;
  annotations: AnnotationInDiff[];
};

export type PrCommentOptions = {
  repoRoot: string;
  base?: string;
  patch?: string;
  format?: "comment" | "json" | "text";
};

export type PrCommentResult = {
  totalEntries: number;
  matchedAnnotations: AnnotationInDiff[];
  orphaned: ContextEntry[];
  uncertain: ContextEntry[];
  reviewRequired: ContextEntry[];
  sessionGroups: SessionGroup[];
  ungroupedAnnotations: AnnotationInDiff[];
};

async function getGitDiff(repoRoot: string, base?: string): Promise<string> {
  const args = base
    ? ["diff", `${base}...HEAD`, "--unified=0"]
    : ["diff", "HEAD", "--unified=0"];
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot });
  return stdout;
}

function parsePatchIntoDiffs(patch: string): ParsedDiff[] {
  const diffs: ParsedDiff[] = [];
  let currentFile: string | null = null;
  let currentHunks: ReturnType<typeof parsePatchHunks> = [];

  for (const line of patch.split("\n")) {
    // "diff --git a/src/foo.ts b/src/foo.ts"
    const diffHeader = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (diffHeader) {
      if (currentFile !== null) {
        diffs.push({ filePath: currentFile, hunks: currentHunks });
      }
      currentFile = diffHeader[1];
      currentHunks = [];
      continue;
    }
    // "+++ b/src/foo.ts" — prefer this as the definitive path
    const newFileHeader = line.match(/^\+\+\+ b\/(.+)$/);
    if (newFileHeader && currentFile !== null) {
      currentFile = newFileHeader[1];
      continue;
    }
    if (line.startsWith("@@") && currentFile !== null) {
      const hunk = parsePatchHunks(line);
      currentHunks.push(...hunk);
    }
  }
  if (currentFile !== null) {
    diffs.push({ filePath: currentFile, hunks: currentHunks });
  }
  return diffs;
}

export async function runPrComment(opts: PrCommentOptions): Promise<PrCommentResult> {
  const { repoRoot } = opts;

  let rawPatch = opts.patch ?? "";
  if (!rawPatch) {
    try {
      rawPatch = await getGitDiff(repoRoot, opts.base);
    } catch {
      rawPatch = "";
    }
  }

  const index = await readIndex(repoRoot);
  const allEntries = await Promise.all(
    index.entries.map((id) => readContextEntry(repoRoot, id)),
  );

  const diff = parsePatchIntoDiffs(rawPatch);
  const matchedAnnotations = findAnnotationsInDiff(diff, allEntries);

  const orphaned = allEntries.filter((e) => e.status === "orphaned");
  const uncertain = allEntries.filter(
    (e) => e.status === "uncertain" && !orphaned.includes(e),
  );
  const reviewRequired = allEntries.filter(
    (e) => e.reviewRequired && e.status === "mapped",
  );

  // ── Gap 55 Phase E — group matched annotations by session_id ──────────────
  const sessionMap = new Map<string, AnnotationInDiff[]>();
  const ungroupedAnnotations: AnnotationInDiff[] = [];

  for (const annotation of matchedAnnotations) {
    const sid = annotation.entry.sessionId;
    if (sid) {
      const group = sessionMap.get(sid) ?? [];
      group.push(annotation);
      sessionMap.set(sid, group);
    } else {
      ungroupedAnnotations.push(annotation);
    }
  }

  const sessionGroups: SessionGroup[] = [];
  for (const [sessionId, annotations] of sessionMap.entries()) {
    const session = await readSession(repoRoot, sessionId).catch(() => null);
    sessionGroups.push({ sessionId, session, annotations });
  }

  // Sort groups: highest risk first
  const riskOrder: AggregatedRisk[] = ["critical", "high", "medium", "low"];
  sessionGroups.sort((a, b) => {
    const aRisk = a.session?.aggregatedRisk ?? "low";
    const bRisk = b.session?.aggregatedRisk ?? "low";
    return riskOrder.indexOf(aRisk) - riskOrder.indexOf(bRisk);
  });

  return {
    totalEntries: allEntries.length,
    matchedAnnotations,
    orphaned,
    uncertain,
    reviewRequired,
    sessionGroups,
    ungroupedAnnotations,
  };
}

function riskEmoji(risk: AggregatedRisk | string): string {
  switch (risk) {
    case "critical": return "🔴";
    case "high":     return "🟠";
    case "medium":   return "🟡";
    default:         return "🟢";
  }
}

function annotationTableRows(
  annotations: AnnotationInDiff[],
  format: "comment" | "text",
): string[] {
  const lines: string[] = [];
  for (const a of annotations) {
    const sev = a.entry.severity ?? "—";
    const note = a.entry.note.length > 80
      ? `${a.entry.note.slice(0, 77)}…`
      : a.entry.note;
    if (format === "comment") {
      lines.push(`| \`${a.filePath}\` | ${a.hunkLine} | ${sev} | ${note} |`);
    } else {
      lines.push(`  ${a.filePath}:${a.hunkLine}  [${sev}]  ${note}`);
    }
  }
  return lines;
}

export function formatPrCommentResult(
  result: PrCommentResult,
  format: "comment" | "json" | "text" = "comment",
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        totalEntries: result.totalEntries,
        matchedAnnotations: result.matchedAnnotations.map((a) => ({
          entryId: a.entry.id,
          filePath: a.filePath,
          hunkLine: a.hunkLine,
          note: a.entry.note,
          severity: a.entry.severity,
          author: a.entry.author,
          reviewRequired: a.entry.reviewRequired,
          sessionId: a.entry.sessionId,
        })),
        sessionGroups: result.sessionGroups.map((g) => ({
          sessionId: g.sessionId,
          goal: g.session?.goal,
          filesChangedCount: g.session?.filesChanged.length ?? 0,
          aggregatedRisk: g.session?.aggregatedRisk ?? "low",
          annotationCount: g.annotations.length,
        })),
        orphaned: result.orphaned.map((e) => ({ id: e.id, filePath: e.filePath, note: e.note })),
        uncertain: result.uncertain.map((e) => ({ id: e.id, filePath: e.filePath, note: e.note })),
        reviewRequired: result.reviewRequired.map((e) => ({ id: e.id, filePath: e.filePath, note: e.note })),
      },
      null,
      2,
    );
  }

  const lines: string[] = [];

  if (format === "comment") {
    lines.push("## Kodela Annotation Report");
    lines.push("");
  }

  const hasGrouped = result.sessionGroups.length > 0;
  const hasUngrouped = result.ungroupedAnnotations.length > 0;

  if (result.matchedAnnotations.length > 0) {
    // ── Session-grouped sections (Gap 55 Phase E) ─────────────────────────
    if (hasGrouped) {
      if (format === "comment") {
        lines.push(
          `### 📌 Inline annotations on changed lines (${result.matchedAnnotations.length})`,
        );
        lines.push("");
      } else {
        lines.push(
          `Inline annotations on changed lines (${result.matchedAnnotations.length}):`,
        );
      }

      for (const group of result.sessionGroups) {
        const risk = group.session?.aggregatedRisk ?? "low";
        const goal = group.session?.goal
          ? ` — ${group.session.goal}`
          : "";
        const fileCount = group.session?.filesChanged.length ?? "?";
        const shortId = group.sessionId.slice(0, 8);

        if (format === "comment") {
          lines.push(
            `<details><summary>${riskEmoji(risk)} Session \`${shortId}\`${goal} · ${fileCount} files · ${risk}</summary>`,
          );
          lines.push("");
          lines.push("| File | Line | Severity | Note |");
          lines.push("|------|------|----------|------|");
          lines.push(...annotationTableRows(group.annotations, "comment"));
          lines.push("");
          lines.push("</details>");
          lines.push("");
        } else {
          lines.push(`Session ${shortId}${goal} [${risk}]:`);
          lines.push(...annotationTableRows(group.annotations, "text"));
          lines.push("");
        }
      }

      if (hasUngrouped) {
        if (format === "comment") {
          lines.push(`<details><summary>📄 Direct changes (no session) · ${result.ungroupedAnnotations.length}</summary>`);
          lines.push("");
          lines.push("| File | Line | Severity | Note |");
          lines.push("|------|------|----------|------|");
          lines.push(...annotationTableRows(result.ungroupedAnnotations, "comment"));
          lines.push("");
          lines.push("</details>");
          lines.push("");
        } else {
          lines.push(`Direct changes (no session, ${result.ungroupedAnnotations.length}):`);
          lines.push(...annotationTableRows(result.ungroupedAnnotations, "text"));
          lines.push("");
        }
      }
    } else {
      // No session groups — flat table (legacy behaviour)
      if (format === "comment") {
        lines.push(
          `### 📌 Inline annotations on changed lines (${result.matchedAnnotations.length})`,
        );
        lines.push("");
        lines.push("| File | Line | Severity | Note |");
        lines.push("|------|------|----------|------|");
        lines.push(...annotationTableRows(result.matchedAnnotations, "comment"));
        lines.push("");
      } else {
        lines.push(
          `Inline annotations on changed lines (${result.matchedAnnotations.length}):`,
        );
        lines.push(...annotationTableRows(result.matchedAnnotations, "text"));
        lines.push("");
      }
    }
  } else {
    if (format === "comment") {
      lines.push("> ✅ No Kodela annotations on the changed lines in this PR.");
      lines.push("");
    }
  }

  const needsAttention =
    result.orphaned.length > 0 ||
    result.uncertain.length > 0 ||
    result.reviewRequired.length > 0;

  if (needsAttention) {
    if (format === "comment") {
      lines.push("### ⚠️ Repository annotation health");
      lines.push("");
    }
    if (result.orphaned.length > 0) {
      const label = format === "comment"
        ? `**✗ Orphaned** (${result.orphaned.length})`
        : `Orphaned (${result.orphaned.length})`;
      lines.push(format === "comment" ? `> ${label}:` : label + ":");
      for (const e of result.orphaned.slice(0, 5)) {
        const item = `\`${e.filePath}:${e.lineRange.start}\` — ${e.note}`;
        lines.push(format === "comment" ? `> - ${item}` : `  ${item}`);
      }
      if (result.orphaned.length > 5) {
        const more = `…and ${result.orphaned.length - 5} more`;
        lines.push(format === "comment" ? `> - _${more}_` : `  ${more}`);
      }
    }
    if (result.uncertain.length > 0) {
      const label = format === "comment"
        ? `**⚠ Uncertain** (${result.uncertain.length})`
        : `Uncertain (${result.uncertain.length})`;
      lines.push(format === "comment" ? `> ${label}:` : label + ":");
      for (const e of result.uncertain.slice(0, 5)) {
        const item = `\`${e.filePath}:${e.lineRange.start}\` — ${e.note}`;
        lines.push(format === "comment" ? `> - ${item}` : `  ${item}`);
      }
      if (result.uncertain.length > 5) {
        const more = `…and ${result.uncertain.length - 5} more`;
        lines.push(format === "comment" ? `> - _${more}_` : `  ${more}`);
      }
    }
    if (result.reviewRequired.length > 0) {
      const label = format === "comment"
        ? `**🔍 Review required** (${result.reviewRequired.length})`
        : `Review required (${result.reviewRequired.length})`;
      lines.push(format === "comment" ? `> ${label}:` : label + ":");
      for (const e of result.reviewRequired.slice(0, 5)) {
        const item = `\`${e.filePath}:${e.lineRange.start}\` — ${e.note}`;
        lines.push(format === "comment" ? `> - ${item}` : `  ${item}`);
      }
      if (result.reviewRequired.length > 5) {
        const more = `…and ${result.reviewRequired.length - 5} more`;
        lines.push(format === "comment" ? `> - _${more}_` : `  ${more}`);
      }
    }
  } else if (format === "comment") {
    lines.push("> ✅ **Kodela context check passed.** All annotations are healthy.");
  }

  if (format === "comment") {
    lines.push("");
    lines.push("_Powered by [Kodela](https://kodela.dev) · " +
      `${result.totalEntries} annotation(s) tracked_`);
  }

  return lines.join("\n");
}
