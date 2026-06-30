// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 102 — Structured annotation summary helpers.
 *
 * Pure functions that derive a typed AnnotationSummary from diff geometry
 * and optional AI proposal text.  No network calls — all logic is deterministic.
 */

import type { AnnotationSummary } from "../schema/context-entry.schema.js";

export type { AnnotationSummary };

export interface SummarizeInput {
  diff?: string;
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
  fileCount: number;
  aiTool?: string;
  aiProposalNote?: string;
}

type IntentFallbackContext = {
  filePath?: string;
  linesAdded?: number;
  linesRemoved?: number;
};

const HIGH_RISK_PATTERNS = [
  "auth", "crypto", "secret", "password", "token",
  "payment", "billing", "oauth", "jwt", "apikey", "api-key",
];

const MEDIUM_RISK_PATTERNS = [
  "config", "env", "deploy", "infra", "db", "database",
  "migration", "seed", "schema",
];

/**
 * Classify the structural type of a change from diff geometry.
 */
export function detectChangeType(
  linesAdded: number,
  linesRemoved: number,
  isNewFile: boolean,
): AnnotationSummary["changeType"] {
  if (isNewFile) return "new-file";
  if (linesRemoved === 0 && linesAdded > 0) return "addition";
  if (linesAdded <= 10 && linesRemoved > 0) return "fix";
  const ratio = linesRemoved > 0 ? linesAdded / linesRemoved : Infinity;
  if (ratio >= 0.6 && linesRemoved > 5) return "refactor";
  return "modification";
}

/**
 * Classify risk from the file path and change size.
 * Uses path keyword matching rather than a full scope classifier call so
 * this module stays self-contained.
 */
export function classifyRisk(
  filePath: string,
  linesAdded: number,
  linesRemoved: number,
): AnnotationSummary["risk"] {
  const lower = filePath.toLowerCase();
  if (HIGH_RISK_PATTERNS.some((p) => lower.includes(p))) return "high";
  if (MEDIUM_RISK_PATTERNS.some((p) => lower.includes(p))) return "medium";
  if (linesAdded + linesRemoved > 200) return "medium";
  return "low";
}

/**
 * Extract the intent sentence from an AI proposal note.
 * Falls back to a heading-derived phrase when no note is available.
 */
export function extractIntent(
  aiProposalNote?: string,
  context?: IntentFallbackContext,
): string {
  if (aiProposalNote && aiProposalNote.trim().length > 0) {
    const trimmed = aiProposalNote.trim();
    const first = trimmed.split(/(?<=[.!?])\s+/)[0];
    if (first && first.length > 0) return first.slice(0, 200);
  }

  const linesAdded = context?.linesAdded ?? 0;
  const linesRemoved = context?.linesRemoved ?? 0;
  const action =
    linesAdded > 0 && linesRemoved === 0
      ? "Added"
      : linesAdded === 0 && linesRemoved > 0
        ? "Removed"
        : "Updated";
  const fileLabel = context?.filePath
    ? context.filePath.split(/[\\/]/).filter(Boolean).pop()
    : undefined;

  if (fileLabel && fileLabel.length > 0) {
    return `${action} ${fileLabel}`.slice(0, 200);
  }
  return `${action} code`;
}

/**
 * Generate a short human-readable summary by extracting symbol names from
 * the diff and appending the line delta.
 */
export function generateSummary(
  diff: string | undefined,
  linesAdded: number,
  linesRemoved: number,
): string {
  const delta = `${linesAdded}+/${linesRemoved}-`;
  if (!diff) return delta;

  const addedLines = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));

  const symbolPattern =
    /(?:function|class|const|let|var|export\s+(?:function|async\s+function|class|const|default\s+function))\s+(\w+)/g;

  const names = new Set<string>();
  for (const line of addedLines) {
    let m: RegExpExecArray | null;
    while ((m = symbolPattern.exec(line)) !== null) {
      if (m[1]) names.add(m[1]);
    }
    if (names.size >= 4) break;
  }

  if (names.size > 0) {
    return `${[...names].slice(0, 3).join(", ")} (${delta})`.slice(0, 200);
  }

  return delta;
}

/**
 * Derive a fully-typed AnnotationSummary from a SummarizeInput.
 * Heuristic-only — upgradeable by the AI provider call in enrichEntry().
 */
export function summarize(input: SummarizeInput): AnnotationSummary {
  const isNewFile =
    input.linesRemoved === 0 &&
    input.linesAdded > 5 &&
    (input.diff
      ? input.diff.split("\n").filter((l) => l.startsWith("+++")).length > 0 &&
        !input.diff.includes("\n---")
      : false);

  return {
    intent: extractIntent(input.aiProposalNote, {
      filePath: input.filePath,
      linesAdded: input.linesAdded,
      linesRemoved: input.linesRemoved,
    }),
    changeType: detectChangeType(
      input.linesAdded,
      input.linesRemoved,
      isNewFile,
    ),
    risk: classifyRisk(input.filePath, input.linesAdded, input.linesRemoved),
    shortSummary: generateSummary(
      input.diff,
      input.linesAdded,
      input.linesRemoved,
    ),
  };
}
