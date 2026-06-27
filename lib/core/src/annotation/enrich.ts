// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 103 — Unified enrichEntry() gateway.
 *
 * Every entry creation path (add, watch, hook, ingestAIContext) must call
 * enrichEntry() before writing to disk.  This function is idempotent: fields
 * already populated on the entry are never overwritten.
 *
 * Enrichment layers applied in order:
 *   1. Content fingerprint + initial drift          (Gap 100)
 *   2. Scope classification                          (existing, centralised)
 *   3. Ingestion provenance                          (Gap 101)
 *   4. Structured annotation summary                 (Gap 102)
 *   5. Raw capture context                           (Gap 102)
 */

import type { ContextEntry } from "../schema/context-entry.schema.js";
import { extractFingerprint } from "../staleness/index.js";
import { classifyScope } from "../scope/classifier.js";
import { summarize } from "./summarize.js";
import type { SummarizeInput } from "./summarize.js";

export interface EnrichOptions {
  /** Which ingestion path is creating this entry. */
  sourceType: "hook" | "watcher" | "manual" | "sdk";
  /**
   * True when an explicit agent signal (KODELA_AGENT env var, origin.json
   * sidecar, or SDK direct call) identified the AI tool with certainty.
   * Drives the ingestion = "deterministic" vs "heuristic" distinction.
   */
  isExplicitAgent: boolean;
  /**
   * Resolved trust tier for this entry.
   * "high"   — hook / KODELA_AGENT / SDK
   * "medium" — known env + UBA corroboration
   * "low"    — pure heuristic
   */
  trustLevel: "high" | "medium" | "low";
  /** Full post-change file content (used for fingerprint + AST). */
  fileContent?: string;
  /** Unified diff string captured at annotation time. */
  diff?: string;
  linesAdded?: number;
  linesRemoved?: number;
  fileCount?: number;
  /** First-sentence AI-generated proposal note (for intent extraction). */
  aiProposalNote?: string;
}

/**
 * Apply all enrichment layers to a partial ContextEntry.
 * Fields already set on `entry` are never overwritten (idempotent).
 * Returns a new object — does not mutate the input.
 */
export function enrichEntry(
  entry: ContextEntry,
  opts: EnrichOptions,
): ContextEntry {
  const lines = opts.fileContent?.split("\n") ?? [];
  const slice =
    lines.length > 0
      ? lines
          .slice(entry.lineRange.start - 1, entry.lineRange.end)
          .join("\n")
      : "";

  // ── Layer 1: content fingerprint + initial drift (Gap 100) ───────────────
  const contentFingerprint =
    entry.contentFingerprint ??
    (slice.length > 0 ? extractFingerprint(slice) : undefined);

  const contentDrift = entry.contentDrift ?? "low";

  // ── Layer 2: scope classification ─────────────────────────────────────────
  const scope = entry.scope ?? classifyScope(entry.filePath);

  // ── Layer 3: ingestion provenance (Gap 101) ────────────────────────────────
  const trustLevel = entry.trustLevel ?? opts.trustLevel;
  const sourceType = entry.sourceType ?? opts.sourceType;
  const ingestion =
    entry.ingestion ??
    (opts.isExplicitAgent ? "deterministic" : "heuristic");

  // ── Layer 4: structured summary (Gap 102) ─────────────────────────────────
  const summaryInput: SummarizeInput = {
    diff: opts.diff,
    filePath: entry.filePath,
    linesAdded: opts.linesAdded ?? 0,
    linesRemoved: opts.linesRemoved ?? 0,
    fileCount: opts.fileCount ?? 1,
    aiTool: entry.aiTool,
    aiProposalNote: opts.aiProposalNote,
  };
  const summary = entry.summary ?? summarize(summaryInput);

  // ── Layer 5: raw context capture (Gap 102) ─────────────────────────────────
  const sessionId = entry.sessionId ?? entry.origin?.sessionId;
  const rawContext = entry.rawContext ?? {
    linesAdded: opts.linesAdded ?? 0,
    linesRemoved: opts.linesRemoved ?? 0,
    fileCount: opts.fileCount ?? 1,
    ...(opts.diff ? { diff: opts.diff } : {}),
    ...(sessionId ? { sessionId } : {}),
  };

  return {
    ...entry,
    ...(contentFingerprint ? { contentFingerprint } : {}),
    contentDrift,
    scope,
    trustLevel,
    sourceType,
    ingestion,
    summary,
    rawContext,
  };
}
