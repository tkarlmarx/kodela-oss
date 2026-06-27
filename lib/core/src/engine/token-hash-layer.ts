// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { createHash } from "node:crypto";
import { MappingLayerError } from "../errors.js";
import { classifyConfidence, type MappingResult } from "./confidence.js";
import { scorePositionalProximity } from "./scorer.js";
import { ContextEntrySchema } from "../schema/index.js";
import type { ContextEntry } from "../schema/index.js";
import { validateFileContent } from "../validation.js";

function normalizeTokenStream(text: string): string {
  return text
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/#[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractLinesSlice(lines: string[], start: number, end: number): string {
  return lines
    .slice(Math.max(0, start - 1), end)
    .join("\n");
}

function computeWindowSimilarity(
  targetHash: string,
  lines: string[],
  windowSize: number,
): { bestScore: number; bestLineStart: number; bestLineEnd: number } {
  let bestScore = 0;
  let bestLineStart = 1;
  let bestLineEnd = windowSize;

  const totalLines = lines.length;

  for (let i = 1; i <= totalLines - windowSize + 1; i++) {
    const slice = extractLinesSlice(lines, i, i + windowSize - 1);
    const hash = _hashTokenStream(slice);

    if (hash === targetHash) {
      return {
        bestScore: 1.0,
        bestLineStart: i,
        bestLineEnd: i + windowSize - 1,
      };
    }

    const normalizedTarget = normalizeTokenStream(
      lines.slice(Math.max(0, i - 1), i + windowSize - 1).join("\n"),
    );
    const targetLen = normalizedTarget.length;
    if (targetLen === 0) continue;

    const overlap = countCommonChars(hash.slice(0, 16), targetHash.slice(0, 16));
    const score = overlap / 16;

    if (score > bestScore) {
      bestScore = score;
      bestLineStart = i;
      bestLineEnd = i + windowSize - 1;
    }
  }

  return { bestScore, bestLineStart, bestLineEnd };
}

function countCommonChars(a: string, b: string): number {
  let count = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) count++;
  }
  return count;
}

export function hashTokenStream(text: string): string {
  validateFileContent(text);
  return _hashTokenStream(text);
}

function _hashTokenStream(text: string): string {
  return createHash("sha256").update(normalizeTokenStream(text)).digest("hex");
}

export function mapWithTokenHashLayer(
  entry: ContextEntry,
  currentFileContent: string,
): MappingResult {
  ContextEntrySchema.parse(entry);
  validateFileContent(currentFileContent);

  try {
    const lines = currentFileContent.split("\n");
    const windowSize = entry.lineRange.end - entry.lineRange.start + 1;

    if (windowSize <= 0 || lines.length < windowSize) {
      return {
        confidence: 0,
        status: "orphaned",
        updatedLineRange: entry.lineRange,
      };
    }

    const currentSlice = extractLinesSlice(
      lines,
      entry.lineRange.start,
      entry.lineRange.end,
    );
    const currentHash = _hashTokenStream(currentSlice);

    if (currentHash === entry.contentHash) {
      return {
        confidence: 0.98,
        status: "mapped",
        updatedLineRange: entry.lineRange,
        scoreBreakdown: { token: 1.0, position: 1.0 },
      };
    }

    const { bestScore, bestLineStart, bestLineEnd } = computeWindowSimilarity(
      entry.contentHash,
      lines,
      windowSize,
    );

    const confidence = bestScore * 0.9;
    const status = classifyConfidence(confidence);
    const totalLines = lines.length;
    const position = scorePositionalProximity(
      [entry.lineRange.start, entry.lineRange.end],
      [bestLineStart, bestLineEnd],
      totalLines,
    );

    return {
      confidence,
      status,
      updatedLineRange: { start: bestLineStart, end: bestLineEnd },
      scoreBreakdown: { token: bestScore, position },
    };
  } catch (err) {
    throw new MappingLayerError("token-hash", err);
  }
}
