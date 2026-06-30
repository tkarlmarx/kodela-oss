// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Context Event normalisation and entry factory.
 *
 * This module is the canonical abstraction layer between a raw AI-tool context
 * capture event (from any SDK/hook) and a fully-formed ContextEntry that can be
 * written to disk.
 *
 *   AI Tool ──► ContextEvent
 *                    ▼
 *            normalizeContext()     ──► NormalizedContextEvent  (trustLevel + originBlock)
 *                    ▼
 *          [callForProposal()]      ──► AI-generated note  (wired in CLI layer)
 *                    ▼
 *           createObjectEntry()     ──► ContextEntry  (ready to persist)
 */

import crypto from "node:crypto";
import type { ContextEntry, Origin } from "../schema/context-entry.schema.js";
import { SCHEMA_VERSION } from "../schema/context-entry.schema.js";
import type { AttributionSource } from "../attribution/index.js";
import { ATTRIBUTION_CONFIDENCE } from "../attribution/index.js";

// ---------------------------------------------------------------------------
// Trust level
// ---------------------------------------------------------------------------

/**
 * Three-tier trust classification derived from `attributionConfidence`.
 *
 *  "confirmed"  ≥ 0.9  — KODELA_AGENT env var or origin.json sidecar.
 *                         No further upgrade needed; reviewRequired = false.
 *  "uncertain"  0.5–0.89 — known IDE env var, process ancestry, git trailer.
 *                         Attribution identified but lower confidence.
 *  "none"       < 0.5  — pure heuristic or no attribution at all.
 */
export type TrustLevel = "confirmed" | "uncertain" | "none";

/**
 * Map a numeric attributionConfidence value to a symbolic TrustLevel.
 */
export function confidenceToTrustLevel(attributionConfidence: number): TrustLevel {
  if (attributionConfidence >= ATTRIBUTION_CONFIDENCE.VSCODE_COMMAND) {
    return "confirmed";
  }
  if (attributionConfidence >= ATTRIBUTION_CONFIDENCE.HEURISTIC) {
    return "uncertain";
  }
  return "none";
}

// ---------------------------------------------------------------------------
// Raw context event (input to normalizeContext)
// ---------------------------------------------------------------------------

/**
 * A raw context event emitted by a Kodela SDK or file-watcher hook.
 * Contains all the signals available at capture time.
 */
export type ContextEvent = {
  /** The AI tool that wrote the code (e.g. "replit-agent", "cursor", "copilot"). */
  tool: string | null;
  /** Which attribution detection layer produced this result. */
  source: AttributionSource;
  /** 0–1 confidence that `tool` is correct. */
  attributionConfidence: number;
  /** Whether a higher-confidence source could upgrade attribution later. */
  canUpgradeAttribution: boolean;
  /** Repository-relative file path that changed. */
  filePath: string;
  /** Unified diff of the change (before → after). */
  diff?: string;
  /** Number of lines added in this change. */
  linesAdded: number;
  /** UBA fusion score (0–1) from the behavioral classifier. */
  ubaScore: number;
  /** Per-signal UBA breakdown for explainability. */
  ubaSignals: Record<string, number>;
  /** Source classification from the UBA behavioral scorer. */
  ubaSource: "ai" | "human" | "unknown";
  /** Session ID assigned to this batch by the SessionTracker. */
  sessionId?: string;
  /** Model used by the AI tool (e.g. "claude-3-5-sonnet-20241022"). */
  model?: string;
  /** ISO-8601 timestamp when the AI generated the code. */
  generatedAt?: string;
  /** Summary text from the origin sidecar or attribution pipeline. */
  summary?: string;
};

// ---------------------------------------------------------------------------
// Normalized context event (output of normalizeContext)
// ---------------------------------------------------------------------------

/**
 * A normalized context event with derived trust level and a pre-built origin
 * block.  Passed to `createObjectEntry()` to produce a full ContextEntry.
 */
export type NormalizedContextEvent = ContextEvent & {
  /** Derived trust level (see confidenceToTrustLevel). */
  trustLevel: TrustLevel;
  /** Pre-built origin block ready to embed in the ContextEntry. */
  originBlock: Origin | undefined;
  /**
   * AI-generated note text.  Populated by the CLI layer after calling
   * callForProposal().  Falls back to undefined — createObjectEntry() then
   * uses a heuristic note supplied by the caller.
   */
  aiNote?: string;
};

// ---------------------------------------------------------------------------
// normalizeContext
// ---------------------------------------------------------------------------

