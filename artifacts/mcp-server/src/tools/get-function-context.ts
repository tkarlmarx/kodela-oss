// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * kodela_get_function_context — the fused-graph query (internal design note).
 *
 * Given a function (file path + its stable ast_anchor), traverse the shared
 * memory graph to the session that produced it, the decision(s) it implements,
 * and any PRs / incidents linked to those — then enrich decisions with their
 * title/category/status and sessions with their start time and goal. Answers
 * "why does this risky function exist, and what decided it?"
 */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readSession } from "@kodela/core";
import { fuseFunctionContext } from "../lib/fused-traversal.js";
import { getDecision } from "../lib/decisions-store.js";

export const GetFunctionContextInputSchema = z.object({
  file_path: z.string().min(1).describe("Repo-relative path of the file containing the function."),
  ast_anchor: z
    .string()
    .min(1)
    .describe("Stable function id `<kind>:<name>` (CodeGraphFunction.ast_anchor), e.g. 'function:roundToDecimals'."),
  min_confidence: z.number().min(0).max(1).optional().describe("Drop edges below this confidence (default 0)."),
});

export type GetFunctionContextInput = z.infer<typeof GetFunctionContextInputSchema>;

export interface GetFunctionContextResult {
  ok: true;
  function: { nodeId: string; filePath: string; astAnchor: string };
  sessions: Array<{ id: string; startedAt?: string; goal?: string }>;
  decisions: Array<{ id: string; title?: string; category?: string; status?: string }>;
  pullRequests: string[];
  incidents: string[];
  found: boolean;
}

export async function getFunctionContextForMcp(
  repoRoot: string,
  input: GetFunctionContextInput,
  db: DatabaseSync | null,
): Promise<GetFunctionContextResult> {
  if (db === null) {
    return {
      ok: true,
      function: { nodeId: `${input.file_path}#${input.ast_anchor}`, filePath: input.file_path, astAnchor: input.ast_anchor },
      sessions: [],
      decisions: [],
      pullRequests: [],
      incidents: [],
      found: false,
    };
  }

  const ctx = fuseFunctionContext(db, {
    filePath: input.file_path,
    astAnchor: input.ast_anchor,
    minConfidence: input.min_confidence,
  });

  // Enrich decisions with their human-readable fields.
  const decisions = ctx.decisions.map((id) => {
    const d = getDecision(db, id)?.decision;
    return d
      ? { id, title: d.title, category: d.category, status: d.status }
      : { id };
  });

  // Enrich sessions with start time + goal (best-effort; session file may be gone).
  const sessions = await Promise.all(
    ctx.sessions.map(async (id) => {
      try {
        const s = await readSession(repoRoot, id);
        return s ? { id, startedAt: s.startedAt, goal: s.goal } : { id };
      } catch {
        return { id };
      }
    }),
  );

  return {
    ok: true,
    function: { nodeId: ctx.functionNodeId, filePath: ctx.filePath, astAnchor: ctx.astAnchor },
    sessions,
    decisions,
    pullRequests: ctx.pullRequests,
    incidents: ctx.incidents,
    found: ctx.entries.length > 0,
  };
}

export function formatFunctionContextResponse(result: GetFunctionContextResult): string {
  if (!result.found) {
    return `No captured context links to ${result.function.filePath}#${result.function.astAnchor} yet.`;
  }
  const lines: string[] = [`Context for ${result.function.filePath}#${result.function.astAnchor}:`];
  if (result.decisions.length) {
    lines.push("  Decisions:");
    for (const d of result.decisions) lines.push(`    - ${d.id}${d.title ? ` — ${d.title}` : ""}${d.status ? ` (${d.status})` : ""}`);
  }
  if (result.sessions.length) {
    lines.push("  Sessions:");
    for (const s of result.sessions) lines.push(`    - ${s.id}${s.startedAt ? ` @ ${s.startedAt}` : ""}${s.goal ? ` — ${s.goal}` : ""}`);
  }
  if (result.pullRequests.length) lines.push(`  Pull requests: ${result.pullRequests.join(", ")}`);
  if (result.incidents.length) lines.push(`  Incidents: ${result.incidents.join(", ")}`);
  return lines.join("\n");
}
