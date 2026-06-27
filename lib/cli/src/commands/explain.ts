// SPDX-License-Identifier: AGPL-3.0-only
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
