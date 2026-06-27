// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_get_project_dna` MCP tool (07 §3.10) — the headline Project DNA.
 *
 * Returns a compressed, structured "identity" of the project (purpose, stack,
 * constraints, non-goals, recent decisions, and — critically — the list of
 * rejected alternatives) so an AI agent avoids project-rejected technologies
 * (doc 06 §15, the ≥90% gate). MVP is deterministic compute-on-read.
 *
 * Scope: `project` only in this MVP. `module`/`file` scopes require the doc-05
 * L2/L3 rollups (roadmap); they currently return project-level DNA with a note.
 */

import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { resolveDecisionDb, DECISION_DB_UNAVAILABLE } from "../lib/lazy-index.js";
import { resolveOrgId } from "../lib/org-id.js";
import { buildProjectDna, type DnaResult } from "../lib/project-dna.js";

export const GetProjectDnaInputSchema = z.object({
  org_id: z.string().optional(),
  repo_id: z.string().optional(),
  scope: z.enum(["project", "module", "file"]).default("project"),
  module_path: z.string().optional(),
  file_path: z.string().optional(),
  token_budget: z.number().int().positive().default(5000),
  include_decisions: z.boolean().default(true),
  include_recent_incidents: z.boolean().default(false),
  layer_min: z.enum(["L1", "L2", "L3", "L4"]).optional(),
  freshness_required: z.enum(["any", "7d", "24h"]).optional(),
});

export type GetProjectDnaToolInput = z.infer<typeof GetProjectDnaInputSchema>;

export interface GetProjectDnaResult {
  ok: boolean;
  dna?: DnaResult;
  error?: string;
}

export function getProjectDnaForMcp(
  repoRoot: string,
  input: GetProjectDnaToolInput,
  db: DatabaseSync | null,
): GetProjectDnaResult {
  const handle = resolveDecisionDb(repoRoot, db, "get-project-dna");
  if (handle === null) return { ok: false, error: DECISION_DB_UNAVAILABLE };

  try {
    const orgId = resolveOrgId(input.org_id);
    const dna = buildProjectDna(repoRoot, handle, {
      orgId,
      tokenBudget: input.token_budget,
      includeDecisions: input.include_decisions,
    });

    const warnings = [...(dna.meta.warnings ?? [])];
    if (input.scope !== "project") {
      warnings.push(`scope='${input.scope}' not yet supported (L2/L3 rollups are roadmap); returning project-level DNA.`);
    }
    if (input.layer_min) {
      warnings.push(`layer_min='${input.layer_min}' accepted but not enforced — only project-level (L4-equivalent) DNA is built in this MVP.`);
    }
    if (input.freshness_required && input.freshness_required !== "any") {
      warnings.push(`freshness_required='${input.freshness_required}' is always satisfied — DNA is computed on read (no caching/staleness yet).`);
    }
    if (warnings.length > 0) dna.meta.warnings = warnings;

    return { ok: true, dna };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function formatGetProjectDnaResponse(result: GetProjectDnaResult): string {
  if (!result.ok) return JSON.stringify({ ok: false, error: result.error }, null, 2);
  return JSON.stringify(
    {
      ok: true,
      type: "kodela.project_dna",
      version: "1.0",
      payload: result.dna?.payload,
      meta: result.dna?.meta,
    },
    null,
    2,
  );
}
