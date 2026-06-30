// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { readIndex, readContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { tryRunGit } from "../utils/exec.js";
import { normalizeFilePath } from "../utils/repo.js";

export type BlameLine = {
  lineNum: number;
  content: string;
  commit?: string;
  author?: string;
  entry?: ContextEntry;
};

export type BlameResult = {
  filePath: string;
  lines: BlameLine[];
};

export type BlameOptions = {
  filePath: string;
  repoRoot: string;
};

function parseGitBlamePorcelain(
  output: string,
): Map<number, { commit: string; author: string; content: string }> {
  const result = new Map<number, { commit: string; author: string; content: string }>();
  const lines = output.split("\n");
  let currentCommit = "";
  let currentAuthor = "";
  let currentLine = 0;

  for (const line of lines) {
    const headerMatch = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (headerMatch) {
      currentCommit = headerMatch[1] ?? "";
      currentLine = parseInt(headerMatch[2] ?? "0", 10);
      continue;
    }
    if (line.startsWith("author ")) {
      currentAuthor = line.slice(7);
      continue;
    }
    if (line.startsWith("\t")) {
      result.set(currentLine, {
        commit: currentCommit.slice(0, 8),
        author: currentAuthor,
        content: line.slice(1),
      });
    }
  }
  return result;
}

export async function runBlame(opts: BlameOptions): Promise<BlameResult> {
  const { repoRoot } = opts;
  const filePath = normalizeFilePath(opts.filePath);

  const blameResult = await tryRunGit(
    ["blame", "--porcelain", filePath],
    repoRoot,
  );

  const blameMap = blameResult
    ? parseGitBlamePorcelain(blameResult.stdout)
    : new Map<number, { commit: string; author: string; content: string }>();

  const index = await readIndex(repoRoot);
  const allEntries = await Promise.all(
    index.entries.map((id) => readContextEntry(repoRoot, id)),
  );

  const fileEntries = allEntries.filter(
    (e) => normalizeFilePath(e.filePath) === filePath,
  );

  const maxLine =
    blameMap.size > 0
      ? Math.max(...blameMap.keys())
      : 0;

  const blameLinesArr: BlameLine[] = [];
  for (let lineNum = 1; lineNum <= maxLine; lineNum++) {
    const info = blameMap.get(lineNum);
    const entry = fileEntries.find(
      (e) => e.lineRange.start <= lineNum && lineNum <= e.lineRange.end,
    );
    blameLinesArr.push({
      lineNum,
      content: info?.content ?? "",
      commit: info?.commit,
      author: info?.author,
      entry,
    });
  }

  return { filePath, lines: blameLinesArr };
}

export function formatBlameResult(result: BlameResult): string {
  if (result.lines.length === 0) {
    return `No blame data available for ${result.filePath}.`;
  }

  return result.lines
    .map((line) => {
      const commit = line.commit ?? "       ";
      const author = (line.author ?? "unknown").padEnd(12).slice(0, 12);
      const lineNum = String(line.lineNum).padStart(4);
      const annotation = line.entry
        ? ` [⚑ ${line.entry.note.slice(0, 40)}]`
        : "";
      return `${commit} ${author} ${lineNum} | ${line.content}${annotation}`;
    })
    .join("\n");
}
