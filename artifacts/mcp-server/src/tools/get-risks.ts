// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_get_risks` MCP tool (07 §3.12).
 *
 * Surfaces project risks from two deterministic sources:
 *   - Entries: high/critical-severity or review-required changes (these fields
 *     are columnar in the SQLite index → no disk read needed), grouped by file.
 *   - Decisions: security / deprecation decisions become open_risk / tech_debt.
 *
 * `include_tech_debt` additionally does a CAPPED disk-walk over the already-small
 * high-severity candidate set to reclassify entries tagged 'tech-debt' (tags live
 * in the object JSON, not the index). The cap and any truncation are reported in
 * meta — never silent. Incident patterns are not produced yet (no incident store).
 */

import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { queryEntries, readContextEntry, type EntryRow } from "@kodela/core";
import { listDecisions } from "../lib/decisions-store.js";
import { outgoingEdges } from "../lib/graph-store.js";
import { resolveDecisionDb, DECISION_DB_UNAVAILABLE } from "../lib/lazy-index.js";
import { resolveOrgId } from "../lib/org-id.js";

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
/** Max entry objects read from disk for tech-debt tag classification. */
const TECH_DEBT_SCAN_CAP = 300;

export const GetRisksInputSchema = z.object({
  org_id: z.string().optional(),
  repo_id: z.string().optional(),
  severity_min: z.enum(["low", "medium", "high", "critical"]).optional(),
  include_tech_debt: z.boolean().default(true),
});

export type GetRisksToolInput = z.infer<typeof GetRisksInputSchema>;

interface RiskItem {
  kind: "open_risk" | "tech_debt" | "incident_pattern";
  id: string;
  title: string;
  severity: string;
  last_seen_at: string;
  linked_decisions: string[];
}

export interface GetRisksResult {
  ok: boolean;
  risks?: RiskItem[];
  meta?: { entries_scanned: number; scan_capped: boolean; notes: string[] };
  error?: string;
}

export async function getRisksForMcp(
  repoRoot: string,
  input: GetRisksToolInput,
  db: DatabaseSync | null,
): Promise<GetRisksResult> {
  const handle = resolveDecisionDb(repoRoot, db, "get-risks");
  if (handle === null) return { ok: false, error: DECISION_DB_UNAVAILABLE };

  const minRank = input.severity_min ? SEVERITY_RANK[input.severity_min] : 0;
  const notes: string[] = [];

  try {
    // ── Source 1: high-severity / review-required entries (columnar) ──────────
    const rows: EntryRow[] = queryEntries(handle, {}).filter(
      (r) => (SEVERITY_RANK[r.severity] ?? 0) >= 2 || r.reviewRequired,
    );
    // Group by file, keeping max severity + latest timestamp + the entry ids.
    const byFile = new Map<string, { sev: string; last: string; ids: string[] }>();
    for (const r of rows) {
      const g = byFile.get(r.filePath) ?? { sev: "low", last: r.updatedAt, ids: [] };
      if ((SEVERITY_RANK[r.severity] ?? 0) > (SEVERITY_RANK[g.sev] ?? 0)) g.sev = r.severity;
      if (r.updatedAt > g.last) g.last = r.updatedAt;
      g.ids.push(r.id);
      byFile.set(r.filePath, g);
    }

    // Optional capped disk-walk: reclassify files whose entries are tagged tech-debt.
    const techDebtFiles = new Set<string>();
    let entriesScanned = 0;
    let scanCapped = false;
    if (input.include_tech_debt) {
      const candidateIds = [...byFile.values()].flatMap((g) => g.ids);
      const toScan = candidateIds.slice(0, TECH_DEBT_SCAN_CAP);
      scanCapped = candidateIds.length > TECH_DEBT_SCAN_CAP;
      entriesScanned = toScan.length;
      for (const id of toScan) {
        try {
          const entry = await readContextEntry(repoRoot, id);
          if ((entry.tags ?? []).some((t) => /tech[-_ ]?debt|debt/i.test(t))) {
            techDebtFiles.add(entry.filePath);
          }
        } catch {
          // entry object missing — skip
        }
      }
      if (scanCapped) notes.push(`tech-debt tag scan capped at ${TECH_DEBT_SCAN_CAP} entries.`);
    }

    const risks: RiskItem[] = [];
    for (const [filePath, g] of byFile) {
      if ((SEVERITY_RANK[g.sev] ?? 0) < minRank) continue;
      const isDebt = techDebtFiles.has(filePath);
      // Decisions this file's changes implement (FILE_CHANGE —IMPLEMENTS→ DECISION).
      const linked = new Set<string>();
      for (const id of g.ids) {
        for (const e of outgoingEdges(handle, "FILE_CHANGE", id, { edgeTypes: ["IMPLEMENTS"] })) {
          linked.add(e.target_node_id);
        }
      }
      risks.push({
        kind: isDebt ? "tech_debt" : "open_risk",
        id: `file:${filePath}`,
        title: `${filePath} — ${g.ids.length} ${g.sev}-severity / review-required change(s)`,
        severity: g.sev,
        last_seen_at: g.last,
        linked_decisions: [...linked],
      });
    }

    // ── Source 2: security / deprecation decisions ────────────────────────────
    const orgId = resolveOrgId(input.org_id);
    for (const category of ["security", "deprecation"] as const) {
      for (const d of listDecisions(handle, { org_id: orgId, category, limit: 25 })) {
        if (d.status === "superseded" || d.status === "archived" || d.status === "rejected") continue;
        const severity = category === "security" ? "high" : "medium";
        if ((SEVERITY_RANK[severity] ?? 0) < minRank) continue;
        risks.push({
          kind: category === "deprecation" ? "tech_debt" : "open_risk",
          id: d.id,
          title: `${d.title} (${category} decision)`,
          severity,
          last_seen_at: d.decided_at,
          linked_decisions: [d.id],
        });
      }
    }

    risks.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));

    notes.push("incident_pattern risks are not produced yet (no incident store).");
    return { ok: true, risks, meta: { entries_scanned: entriesScanned, scan_capped: scanCapped, notes } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function formatGetRisksResponse(result: GetRisksResult): string {
  if (!result.ok) return JSON.stringify({ ok: false, error: result.error }, null, 2);
  return JSON.stringify(
    { ok: true, type: "kodela.risks", version: "1.0", risks: result.risks, meta: result.meta },
    null,
    2,
  );
}
