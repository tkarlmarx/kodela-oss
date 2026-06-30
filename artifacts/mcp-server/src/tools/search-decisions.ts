// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_search_decisions` MCP tool — keyword + faceted search (MVP).
 *
 * Semantic search via embeddings ships in Phase 2.
 */

import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  searchDecisions,
  type SearchDecisionsFilters,
  type SearchDecisionsResult,
} from "../lib/decisions-store.js";
import { resolveDecisionDb, DECISION_DB_UNAVAILABLE } from "../lib/lazy-index.js";

export const SearchDecisionsInputSchema = z.object({
  org_id: z.string().optional(),
  repo_id: z.string().optional(),
  query: z
    .string()
    .optional()
    .describe("Free-text query. Matches title, problem, decision, reason, tags."),
  category: z
    .enum([
      "architecture",
      "security",
      "business",
      "compliance",
      "operational",
      "deprecation",
    ])
    .optional(),
  status: z
    .enum(["proposed", "active", "superseded", "archived", "rejected"])
    .optional(),
  tags: z.array(z.string()).optional(),
  decided_after: z.string().optional().describe("ISO 8601 lower bound on decided_at"),
  decided_before: z.string().optional().describe("ISO 8601 upper bound on decided_at"),
  limit: z.number().int().positive().max(200).default(25),
});

export type SearchDecisionsToolInput = z.infer<typeof SearchDecisionsInputSchema>;

export interface SearchDecisionsToolResult {
  ok: boolean;
  results?: SearchDecisionsResult["results"];
  total?: number;
  message?: string;
  error?: string;
}

export function searchDecisionsForMcp(
  repoRoot: string,
  input: SearchDecisionsToolInput,
  db: DatabaseSync | null,
): SearchDecisionsToolResult {
  const handle = resolveDecisionDb(repoRoot, db, "search-decisions");
  if (handle === null) {
    return { ok: false, error: DECISION_DB_UNAVAILABLE };
  }
  try {
    const filters: SearchDecisionsFilters = {
      org_id: input.org_id,
      repo_id: input.repo_id,
      query: input.query,
      category: input.category,
      status: input.status,
      tags: input.tags,
      decided_after: input.decided_after,
      decided_before: input.decided_before,
      limit: input.limit,
    };
    const r = searchDecisions(handle, filters);
    return {
      ok: true,
      results: r.results,
      total: r.total,
      message: `Found ${r.total} match(es); returning ${r.results.length}.`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatSearchDecisionsResponse(r: SearchDecisionsToolResult): string {
  if (!r.ok) {
    return JSON.stringify({ ok: false, error: r.error }, null, 2);
  }
  return JSON.stringify(
    {
      ok: true,
      type: "kodela.decisions.search",
      version: "1.0",
      total: r.total,
      results: r.results,
      message: r.message,
    },
    null,
    2,
  );
}
