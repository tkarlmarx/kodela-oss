// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { createHash } from "node:crypto";

function normalizeTokenStream(text: string): string {
  return text
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/#[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function hashNormalized(text: string): string {
  return createHash("sha256").update(normalizeTokenStream(text)).digest("hex");
}

function tokenize(text: string): string[] {
  return normalizeTokenStream(text)
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function diceCoefficient(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  return (2 * intersection) / (setA.size + setB.size);
}

/**
 * Score how similar a candidate set of lines is to the original content.
 *
 * - Returns 1.0 when the normalised hash of candidate content matches
 *   `oldTokenHash` exactly.
 * - When `originalLines` is provided and the hash does not match, falls back
 *   to a Sørensen–Dice coefficient on the de-duplicated normalised token sets
 *   of the original and candidate content.
 * - When only the hash is available, returns 0 for any non-exact match (since
 *   the original plain-text content cannot be recovered from a SHA-256 hash).
 */
export function scoreTokenSimilarity(
  oldTokenHash: string,
  candidateLines: string[],
  originalLines?: string[],
): number {
  const candidateText = candidateLines.join("\n");
  const candidateHash = hashNormalized(candidateText);

  if (candidateHash === oldTokenHash) return 1.0;

  if (originalLines !== undefined && originalLines.length > 0) {
    const oldTokens = tokenize(originalLines.join("\n"));
    const candidateTokens = tokenize(candidateText);
    return diceCoefficient(oldTokens, candidateTokens);
  }

  return 0;
}

/**
 * Score positional proximity between the old line range and a candidate line
 * range in the new file.
 *
 * Uses the normalised distance between midpoints relative to total file
 * length: a candidate at the same relative position scores 1.0; a candidate
 * at the opposite end of the file scores 0.0.
 */
export function scorePositionalProximity(
  oldLineRange: [number, number],
  candidateLineRange: [number, number],
  totalLines: number,
): number {
  if (totalLines <= 0) return 0;

  const oldMidpoint = (oldLineRange[0] + oldLineRange[1]) / 2;
  const candidateMidpoint = (candidateLineRange[0] + candidateLineRange[1]) / 2;

  const normalisedDistance = Math.abs(oldMidpoint - candidateMidpoint) / totalLines;
  return Math.max(0, 1 - normalisedDistance);
}
