// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_supersede_decision` MCP tool — transactional supersede.
 *
 * Marks an existing decision `status='superseded'` and atomically creates a
 * new decision in its place, recording the supersedes/superseded_by link.
 *
 * Both writes commit together or both roll back. JSON copies for both
 * decisions are refreshed on disk.
 */

import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  supersedeDecision,
  type RecordDecisionInput,
  type DecisionLinkType,
  type SupersedeDecisionResult,
  type DecisionWithRelated,
} from "../lib/decisions-store.js";
import { resolveDecisionDb, DECISION_DB_UNAVAILABLE } from "../lib/lazy-index.js";
import { resolveOrgId } from "../lib/org-id.js";

const OptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().min(1),
  pros: z.string().optional(),
  cons: z.string().optional(),
  was_chosen: z.boolean(),
  rejection_reason: z.string().optional(),
});

const LinkSchema = z.object({
  link_type: z.enum([
    "ticket",
    "session",
    "entry",
    "pr",
    "commit",
    "incident",
    "adr",
    "document",
    "discussion",
  ]),
  external_id: z.string().min(1),
  display_label: z.string().optional(),
});

export const SupersedeDecisionInputSchema = z.object({
  old_decision_id: z.string().min(1).describe("Decision id to supersede, e.g. 'DEC-0001'"),

  // The new decision's fields (same shape as kodela_record_decision)
  new_decision: z.object({
    org_id: z.string().optional(),
    repo_id: z.string().optional(),
    title: z.string().min(5).max(150),
    category: z.enum([
      "architecture",
      "security",
      "business",
      "compliance",
      "operational",
      "deprecation",
    ]),
    problem: z.string().min(30),
    decision: z.string().min(30),
    reason: z.string().min(50),
    consequences: z.string().optional(),
    trade_offs: z.string().optional(),
    options: z.array(OptionSchema).min(2),
    author_id: z.string().min(1),
    approver_ids: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    visibility: z
      .enum(["public-to-org", "team-restricted", "restricted"])
      .default("public-to-org"),
    decided_at: z.string(),
    initial_links: z.array(LinkSchema).default([]),
  }),
});

export type SupersedeDecisionToolInput = z.infer<typeof SupersedeDecisionInputSchema>;

export interface SupersedeDecisionToolResult {
  ok: boolean;
  result?: SupersedeDecisionResult;
  new_decision?: DecisionWithRelated;
  message?: string;
  error?: string;
}

export function supersedeDecisionForMcp(
  repoRoot: string,
  input: SupersedeDecisionToolInput,
  db: DatabaseSync | null,
): SupersedeDecisionToolResult {
  const handle = resolveDecisionDb(repoRoot, db, "supersede-decision");
  if (handle === null) {
    return { ok: false, error: DECISION_DB_UNAVAILABLE };
  }
  try {
    const storeInput: RecordDecisionInput = {
      // Resolve org at the boundary so the replacement row carries an explicit
      // org_id (internal design note), matching kodela_record_decision.
      org_id: resolveOrgId(input.new_decision.org_id),
      repo_id: input.new_decision.repo_id,
      title: input.new_decision.title,
      category: input.new_decision.category,
      problem: input.new_decision.problem,
      decision: input.new_decision.decision,
      reason: input.new_decision.reason,
      consequences: input.new_decision.consequences,
      trade_offs: input.new_decision.trade_offs,
      options: input.new_decision.options.map(
        (o: SupersedeDecisionToolInput["new_decision"]["options"][number]) => ({
          label: o.label,
          description: o.description,
          pros: o.pros,
          cons: o.cons,
          was_chosen: o.was_chosen,
          rejection_reason: o.rejection_reason,
        }),
      ),
      author_id: input.new_decision.author_id,
      approver_ids: input.new_decision.approver_ids,
      tags: input.new_decision.tags,
      visibility: input.new_decision.visibility,
      decided_at: input.new_decision.decided_at,
      initial_links: input.new_decision.initial_links.map(
        (l: SupersedeDecisionToolInput["new_decision"]["initial_links"][number]) => ({
          link_type: l.link_type as DecisionLinkType,
          external_id: l.external_id,
          display_label: l.display_label,
        }),
      ),
    };

    const { result, newDecision } = supersedeDecision(
      handle,
      repoRoot,
      input.old_decision_id,
      storeInput,
    );
    return {
      ok: true,
      result,
      new_decision: newDecision,
      message:
        `Decision ${result.old_decision_id} superseded by ${result.new_decision_id}. ` +
        `New status: ${result.status_new}.`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatSupersedeDecisionResponse(r: SupersedeDecisionToolResult): string {
  if (!r.ok) {
    return JSON.stringify({ ok: false, error: r.error }, null, 2);
  }
  return JSON.stringify(
    {
      ok: true,
      type: "kodela.decision.supersede",
      version: "1.0",
      result: r.result,
      new_decision: r.new_decision?.decision,
      message: r.message,
    },
    null,
    2,
  );
}
