// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 104 — Deterministic trusted AI context ingestion.
 *
 * `ingestAIContext()` is the authoritative write path for any AI tool that
 * can self-report its identity.  It bypasses the UBA heuristic classifier
 * entirely and always produces entries with:
 *
 *   status: "mapped"
 *   confidence: 1.0
 *   attributionConfidence: 1.0
 *   trustLevel: "high"
 *   ingestion: "deterministic"
 *   sourceType: "sdk"
 *
 * Usage:
 *   const entry = await ingestAIContext(repoRoot, {
 *     filePath: "src/auth/session.ts",
 *     lineRange: { start: 1, end: 72 },
 *     aiTool: "replit-agent",
 *     intent: "Add Replit context helpers for AI attribution",
 *   });
 */

import crypto from "node:crypto";
import { writeContextEntry } from "../storage/index.js";
import { hashTokenStream } from "../engine/index.js";
import {
  SCHEMA_VERSION,
} from "../schema/context-entry.schema.js";
import type { ContextEntry } from "../schema/context-entry.schema.js";
import { classifyScope } from "../scope/classifier.js";
import { enrichEntry } from "../annotation/enrich.js";

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface AIContextInput {
  /** Repository-relative file path (e.g. "src/auth/session.ts"). */
  filePath: string;
  /** 1-based inclusive line range that was written by the AI tool. */
  lineRange: { start: number; end: number };
  /** Canonical AI tool name (e.g. "replit-agent", "claude-cli", "cursor"). */
  aiTool: string;
  /** Specific model version (e.g. "claude-3-5-sonnet-20241022"). Optional. */
  model?: string;
  /** Session or conversation identifier. Optional. */
  sessionId?: string;
  /**
   * Plain-text description of what the AI was asked to do.
   * Stored as both `origin.summary` and `summary.intent`.
   */
  intent?: string;
  /**
   * Unified diff string (before → after).
   * Used for fingerprint derivation and rawContext storage.
   */
  diff?: string;
  /** Full post-change content of the file. Used for fingerprinting. */
  fileContent?: string;
  linesAdded?: number;
  linesRemoved?: number;
  /** ISO-8601 timestamp when the AI generated the code. */
  generatedAt?: string;
  /** Author identity for the entry (defaults to "sdk"). */
  author?: string;
}

// ---------------------------------------------------------------------------
// ingestAIContext
// ---------------------------------------------------------------------------

/**
 * Create a fully-enriched, trusted ContextEntry from an explicit AI tool
 * event and write it to `.kodela/objects/`.
 *
 * Returns the written entry so callers can link it to sessions, clusters,
 * or schedule extraction without a second read.
 */
export async function ingestAIContext(
  repoRoot: string,
  input: AIContextInput,
): Promise<ContextEntry> {
  const now = new Date().toISOString();
  const entryId = crypto.randomUUID();

  const { start, end } = input.lineRange;
  const safeEnd = Math.max(start, end);

  // Derive content hash from the file slice when content is available.
  let contentHash: string;
  if (input.fileContent) {
    const fileLines = input.fileContent.split("\n");
    const slice = fileLines.slice(start - 1, safeEnd).join("\n");
    contentHash = hashTokenStream(slice);
  } else {
    contentHash = crypto.createHash("sha256").update(entryId).digest("hex");
  }

  const scope = classifyScope(input.filePath);

  const partial: ContextEntry = {
    schemaVersion: SCHEMA_VERSION,
    id: entryId,
    filePath: input.filePath,
    astAnchor: null,
    contentHash,
    lineRange: { start, end: safeEnd },
    note: input.intent
      ? `[sdk] ${input.intent}`
      : `[sdk] ${input.aiTool} change captured via ingestAIContext`,
    author: input.author ?? "sdk",
    createdAt: now,
    updatedAt: now,
    severity: "low",
    tags: ["ai", "sdk", "confirmed"],
    source: "ai",
    aiTool: input.aiTool,
    confidence: 1.0,
    attributionConfidence: 1.0,
    canUpgradeAttribution: false,
    status: "mapped",
    reviewRequired: false,
    scope,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.model
      ? {
          origin: {
            type: "ai",
            tool: input.aiTool,
            model: input.model,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
            ...(input.intent ? { summary: input.intent.slice(0, 200) } : {}),
          },
        }
      : input.intent || input.sessionId || input.generatedAt
        ? {
            origin: {
              type: "ai",
              tool: input.aiTool,
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              ...(input.generatedAt
                ? { generatedAt: input.generatedAt }
                : {}),
              ...(input.intent ? { summary: input.intent.slice(0, 200) } : {}),
            },
          }
        : {}),
  };

  const enriched = enrichEntry(partial, {
    sourceType: "sdk",
    isExplicitAgent: true,
    trustLevel: "high",
    fileContent: input.fileContent,
    diff: input.diff,
    linesAdded: input.linesAdded ?? 0,
    linesRemoved: input.linesRemoved ?? 0,
    fileCount: 1,
    aiProposalNote: input.intent,
  });

  await writeContextEntry(repoRoot, enriched);
  return enriched;
}
