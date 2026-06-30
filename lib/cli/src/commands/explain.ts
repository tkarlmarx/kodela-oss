// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { readIndex, readContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { normalizeFilePath } from "../utils/repo.js";
import { formatEntries, type OutputMode, type FormatEntryOptions } from "../output/formatters.js";

export type ExplainOptions = {
  filePath: string;
  line?: number;
  output?: OutputMode;
  repoRoot: string;
};

export type ExplainResult = {
  entries: ContextEntry[];
  filePath: string;
};

export async function runExplain(opts: ExplainOptions): Promise<ExplainResult> {
  const { repoRoot, line, output: _output = "text" } = opts;
  const filePath = normalizeFilePath(opts.filePath);

  const index = await readIndex(repoRoot);
  const allEntries = await Promise.all(
    index.entries.map((id) => readContextEntry(repoRoot, id)),
  );

  const fileEntries = allEntries.filter(
    (e) => normalizeFilePath(e.filePath) === filePath,
  );

  const entries =
    line !== undefined
      ? fileEntries.filter(
          (e) => e.lineRange.start <= line && line <= e.lineRange.end,
        )
      : fileEntries;

  entries.sort((a, b) => a.lineRange.start - b.lineRange.start);

  return { entries, filePath };
}

export function formatExplainResult(
  result: ExplainResult,
  output: OutputMode,
  opts: FormatEntryOptions = {},
): string {
  if (result.entries.length === 0) {
    return `No context entries found for ${result.filePath}.`;
  }
  return formatEntries(result.entries, output, opts);
}

/**
 * Render a clean, self-contained markdown snippet — the "why this changed"
 * artifact a developer drops into a PR description or a handoff message.
 * Unlike `formatExplainResult` (which mirrors the terminal/JSON views), this
 * is shaped for pasting into GitHub: no ANSI, stable ordering, attribution
 * and reasoning inline. Returns just the heading + a note when nothing was
 * captured, so it's always safe to paste.
 */
export function formatExplainShare(result: ExplainResult): string {
  const heading = `## Why this changed — \`${result.filePath}\``;
  if (result.entries.length === 0) {
    return `${heading}\n\n_No captured context yet for this file._`;
  }

  const lines: string[] = [heading, ""];
  for (const e of result.entries) {
    const range =
      e.lineRange.start === e.lineRange.end
        ? `L${e.lineRange.start}`
        : `L${e.lineRange.start}–${e.lineRange.end}`;
    const meta = [e.severity, e.source].filter(Boolean).join(" · ");
    const note = e.note.trim().replace(/\s*\n\s*/g, " ");
    lines.push(`- **${range}** (${meta}) — ${note}`);

    const reasoning = e.origin?.reasoning ?? [];
    for (const step of reasoning) {
      lines.push(`  - ${step.trim()}`);
    }
    if (e.link) {
      lines.push(`  - ↳ ${e.link}`);
    }
  }

  const count = result.entries.length;
  lines.push("");
  lines.push(
    `_Captured with [Kodela](https://github.com/tkarlmarx/kodela-oss) · ${count} note${count === 1 ? "" : "s"}._`,
  );
  return lines.join("\n");
}
