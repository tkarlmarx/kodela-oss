// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_list_sessions` MCP tool (07 §3.15).
 *
 * Lists captured sessions with light filtering and keyset pagination, reading
 * the per-session JSON under `.kodela/sessions/` via @kodela/core's
 * `listSessions`.
 *
 * Note on `outcome`: the spec lists an `outcome` filter/field, but a session's
 * outcome is a transient `kodela_session_end` input that is never persisted
 * (see lib/core/src/mcp/builder.ts — "persisted for audit but not in schema").
 * It is therefore dropped from this MVP rather than faked. We surface what the
 * session object durably holds: actor tool, timestamps, file count, risk, and
 * the one-line handoff summary.
 */

import { z } from "zod";
import { listSessions, type KodelaSession } from "@kodela/core";

// ── Input schema ─────────────────────────────────────────────────────────────

export const ListSessionsInputSchema = z.object({
  filters: z
    .object({
      actor_tool: z
        .array(z.string())
        .optional()
        .describe("Restrict to these actor tools, e.g. ['claude-code','cursor']"),
      started_after: z.string().optional().describe("ISO 8601 lower bound on startedAt"),
      started_before: z.string().optional().describe("ISO 8601 upper bound on startedAt"),
      has_high_risk: z
        .boolean()
        .optional()
        .describe("Only sessions whose aggregated risk is high or critical"),
    })
    .optional(),
  limit: z.number().int().positive().max(100).default(25),
  cursor: z
    .string()
    .optional()
    .describe("Opaque cursor from a previous call's next_cursor"),
});

export type ListSessionsToolInput = z.infer<typeof ListSessionsInputSchema>;

// ── Output ───────────────────────────────────────────────────────────────────

export interface SessionSummary {
  session_id: string;
  started_at: string;
  ended_at: string | null;
  actor_tool: string;
  file_count: number;
  risk: string;
  summary: string;
}

export interface ListSessionsResult {
  ok: boolean;
  sessions?: SessionSummary[];
  next_cursor?: string;
  total_matched?: number;
  error?: string;
}

function toSummary(s: KodelaSession): SessionSummary {
  const fileCount = s.filesChangedDetail?.length ?? s.filesChanged.length;
  return {
    session_id: s.id,
    started_at: s.startedAt,
    ended_at: s.endedAt ?? null,
    actor_tool: s.actor?.tool ?? "unknown",
    file_count: fileCount,
    risk: s.aggregatedRisk,
    summary: s.handoffSummary ?? s.goal ?? "",
  };
}

function matchesFilters(
  s: KodelaSession,
  f: NonNullable<ListSessionsToolInput["filters"]>,
): boolean {
  if (f.actor_tool && f.actor_tool.length > 0) {
    const tool = s.actor?.tool ?? "unknown";
    if (!f.actor_tool.includes(tool)) return false;
  }
  if (f.started_after && s.startedAt < f.started_after) return false;
  if (f.started_before && s.startedAt > f.started_before) return false;
  if (f.has_high_risk && s.aggregatedRisk !== "high" && s.aggregatedRisk !== "critical") {
    return false;
  }
  return true;
}

export async function listSessionsForMcp(
  repoRoot: string,
  input: ListSessionsToolInput,
): Promise<ListSessionsResult> {
  try {
    // listSessions returns ascending by startedAt; present most-recent first.
    const all = (await listSessions(repoRoot)).reverse();
    const filters = input.filters ?? {};
    const matched = all.filter((s) => matchesFilters(s, filters));

    // Keyset pagination: cursor is the session id of the last item returned by
    // the previous page; resume strictly after it in the sorted+filtered list.
    let startIdx = 0;
    if (input.cursor) {
      const idx = matched.findIndex((s) => s.id === input.cursor);
      startIdx = idx === -1 ? 0 : idx + 1;
    }

    const page = matched.slice(startIdx, startIdx + input.limit);
    const nextIdx = startIdx + page.length;
    const next_cursor =
      nextIdx < matched.length ? page[page.length - 1]?.id : undefined;

    return {
      ok: true,
      sessions: page.map(toSummary),
      next_cursor,
      total_matched: matched.length,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Response formatter ───────────────────────────────────────────────────────

export function formatListSessionsResponse(result: ListSessionsResult): string {
  if (!result.ok) {
    return JSON.stringify({ ok: false, error: result.error }, null, 2);
  }
  return JSON.stringify(
    {
      ok: true,
      type: "kodela.sessions.list",
      version: "1.0",
      total_matched: result.total_matched,
      sessions: result.sessions,
      next_cursor: result.next_cursor,
    },
    null,
    2,
  );
}
