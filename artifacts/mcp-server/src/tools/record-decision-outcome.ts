// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_record_decision_outcome` MCP tool (07 §3.6).
 *
 * Records what actually happened after a decision shipped — the realized
 * outcome plus optional evidence links — without changing the decision's
 * status. Closes the decision lifecycle loop: record → (supersede) → outcome.
 */

import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  recordDecisionOutcome,
  type DecisionEvidenceLink,
  type DecisionWithRelated,
} from "../lib/decisions-store.js";
import { resolveDecisionDb, DECISION_DB_UNAVAILABLE } from "../lib/lazy-index.js";

// ── Input schema ─────────────────────────────────────────────────────────────

const EvidenceLinkSchema = z.object({
  kind: z
    .string()
    .min(1)
    .describe("Evidence kind, e.g. 'metric', 'incident', 'pr', 'doc'"),
  url: z.string().min(1).describe("Where the evidence lives"),
  label: z.string().optional().describe("Friendly label for the evidence"),
});

export const RecordDecisionOutcomeInputSchema = z.object({
  decision_id: z
    .string()
    .min(1)
    .describe("Decision identifier, e.g. 'DEC-0001'"),
  outcome: z
    .string()
    .min(30, "outcome must describe what actually happened (min 30 chars)"),
  evidence_links: z.array(EvidenceLinkSchema).default([]),
});

export type RecordDecisionOutcomeToolInput = z.infer<
  typeof RecordDecisionOutcomeInputSchema
>;

// ── Core function ────────────────────────────────────────────────────────────

export interface RecordDecisionOutcomeResult {
  ok: boolean;
  decision?: DecisionWithRelated;
  message?: string;
  error?: string;
}

export function recordDecisionOutcomeForMcp(
  repoRoot: string,
  input: RecordDecisionOutcomeToolInput,
  db: DatabaseSync | null,
): RecordDecisionOutcomeResult {
  const handle = resolveDecisionDb(repoRoot, db, "record-decision-outcome");
  if (handle === null) {
    return { ok: false, error: DECISION_DB_UNAVAILABLE };
  }
  try {
    const evidence: DecisionEvidenceLink[] = input.evidence_links.map((e) => ({
      kind: e.kind,
      url: e.url,
      label: e.label,
    }));
    const updated = recordDecisionOutcome(
      handle,
      repoRoot,
      input.decision_id,
      input.outcome,
      evidence,
    );
    return {
      ok: true,
      decision: updated,
      message:
        `Outcome recorded for ${updated.decision.id}: "${updated.decision.title}". ` +
        `${evidence.length} evidence link(s).`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Response formatter ───────────────────────────────────────────────────────

export function formatRecordDecisionOutcomeResponse(
  result: RecordDecisionOutcomeResult,
): string {
  if (!result.ok) {
    return JSON.stringify({ ok: false, error: result.error }, null, 2);
  }
  return JSON.stringify(
    {
      ok: true,
      type: "kodela.decision.outcome",
      version: "1.0",
      decision_id: result.decision?.decision.id,
      outcome: result.decision?.decision.outcome,
      outcome_recorded_at: result.decision?.decision.outcome_recorded_at,
      outcome_evidence: result.decision?.decision.outcome_evidence,
      message: result.message,
    },
    null,
    2,
  );
}
