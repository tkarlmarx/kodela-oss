// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 21 — Adoption telemetry schema (no PII).
 *
 * All events are written to `.kodela/telemetry.jsonl` — one JSON object per
 * line.  The file is repo-local so teams retain full control.  No event
 * contains usernames, email addresses, file content, or annotation notes.
 *
 * Event types
 * ──────────
 *  annotation_added   — a context annotation was successfully saved.
 *  hover_viewed       — the hover card was displayed for an annotation.
 *  prompt_dismissed   — the annotation dialog was cancelled before saving.
 *  nag_ignored        — a `kodela nudge` report was shown but not acted on.
 */

import { z } from "zod/v4";

export const TELEMETRY_SCHEMA_VERSION = "1.0.0" as const;

// ---------------------------------------------------------------------------
// Individual event schemas
// ---------------------------------------------------------------------------

export const AnnotationAddedEventSchema = z.object({
  type: z.literal("annotation_added"),
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  timestamp: z.string().datetime(),
  /** Length of the note string in characters — no note content is stored. */
  noteLength: z.number().int().nonnegative(),
  /** Attribution source reported at annotation time. */
  source: z.enum(["human", "ai", "import", "unknown"]),
  /** Whether an AI-tool attribution was detected for the active session. */
  aiToolPresent: z.boolean(),
});

export const HoverViewedEventSchema = z.object({
  type: z.literal("hover_viewed"),
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  timestamp: z.string().datetime(),
  /**
   * Age of the hovered annotation at view time in milliseconds.
   * Useful for "are developers actually using old annotations?" analysis.
   */
  entryAgeMs: z.number().int().nonnegative(),
  /** Whether the annotation has an associated link. */
  hasLink: z.boolean(),
});

export const PromptDismissedEventSchema = z.object({
  type: z.literal("prompt_dismissed"),
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  timestamp: z.string().datetime(),
  /** Stage at which the dialog was dismissed (e.g. "note", "severity"). */
  stage: z.string().optional(),
});

export const NagIgnoredEventSchema = z.object({
  type: z.literal("nag_ignored"),
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  timestamp: z.string().datetime(),
  /** Number of annotations that needed attention when the nag was shown. */
  itemCount: z.number().int().nonnegative(),
});

/**
 * Gap 46 — Bidirectional AI annotation loop.
 * Logged when a `kodela propose` draft is accepted by the user.
 * No note content is stored — only structural metadata.
 */
export const ProposalAcceptedEventSchema = z.object({
  type: z.literal("proposal_accepted"),
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  timestamp: z.string().datetime(),
  /** Self-assessed confidence level returned by the AI provider. */
  confidence: z.enum(["high", "medium", "low"]),
  /** True when the user edited the note before accepting. */
  wasEdited: z.boolean(),
  /** Length of the final accepted note in characters. */
  noteLength: z.number().int().nonnegative(),
});

/**
 * Gap 46 — Bidirectional AI annotation loop.
 * Logged when a `kodela propose` draft is rejected by the user.
 * No note content is stored.
 */
export const ProposalRejectedEventSchema = z.object({
  type: z.literal("proposal_rejected"),
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  timestamp: z.string().datetime(),
  /** Self-assessed confidence level returned by the AI provider. */
  confidence: z.enum(["high", "medium", "low"]),
});

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export const TelemetryEventSchema = z.discriminatedUnion("type", [
  AnnotationAddedEventSchema,
  HoverViewedEventSchema,
  PromptDismissedEventSchema,
  NagIgnoredEventSchema,
  ProposalAcceptedEventSchema,
  ProposalRejectedEventSchema,
]);

export type AnnotationAddedEvent = z.infer<typeof AnnotationAddedEventSchema>;
export type HoverViewedEvent = z.infer<typeof HoverViewedEventSchema>;
export type PromptDismissedEvent = z.infer<typeof PromptDismissedEventSchema>;
export type NagIgnoredEvent = z.infer<typeof NagIgnoredEventSchema>;
export type ProposalAcceptedEvent = z.infer<typeof ProposalAcceptedEventSchema>;
export type ProposalRejectedEvent = z.infer<typeof ProposalRejectedEventSchema>;
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
export type TelemetryEventType = TelemetryEvent["type"];
