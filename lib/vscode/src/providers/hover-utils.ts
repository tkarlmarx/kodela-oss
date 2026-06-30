// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { ContextEntry } from "@kodela/core";
import type { LinkStatus } from "./link-status-cache.js";

/**
 * Builds the Markdown string shown in the VS Code hover tooltip for a given
 * source line.
 *
 * @param entries          All context entries for the current file.
 * @param lineNum1indexed  1-indexed line number under the cursor.
 * @param isFileAIChanged  Whether the file appears to contain untracked AI changes.
 * @param linkStatusMap    Optional live/dead/unknown status per URL (Gap 18).
 * @param driftedEntryIds  Gap 16 — Set of entry IDs whose stored `contentHash`
 *                         no longer matches the current file content at the
 *                         annotated line range. When an entry is in this set, a
 *                         "lines may have drifted" warning is shown in the hover.
 */
export function buildHoverMarkdown(
  entries: ReadonlyArray<ContextEntry>,
  lineNum1indexed: number,
  isFileAIChanged: boolean = false,
  linkStatusMap?: ReadonlyMap<string, LinkStatus>,
  driftedEntryIds?: ReadonlySet<string>,
): string | null {
  const matching = entries.filter(
    (e) =>
      e.lineRange.start <= lineNum1indexed && lineNum1indexed <= e.lineRange.end,
  );
  if (matching.length === 0) return null;

  const parts: string[] = [];

  for (const entry of matching) {
    const header = buildEntryHeader(entry);
    const isDrifted = driftedEntryIds?.has(entry.id) ?? false;
    const body = buildEntryBody(entry, linkStatusMap, isDrifted);
    parts.push(`${header}\n\n${body}`);
  }

  let result = parts.join("\n\n---\n\n");

  if (isFileAIChanged) {
    result +=
      "\n\n---\n\n⚡ *This file may contain AI-generated changes — consider adding an annotation.*";
  }

  return result;
}

/** Compute how many whole days old a UTC ISO timestamp is (relative to now). */
export function getDaysOld(isoTimestamp: string): number {
  const created = new Date(isoTimestamp).getTime();
  const now = Date.now();
  return Math.floor((now - created) / (1000 * 60 * 60 * 24));
}

function buildEntryHeader(entry: ContextEntry): string {
  const badges: string[] = [`**[${entry.severity}]**`];
  if (entry.reviewRequired) badges.push("**[review required]**");

  const statusIcon =
    entry.status === "orphaned" ? "✗" : entry.status === "uncertain" ? "⚠" : "✓";

  const toolBadge = entry.aiTool ? ` \`${entry.aiTool}\`` : "";
  return `**${statusIcon} Kodela Annotation**${toolBadge} ${badges.join(" ")}`;
}

function buildEntryBody(
  entry: ContextEntry,
  linkStatusMap?: ReadonlyMap<string, LinkStatus>,
  isDrifted: boolean = false,
): string {
  const lines: string[] = [];

  if (entry.note) {
    lines.push(entry.note);
    lines.push("");
  }

  // Gap 18 — origin.summary: always rendered when present.
  // Appears right after the note so it provides rich context even when the
  // link is dead or absent.
  if (entry.origin?.summary) {
    lines.push(`*${entry.origin.summary}*`);
    lines.push("");
  }

  lines.push("---");

  const confidenceBar = buildConfidenceBar(entry.confidence);
  const confidencePct = Math.round(entry.confidence * 100);
  lines.push(
    `**Author:** ${entry.author} · **Source:** ${entry.source} · **Confidence:** ${confidenceBar} ${confidencePct}%`,
  );

  const created = entry.createdAt.slice(0, 10);
  const updated = entry.updatedAt.slice(0, 10);
  const ageDays = getDaysOld(entry.createdAt);
  lines.push(`**Created:** ${created} (${ageDays}d ago) · **Updated:** ${updated}`);

  if (entry.tags.length > 0) {
    lines.push(`**Tags:** ${entry.tags.join(", ")}`);
  }

  // AI link status — shown whenever an aiTool is set or source is "ai".
  // Gap 18: when the cached status is "dead", append a warning badge so the
  // developer knows the link no longer works.  origin.summary (rendered above)
  // always provides context even if the URL is gone.
  if (entry.aiTool || entry.source === "ai") {
    const toolLabel = entry.aiTool ?? "AI";
    if (entry.link) {
      const status = linkStatusMap?.get(entry.link) ?? "unknown";
      if (status === "dead") {
        lines.push(
          `**AI Link:** [Open ${toolLabel} Chat](${entry.link}) ⚠ Link may be dead`,
        );
      } else {
        // "live" or "unknown" (optimistic while check is in-progress)
        lines.push(`**AI Link:** [Open ${toolLabel} Chat](${entry.link}) ✅`);
      }
    } else {
      lines.push(`**AI Link:** None. Summary above is the only context. ⚠️`);
    }
  }

  // Gap 50 — External reference link to the ticket / document driving the change.
  if (entry.externalRef) {
    const ref = entry.externalRef;
    const label = ref.title ?? ref.id;
    lines.push(`**Reference:** [${label}](${ref.url})`);
  }

  if (entry.status === "orphaned") {
    lines.push("");
    lines.push("⚠ *This annotation is orphaned — run `kodela heal` to re-map it.*");
  } else if (entry.status === "uncertain") {
    lines.push("");
    lines.push(`⚠ *Mapping is uncertain (${confidencePct}% confidence) — please verify.*`);
  }

  if (isDrifted) {
    lines.push("");
    lines.push(
      "⚠ *Lines may have drifted — the annotated code no longer matches the stored snapshot. " +
        "Run `kodela heal` to re-sync.*",
    );
  }

  return lines.join("\n");
}

function buildConfidenceBar(confidence: number): string {
  const filled = Math.round(confidence * 10);
  const empty = 10 - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}
