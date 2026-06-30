// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_get_decision` MCP tool.
 *
 * Retrieves a decision by id, including its options and links.
 *
 * MVP scope: id-only lookup. Faceted search and semantic similarity ship in
 * Phase 2 via `kodela_search_decisions` and `kodela_find_similar_decisions`
 * (see the project design docs).
 */

import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { getDecision, type DecisionWithRelated } from "../lib/decisions-store.js";
import { resolveDecisionDb, DECISION_DB_UNAVAILABLE } from "../lib/lazy-index.js";

// ── Input schema ─────────────────────────────────────────────────────────────

export const GetDecisionInputSchema = z.object({
  decision_id: z
    .string()
    .min(1)
    .describe("Decision identifier, e.g. 'DEC-0001'"),
});

export type GetDecisionToolInput = z.infer<typeof GetDecisionInputSchema>;

// ── Core function ────────────────────────────────────────────────────────────

export interface GetDecisionResult {
  ok: boolean;
  decision?: DecisionWithRelated;
  message?: string;
  error?: string;
}

export function getDecisionForMcp(
  repoRoot: string,
  input: GetDecisionToolInput,
  db: DatabaseSync | null,
): GetDecisionResult {
  const handle = resolveDecisionDb(repoRoot, db, "get-decision");
  if (handle === null) {
    return { ok: false, error: DECISION_DB_UNAVAILABLE };
  }

  try {
    const result = getDecision(handle, input.decision_id);
    if (!result) {
      return {
        ok: false,
        error: `Decision ${input.decision_id} not found`,
      };
    }
    return {
      ok: true,
      decision: result,
      message: `Decision ${result.decision.id}: "${result.decision.title}" (${result.decision.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Response formatter ───────────────────────────────────────────────────────

export function formatGetDecisionResponse(result: GetDecisionResult): string {
  if (!result.ok) {
    return JSON.stringify({ ok: false, error: result.error }, null, 2);
  }
  return JSON.stringify(
    {
      ok: true,
      type: "kodela.decision",
      version: "1.0",
      decision: result.decision?.decision,
      options: result.decision?.options,
      links: result.decision?.links,
      message: result.message,
    },
    null,
    2,
  );
}
