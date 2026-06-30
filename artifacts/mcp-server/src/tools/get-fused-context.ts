// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_get_fused_context` MCP tool — Sprint 1 / doc 27 [E.4]
 *
 * One-call fused retrieval that returns code-context + decisions + sessions in
 * a single envelope.  Closes doc 22 P2's "fused retrieval" promise without
 * forcing the agent to compose `kodela_get_context` + `kodela_search_decisions`
 * + `kodela_list_sessions` itself.
 *
 * Design: this is a thin wrapper.  `buildProjectContext()` already returns
 * sessions; `getContextV4()` already fuses decisions; the only piece missing
 * was surfacing the sessions array on the wire format.  This file does that
 * by extending the existing envelope shape with a `sessions` array (omitted
 * when empty, like decisions).
 *
 * Per-axis filtering matches `getContextV4`:
 *   - scope:   filePath || cluster-of(filePath)
 *   - time:    asOf?  → bitemporal join applied to BOTH halves
 *   - budget:  tokenBudget → trimmer packs results into the limit
 *
 * Doc 22 P2 promise: "one call returns code-context + decisions + sessions."
 * Doc 17 §3.1 wedge demo: "this `bfsShortestPath` function is high-risk and
 * AI-touched (code half) → here is the session that introduced it, the decision
 * that motivated it (event half)" — that whole story renders from this tool's
 * output without further plumbing.
 */

import type { DatabaseSync } from "node:sqlite";
import { buildProjectContext, type ProjectContext } from "@kodela/core";
import type { KodelaSession } from "@kodela/core";
import {
  type GetContextV4Input,
  GetContextV4InputSchema,
  type McpContextEnvelope,
  formatMcpResponse,
} from "./get-context.js";
import { getWhyForMcp } from "./get-why.js";

/**
 * The fused envelope adds a `sessions` array to the standard context envelope.
 * Backwards-compatible: callers using `kodela_get_context` still see the same
 * shape; only the new tool surfaces sessions.
 */
export type McpFusedSession = {
  session_id: string;
  started_at: string;
  ended_at?: string;
  /** Aggregated risk across the session's child entries (low/medium/high/critical). */
  aggregated_risk: "low" | "medium" | "high" | "critical";
  /** Files this session touched. */
  files_changed: string[];
  /** Number of context entries linked to this session. */
  entry_count: number;
  /**
   * Subset of the session's entry UUIDs that appear in `context.entries`.
   * Lets the agent cross-reference which captured entries came from which
   * session without re-traversing.
   */
  linked_entries: string[];
  /** Human-readable goal if the session declared one. */
  goal?: string;
};

export type McpFusedContextEnvelope = Omit<McpContextEnvelope, "type" | "context"> & {
  type: "kodela.context.fused";
  context: McpContextEnvelope["context"] & {
    sessions?: McpFusedSession[];
  };
};

export const GetFusedContextInputSchema = GetContextV4InputSchema;
export type GetFusedContextInput = GetContextV4Input;

/**
 * Wrap `getContextV4` and append the sessions array.  Doesn't re-fetch — uses
 * the sessions ProjectContext already computes during the cluster expansion.
 */
export function getFusedContext(
  repoRoot: string,
  input: GetFusedContextInput,
  db: DatabaseSync,
): McpFusedContextEnvelope {
  // Build project context directly so we can capture the sessions[] field
  // before formatMcpResponse drops it.  Same call signature getContextV4 uses.
  const context = buildProjectContext(
    db,
    {
      filePath: input.file_path,
      intent: input.intent,
      tokenBudget: input.token_budget,
      debug: false,
    },
    repoRoot,
    { tokenBudget: input.token_budget },
  );

  const base = formatMcpResponse(context, input.token_budget);

  // Promote the type marker so a consumer can branch on it if needed.
  const envelope: McpFusedContextEnvelope = {
    ...base,
    type: "kodela.context.fused",
    context: { ...base.context },
  };

  // Fuse decisions — same logic as get-context.ts but inlined here so this
  // file doesn't depend on a non-exported helper.
  if (input.file_path) {
    const why = getWhyForMcp(
      repoRoot,
      {
        file_path: input.file_path,
        include_intermediate_evidence: false,
        max_depth: 3,
        min_edge_confidence: 0.6,
        ...(input.as_of ? { as_of: input.as_of } : {}),
      },
      db,
    );
    if (why.ok && why.why && why.why.length > 0) {
      envelope.context.decisions = why.why.slice(0, 5).map((w) => ({
        decision_id: w.decision_id,
        title: w.title,
        reason_excerpt: w.reason_excerpt,
        confidence: w.confidence,
      }));
    }
  }

  // Add the sessions slice — the NEW capability over kodela_get_context.
  const fusedSessions = packageSessions(context.sessions, context);
  if (fusedSessions.length > 0) {
    envelope.context.sessions = fusedSessions;
  }

  return envelope;
}

/**
 * Convert the rich KodelaSession[] from ProjectContext into the wire-format
 * McpFusedSession[] — drops chat metrics, intent, git snapshots etc. that
 * aren't relevant to a retrieval consumer, keeps the keys an agent needs to
 * link sessions to entries.
 */
function packageSessions(
  sessions: KodelaSession[],
  context: ProjectContext,
): McpFusedSession[] {
  const entryIds = new Set(context.entries.map((e) => e.id));
  // Limit to top 10 sessions (most-recent-first per ProjectContext ordering)
  // to keep the envelope size bounded.  Same trimming pattern as decisions.
  return sessions.slice(0, 10).map((s) => {
    const sessionEntries = (s.entries ?? []).filter((id) => entryIds.has(id));
    const result: McpFusedSession = {
      session_id: s.id,
      started_at: s.startedAt,
      aggregated_risk: s.aggregatedRisk,
      files_changed: s.filesChanged ?? [],
      entry_count: (s.entries ?? []).length,
      linked_entries: sessionEntries,
    };
    if (s.endedAt) result.ended_at = s.endedAt;
    if (s.goal) result.goal = s.goal;
    return result;
  });
}
