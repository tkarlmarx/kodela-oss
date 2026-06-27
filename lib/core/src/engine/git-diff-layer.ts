// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MappingLayerError } from "../errors.js";
import { classifyConfidence, type MappingResult } from "./confidence.js";
import { ContextEntrySchema } from "../schema/index.js";
import type { ContextEntry } from "../schema/index.js";
import { validateRepoRoot } from "../validation.js";

const execFileAsync = promisify(execFile);

type HunkHeader = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
};

function parseHunkHeader(line: string): HunkHeader | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (match === null) return null;
  return {
    oldStart: parseInt(match[1]!, 10),
    oldCount: parseInt(match[2] ?? "1", 10),
    newStart: parseInt(match[3]!, 10),
    newCount: parseInt(match[4] ?? "1", 10),
  };
}

function applyDiffOffset(
  originalStart: number,
  originalEnd: number,
  diffOutput: string,
): { newStart: number; newEnd: number; confidence: number } {
  const lines = diffOutput.split("\n");
  let cumulativeOffset = 0;
  let relevantHunks = 0;
  let affectingHunks = 0;

  for (const line of lines) {
    if (!line.startsWith("@@")) continue;
    const hunk = parseHunkHeader(line);
    if (hunk === null) continue;

    const hunkOldEnd = hunk.oldStart + hunk.oldCount - 1;
    const addedLines = hunk.newCount - hunk.oldCount;

    if (hunkOldEnd < originalStart) {
      cumulativeOffset += addedLines;
      relevantHunks++;
    } else if (hunk.oldStart <= originalEnd && hunkOldEnd >= originalStart) {
      affectingHunks++;
    }
  }

  const newStart = originalStart + cumulativeOffset;
  const newEnd = originalEnd + cumulativeOffset;

  let confidence: number;
  if (affectingHunks === 0 && relevantHunks >= 0) {
    confidence = 0.75;
  } else if (affectingHunks > 0) {
    confidence = 0.55;
  } else {
    confidence = 0.65;
  }

  return { newStart, newEnd, confidence };
}

export async function mapWithGitDiffLayer(
  entry: ContextEntry,
  repoRoot: string,
): Promise<MappingResult> {
  ContextEntrySchema.parse(entry);
  validateRepoRoot(repoRoot);

  try {
    let diffOutput: string;

    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "HEAD", "--", entry.filePath],
        { cwd: repoRoot, timeout: 5000 },
      );
      diffOutput = stdout;
    } catch {
      const { newStart, newEnd, confidence } = {
        newStart: entry.lineRange.start,
        newEnd: entry.lineRange.end,
        confidence: 0.45,
      };
      return {
        confidence,
        status: classifyConfidence(confidence),
        updatedLineRange: { start: newStart, end: newEnd },
      };
    }

    if (diffOutput.trim() === "") {
      return {
        confidence: 0.7,
        status: "uncertain",
        updatedLineRange: entry.lineRange,
      };
    }

    const { newStart, newEnd, confidence } = applyDiffOffset(
      entry.lineRange.start,
      entry.lineRange.end,
      diffOutput,
    );

    const status = classifyConfidence(confidence);
    return {
      confidence,
      status,
      updatedLineRange: { start: newStart, end: newEnd },
    };
  } catch (err) {
    if (err instanceof MappingLayerError) throw err;
    throw new MappingLayerError("git-diff", err);
  }
}

export { applyDiffOffset, parseHunkHeader };
