// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_check_contradiction` MCP tool — pre-edit / pre-decision guard.
 *
 * Given a description of a change an agent is about to make (or a decision it is
 * about to record), flags whether it REVERSES or CONTRADICTS an active recorded
 * decision. This is the "push, not pull" surface for the contradiction engine:
 * the agent asks before it writes, instead of a human catching it in review.
 *
 * High-precision by design — only active decisions are enforced, using the pure
 * offline engine in `@kodela/core` (see lib/core/src/contradiction/). No LLM, no
 * network.
 */
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  detectContradictionsAsync,
  type ContradictionDecision,
  type ContradictionFlag,
  type EmbedFn,
} from "@kodela/core";
import { resolveEmbedder } from "@kodela/embed";
import { listDecisions } from "../lib/decisions-store.js";
import { resolveDecisionDb } from "../lib/lazy-index.js";

export const CheckContradictionInputSchema = z.object({
  change: z
    .string()
    .min(1)
    .describe(
      "Plain-language description of the change or proposed decision to check " +
        "(e.g. a commit message, PR title/body, or 'reintroduce MongoDB for caching').",
    ),
  org_id: z.string().optional(),
  repo_id: z.string().optional(),
  min_confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Drop flags below this confidence (default 0 — return all)."),
  semantic: z
    .boolean()
    .optional()
    .describe(
      "Recall dial: add an on-device embedding topic-match that catches reversals " +
        "phrased unlike the keyword lexicon (surfaced as lower-confidence review flags). Offline.",
    ),
});

export type CheckContradictionToolInput = z.infer<typeof CheckContradictionInputSchema>;

export interface CheckContradictionToolResult {
  ok: boolean;
  flags?: ContradictionFlag[];
  decisionsChecked?: number;
  message?: string;
  error?: string;
}

/** Load all decisions for the scope and run the engine over the change text. */
export async function checkContradictionForMcp(
  repoRoot: string,
  input: CheckContradictionToolInput,
  db: DatabaseSync | null,
): Promise<CheckContradictionToolResult> {
  const handle = resolveDecisionDb(repoRoot, db, "check-contradiction");
  if (handle === null) {
    return { ok: true, flags: [], decisionsChecked: 0, message: "No decision store yet — nothing to contradict." };
  }

  const rows = listDecisions(handle, {
    org_id: input.org_id,
    repo_id: input.repo_id,
    limit: 200,
  });
  const decisions: ContradictionDecision[] = rows.map((d) => ({
    id: d.id,
    title: d.title,
    status: d.status,
    problem: d.problem,
    decision: d.decision,
    reason: d.reason,
    supersedes: d.supersedes,
  }));

  let embed: EmbedFn | undefined;
  if (input.semantic) {
    try {
      const resolved = await resolveEmbedder({});
      embed = (t: string) => resolved.embedder.embed(t);
    } catch {
      embed = undefined; // embedder unavailable → regex-only
    }
  }

  const flags = await detectContradictionsAsync({ text: input.change }, decisions, {
    minConfidence: input.min_confidence ?? 0,
    embed,
    semanticReview: Boolean(embed),
  });

  return {
    ok: true,
    flags,
    decisionsChecked: decisions.length,
    message:
      flags.length === 0
        ? "No contradiction with any active decision."
        : `${flags.length} potential decision violation(s) — review before proceeding.`,
  };
}

export function formatCheckContradictionResponse(result: CheckContradictionToolResult): string {
  if (!result.ok) return `Error: ${result.error ?? "unknown error"}`;
  if (!result.flags || result.flags.length === 0) {
    return `✓ ${result.message ?? "No contradiction found."} (${result.decisionsChecked ?? 0} decisions checked)`;
  }
  const lines = result.flags.map((f, i) => {
    const pct = Math.round(f.confidence * 100);
    return (
      `${i + 1}. [${pct}% · ${f.kind}] ${f.reason}\n` +
      `   ↳ decision ${f.decisionId}: "${f.decisionTitle}"\n` +
      `   ↳ change evidence: ${f.changeEvidence}`
    );
  });
  return `⚠ ${result.message}\n\n${lines.join("\n\n")}`;
}