/**
 * Normalize a raw ContextEvent into a NormalizedContextEvent.
 *
 * Responsibilities:
 *  1. Map attributionConfidence → trustLevel.
 *  2. Build a structured originBlock (type, tool, model, sessionId,
 *     generatedAt, summary) ready to embed in ContextEntry.origin.
 *  3. Pass all raw event fields through unchanged.
 *
 * Does NOT call an AI provider — that is the caller's responsibility so that
 * the core package stays network-free.
 */
export function normalizeContext(event: ContextEvent): NormalizedContextEvent {
  const trustLevel = confidenceToTrustLevel(event.attributionConfidence);

  const originBlock: Origin | undefined =
    event.tool != null
      ? {
          type: "ai",
          tool: event.tool ?? undefined,
          model: event.model,
          sessionId: event.sessionId,
          generatedAt: event.generatedAt,
          summary: event.summary,
        }
      : undefined;

  return {
    ...event,
    trustLevel,
    originBlock,
  };
}

// ---------------------------------------------------------------------------
// createObjectEntry options
// ---------------------------------------------------------------------------

export type CreateObjectEntryOptions = {
  /** Line range [start, end] (1-indexed, inclusive) for this hunk. */
  lineRange: [number, number];
  /** Content hash for this hunk. */
  contentHash: string;
  /** Author identity string (e.g. KODELA_AUTHOR or GIT_AUTHOR_NAME). */
  author: string;
  /**
   * Heuristic note to use when normalized.aiNote is absent.
   * The caller is responsible for producing a sensible fallback.
   */
  fallbackNote: string;
  /** UBA-derived entry source (written directly to source field). */
  source: "ai" | "human" | "unknown";
  /** Final UBA confidence score after all promotion/demotion rules. */
  confidence: number;
  /** Final UBA mapping status after all promotion/demotion rules. */
  status: "mapped" | "uncertain" | "orphaned";
  /** Final reviewRequired flag after all promotion/demotion rules. */
  reviewRequired: boolean;
};

// ---------------------------------------------------------------------------
// createObjectEntry
// ---------------------------------------------------------------------------

/**
 * Canonical ContextEntry factory.
 *
 * Produces a fully-formed ContextEntry from a NormalizedContextEvent.
 * The caller supplies per-hunk fields (lineRange, contentHash) and
 * UBA-derived classification fields (source, confidence, status,
 * reviewRequired, fallbackNote).
 *
 * Trust-level promotion rules applied here:
 *  - "confirmed" → reviewRequired forced to false, "confirmed" tag added.
 *  - canUpgradeAttribution false when trustLevel is "confirmed"
 *    (no further upgrade needed — the signal is already as strong as possible).
 */
export function createObjectEntry(
  normalized: NormalizedContextEvent,
  opts: CreateObjectEntryOptions,
): ContextEntry {
  const now = new Date().toISOString();
  const entryId = crypto.randomUUID();
  const { trustLevel, originBlock, aiNote } = normalized;

  const note = (aiNote && aiNote.trim().length > 0) ? aiNote.trim() : opts.fallbackNote;

  const [hunkStart, hunkEnd] = opts.lineRange;

  const baseTags: string[] = opts.source === "ai" ? ["ai", "auto"] : ["auto"];
  if (trustLevel === "confirmed") {
    baseTags.push("confirmed");
  }

  const isConfirmed = trustLevel === "confirmed";

  const reviewRequired = isConfirmed ? false : opts.reviewRequired;

  const originWithSummary: Origin | undefined = originBlock
    ? {
        ...originBlock,
        summary: aiNote
          ? (aiNote.trim().split(/(?<=[.!?])\s+/)[0] ?? aiNote.trim()).slice(0, 200)
          : originBlock.summary,
      }
    : undefined;

  const entry: ContextEntry = {
    schemaVersion: SCHEMA_VERSION,
    id: entryId,
    filePath: normalized.filePath,
    astAnchor: null,
    contentHash: opts.contentHash,
    lineRange: {
      start: hunkStart,
      end: Math.max(hunkStart, hunkEnd),
    },
    note,
    author: opts.author,
    createdAt: now,
    updatedAt: now,
    severity: "low",
    tags: baseTags,
    source: opts.source,
    confidence: opts.confidence,
    attributionConfidence: normalized.attributionConfidence,
    canUpgradeAttribution: isConfirmed ? false : normalized.canUpgradeAttribution,
    ...(normalized.tool ? { aiTool: normalized.tool } : {}),
    classificationScore: normalized.ubaScore,
    classificationSignals: normalized.ubaSignals,
    status: opts.status,
    reviewRequired,
    ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}),
    ...(originWithSummary ? { origin: originWithSummary } : {}),
  };

  return entry;
}
