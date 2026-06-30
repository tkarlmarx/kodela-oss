// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { readIndex, readContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { normalizeFilePath } from "../utils/repo.js";

export type AnnotateLine = {
  lineNum: number;
  content: string;
  entries: ContextEntry[];
};

export type AnnotateResult = {
  filePath: string;
  lines: AnnotateLine[];
  totalEntries: number;
};

export type AnnotateOptions = {
  filePath: string;
  repoRoot: string;
};

export async function runAnnotate(opts: AnnotateOptions): Promise<AnnotateResult> {
  const { repoRoot } = opts;
  const filePath = normalizeFilePath(opts.filePath);
  const absolutePath = path.resolve(repoRoot, filePath);

  let fileContent: string;
  try {
    fileContent = await fs.readFile(absolutePath, "utf-8");
  } catch {
    return { filePath, lines: [], totalEntries: 0 };
  }

  const index = await readIndex(repoRoot);
  const allEntries = await Promise.all(
    index.entries.map((id) => readContextEntry(repoRoot, id)),
  );

  const fileEntries = allEntries.filter(
    (e) => normalizeFilePath(e.filePath) === filePath,
  );

  const rawLines = fileContent.split("\n");
  const annotateLines: AnnotateLine[] = rawLines.map((content, idx) => {
    const lineNum = idx + 1;
    const entries = fileEntries.filter(
      (e) => e.lineRange.start <= lineNum && lineNum <= e.lineRange.end,
    );
    return { lineNum, content, entries };
  });

  return {
    filePath,
    lines: annotateLines,
    totalEntries: fileEntries.length,
  };
}

export function formatAnnotateResult(result: AnnotateResult): string {
  if (result.lines.length === 0) {
    return `File not found or empty: ${result.filePath}`;
  }

  const output: string[] = [];

  for (const line of result.lines) {
    const lineNum = String(line.lineNum).padStart(4);
    output.push(`${lineNum} | ${line.content}`);

    for (const entry of line.entries) {
      const statusIcon =
        entry.status === "mapped" ? "✓" : entry.status === "uncertain" ? "⚠" : "✗";
      const severity = entry.severity !== "low" ? ` [${entry.severity}]` : "";
      const review = entry.reviewRequired ? " [review required]" : "";
      output.push(
        `       ⚑ ${statusIcon} ${entry.note.slice(0, 60)}${severity}${review} — ${entry.author}`,
      );
    }
  }

  if (result.totalEntries > 0) {
    output.unshift(
      `${result.filePath} — ${result.totalEntries} context entr${result.totalEntries !== 1 ? "ies" : "y"}\n`,
    );
  }

  return output.join("\n");
}
