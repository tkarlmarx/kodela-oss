// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_record_decision` MCP tool.
 *
 * Captures an architectural / security / business / compliance / operational /
 * deprecation decision as a first-class entity — separate from per-file code
 * annotations.
 *
 * MVP scope:
 *   - SQLite-only storage (decisions, decision_options, decision_links tables
 *     in .kodela/index.db).
 *   - JSON copy persisted at .kodela/decisions/{id}.json.
 *   - No semantic embeddings, no memory-graph edge writes, no approver-count
 *     enforcement per category. All deferred to Phase 2 (see
 *     the project design docs).
 */

import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  insertDecision,
  type DecisionLinkType,
  type RecordDecisionInput,
} from "../lib/decisions-store.js";
import { resolveDecisionDb, DECISION_DB_UNAVAILABLE } from "../lib/lazy-index.js";
import { resolveOrgId } from "../lib/org-id.js";

// ── Input schema ─────────────────────────────────────────────────────────────

const OptionSchema = z.object({
  label: z.string().min(1).describe("Short name for the option, e.g. 'Aurora'"),
  description: z
    .string()
    .min(1)
    .describe("What this option is and how it works"),
  pros: z.string().optional().describe("Why this option was attractive"),
  cons: z.string().optional().describe("Why this option was problematic"),
  was_chosen: z
    .boolean()
    .describe("Exactly one option per decision must be true"),
  rejection_reason: z
    .string()
    .optional()
    .describe("Required when was_chosen=false — why this option lost"),
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
  external_id: z
    .string()
    .min(1)
    .describe("Identifier in the source system (e.g. 'PLAT-1287')"),
  display_label: z
    .string()
    .optional()
    .describe("Friendly label to show in the UI"),
});

export const RecordDecisionInputSchema = z.object({
  org_id: z
    .string()
    .optional()
    .describe("Organization scope. Defaults to '_default' in MVP single-tenant mode."),

  repo_id: z
    .string()
    .optional()
    .describe("Optional: scope to a specific repository within the org"),

  title: z
    .string()
    .min(5, "title must be at least 5 chars")
    .max(150, "title must be at most 150 chars"),

  category: z.enum([
    "architecture",
    "security",
    "business",
    "compliance",
    "operational",
    "deprecation",
  ]),

  problem: z
    .string()
    .min(30, "problem must explain what you were trying to solve (min 30 chars)"),

  decision: z
    .string()
    .min(30, "decision must describe the choice made (min 30 chars)"),

  reason: z
    .string()
    .min(50, "reason must explain why this option won (min 50 chars)"),

  consequences: z
    .string()
    .optional()
    .describe("What this commits us to / what it precludes"),

  trade_offs: z
    .string()
    .optional()
    .describe("What we knowingly gave up"),

  options: z
    .array(OptionSchema)
    .min(2, "Must consider at least 2 options"),

  author_id: z
    .string()
    .min(1)
    .describe("User id (or email/handle) of the decision author"),

  approver_ids: z
    .array(z.string())
    .default([])
    .describe("User ids who approved. Empty array → status='proposed'."),

  tags: z.array(z.string()).default([]),

  visibility: z
    .enum(["public-to-org", "team-restricted", "restricted"])
    .default("public-to-org"),

  decided_at: z
    .string()
    .describe("ISO 8601 timestamp when the decision was made"),

  initial_links: z.array(LinkSchema).default([]),
});

export type RecordDecisionToolInput = z.infer<typeof RecordDecisionInputSchema>;

// ── Core function ────────────────────────────────────────────────────────────

export interface RecordDecisionResult {
  ok: boolean;
  decision_id?: string;
  status?: string;
  message?: string;
  error?: string;
}

export function recordDecision(
  repoRoot: string,
  input: RecordDecisionToolInput,
  db: DatabaseSync | null,
): RecordDecisionResult {
  // Lazy-open if the boot-time handle is null — see resolveDecisionDb().
  const handle = resolveDecisionDb(repoRoot, db, "record-decision");
  if (handle === null) {
    return { ok: false, error: DECISION_DB_UNAVAILABLE };
  }

  try {
    const storeInput: RecordDecisionInput = {
      // Resolve org at the tool boundary so the stored row carries an explicit
      // org_id (internal design note) rather than relying on a column default downstream.
      org_id: resolveOrgId(input.org_id),
      repo_id: input.repo_id,
      title: input.title,
      category: input.category,
      problem: input.problem,
      decision: input.decision,
      reason: input.reason,
      consequences: input.consequences,
      trade_offs: input.trade_offs,
      options: input.options.map((o: RecordDecisionToolInput["options"][number]) => ({
        label: o.label,
        description: o.description,
        pros: o.pros,
        cons: o.cons,
        was_chosen: o.was_chosen,
        rejection_reason: o.rejection_reason,
      })),
      author_id: input.author_id,
      approver_ids: input.approver_ids,
      tags: input.tags,
      visibility: input.visibility,
      decided_at: input.decided_at,
      initial_links: input.initial_links.map((l: RecordDecisionToolInput["initial_links"][number]) => ({
        link_type: l.link_type as DecisionLinkType,
        external_id: l.external_id,
        display_label: l.display_label,
      })),
    };

    const result = insertDecision(handle, repoRoot, storeInput);

    return {
      ok: true,
      decision_id: result.decision.id,
      status: result.decision.status,
      message:
        `Decision ${result.decision.id} recorded: "${result.decision.title}". ` +
        `Status: ${result.decision.status}. ` +
        `${result.options.length} option(s), ${result.links.length} link(s).`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Response formatter ───────────────────────────────────────────────────────

export function formatRecordDecisionResponse(result: RecordDecisionResult): string {
  if (!result.ok) {
    return JSON.stringify({ ok: false, error: result.error }, null, 2);
  }
  return JSON.stringify(
    {
      ok: true,
      decision_id: result.decision_id,
      status: result.status,
      message: result.message,
    },
    null,
    2,
  );
}
