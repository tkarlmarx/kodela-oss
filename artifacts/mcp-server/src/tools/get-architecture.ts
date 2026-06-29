// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_get_architecture` MCP tool (07 §3.11) — Project DNA scoped to the
 * Technical block only.
 *
 * Seed-first (internal design note): the technical block comes from `.kodela/dna/project.json`
 * augmented with unambiguous facts (package manager, source modules). We do NOT
 * infer frameworks from dependencies. `detail_level` controls verbosity.
 */

import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { resolveDecisionDb, DECISION_DB_UNAVAILABLE } from "../lib/lazy-index.js";
import { resolveOrgId } from "../lib/org-id.js";
import { buildProjectDna } from "../lib/project-dna.js";

export const GetArchitectureInputSchema = z.object({
  org_id: z.string().optional(),
  repo_id: z.string().optional(),
  detail_level: z.enum(["pocket", "standard", "full"]).default("standard"),
});

export type GetArchitectureToolInput = z.infer<typeof GetArchitectureInputSchema>;

export interface GetArchitectureResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  confidence?: number;
  warnings?: string[];
  error?: string;
}

export function getArchitectureForMcp(
  repoRoot: string,
  input: GetArchitectureToolInput,
  db: DatabaseSync | null,
): GetArchitectureResult {
  const handle = resolveDecisionDb(repoRoot, db, "get-architecture");
  if (handle === null) return { ok: false, error: DECISION_DB_UNAVAILABLE };

  try {
    const orgId = resolveOrgId(input.org_id);
    const dna = buildProjectDna(repoRoot, handle, { orgId, tokenBudget: 10000, includeDecisions: false });
    const tech = dna.technical;

    // Pocket detail = just the shape of the system; standard/full = everything seeded.
    const payload =
      input.detail_level === "pocket"
        ? {
            architecture: tech.architecture,
            package_manager: tech.package_manager,
            modules: tech.modules,
          }
        : tech;

    return { ok: true, payload, confidence: dna.meta.confidence, warnings: dna.meta.warnings };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function formatGetArchitectureResponse(result: GetArchitectureResult): string {
  if (!result.ok) return JSON.stringify({ ok: false, error: result.error }, null, 2);
  return JSON.stringify(
    {
      ok: true,
      type: "kodela.architecture",
      version: "1.0",
      payload: result.payload,
      meta: { confidence: result.confidence, warnings: result.warnings },
    },
    null,
    2,
  );
}
