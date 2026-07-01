// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_recall` MCP tool (Phase 1 — automatic recall injection).
 *
 * The agent-facing counterpart to `kodela recall`. Given a topic — or nothing
 * at all — it returns the most relevant prior *why* as a ready-to-paste
 * markdown block, ranked by the Phase-0 reranker (via `kodela_query`). With no
 * query it auto-recalls for the current task using the latest session goal, so
 * an agent can pull relevant memory at the START of a task without the user
 * having to ask. This is the "inject memory before you write code" primitive.
 */

import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { listSessions } from "@kodela/core";
import { formatRecallBlock, type RecallItem } from "@kodela/core/retrieval";
import { queryForMcp, QueryInputSchema } from "./query.js";

export const RecallInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "What to recall. Omit to auto-recall for the current task from the latest session goal.",
    ),
  file_path: z
    .string()
    .optional()
    .describe("Restrict recall to prior context on this file."),
  limit: z.number().int().positive().max(50).default(8),
});

export type RecallToolInput = z.infer<typeof RecallInputSchema>;

export interface RecallResult {
  ok: boolean;
  query?: string;
  /** True when the query was auto-derived from the latest session goal. */
  auto_query?: boolean;
  items?: RecallItem[];
  /** The injectable markdown block — this is what an agent pastes into context. */
  block?: string;
  error?: string;
}

/** Latest session goal (sessions come back sorted ascending by startedAt). */
async function latestSessionGoal(repoRoot: string): Promise<string | undefined> {
  const sessions = await listSessions(repoRoot).catch(() => []);
  for (let i = sessions.length - 1; i >= 0; i--) {
    const g = sessions[i]?.goal?.trim();
    if (g) return g;
  }
  return undefined;
}

export async function recallForMcp(
  repoRoot: string,
  input: RecallToolInput,
  db: DatabaseSync | null,
): Promise<RecallResult> {
  let query = input.query?.trim() ?? "";
  let autoQuery = false;
  if (!query) {
    const goal = await latestSessionGoal(repoRoot);
    if (goal) {
      query = goal;
      autoQuery = true;
    }
  }

  if (!query) {
    return {
      ok: true,
      query: "",
      auto_query: false,
      items: [],
      block:
        "_Nothing to recall: pass a query or start a session with a goal so recall knows the current task._",
    };
  }

  // Reuse the reranked query path (entries only — recall is about the captured
  // *why*, not decisions/sessions as separate rows). Hybrid mode lets the
  // reranker blend embedding similarity when an index exists; it degrades to
  // keyword+rerank offline, exactly like the CLI.
  const parsed = QueryInputSchema.parse({
    query,
    mode: "hybrid",
    scope: input.file_path ? { file_path: input.file_path } : undefined,
    include: { entries: true, decisions: false, sessions: false },
    limit: input.limit,
  });
  const result = await queryForMcp(repoRoot, parsed, db);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const items: RecallItem[] = (result.results ?? []).map((r) => {
    const m = r.metadata as {
      file_path?: string;
      line_range?: { start: number; end: number };
      tags?: string[];
    };
    const range = m.line_range ? `:${m.line_range.start}-${m.line_range.end}` : "";
    return {
      ref: `${m.file_path ?? r.id}${range}`,
      note: r.snippet,
      score: r.score,
      tags: m.tags,
    };
  });

  const heading = autoQuery
    ? `## Relevant prior context for this task\n_(recalled for the current session goal: "${query}")_`
    : `## Relevant prior context for "${query}"`;

  return {
    ok: true,
    query,
    auto_query: autoQuery,
    items,
    block: formatRecallBlock(query, items, { heading }),
  };
}

export function formatRecallResponse(result: RecallResult): string {
  if (!result.ok) {
    return JSON.stringify({ ok: false, error: result.error }, null, 2);
  }
  return JSON.stringify(
    {
      ok: true,
      type: "kodela.recall.block",
      version: "1.0",
      query: result.query,
      auto_query: result.auto_query,
      items: result.items,
      block: result.block,
    },
    null,
    2,
  );
}
