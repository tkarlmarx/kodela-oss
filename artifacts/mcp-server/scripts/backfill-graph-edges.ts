// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * One-shot backfill: populate `graph_edges` from data that predates the
 * Phase-2 memory-graph ingestion.
 *
 * Live ingestion (annotate_file / record_decision / supersede) now writes edges
 * going forward, but everything recorded before the graph code shipped has none.
 * This derives the same edges the live paths would have written, from:
 *
 *   - decisions + decision_links  → USER—AUTHORED/APPROVED→DECISION,
 *                                    typed link edges, DECISION—SUPERSEDES→DECISION
 *   - session JSON (filesChangedDetail) → AI_SESSION—PRODUCED→FILE_CHANGE,
 *                                          FILE_CHANGE—ANNOTATED_BY→USER
 *
 * graph_edges is the source of truth for get_why / find_related_changes, so this
 * writes ALL derivable edges; the dashboard decides what to surface. Idempotent
 * (insertEdge ON CONFLICT), so re-running is safe.
 *
 * Usage:
 *   tsx scripts/backfill-graph-edges.ts            # dry run (prints summary)
 *   tsx scripts/backfill-graph-edges.ts --write    # persist
 */

import path from "node:path";
import { openIndex, listSessions, KODELA_DIR } from "@kodela/core";
import { ensureDecisionTables } from "../src/lib/decisions-store.js";
import {
  ensureGraphTables,
  insertEdge,
  edgesForDecision,
  edgeForSupersede,
  edgesForAnnotation,
  countEdges,
  type EdgeInput,
} from "../src/lib/graph-store.js";

const repoRoot = process.env.KODELA_REPO_ROOT ?? process.cwd();
const WRITE = process.argv.includes("--write");

function parseJsonArray(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const db = openIndex(path.join(repoRoot, KODELA_DIR, "index.db"));
  ensureDecisionTables(db);
  ensureGraphTables(db);

  const edges: EdgeInput[] = [];

  // ── Decisions: author/approver/links/supersede ─────────────────────────────
  const decisions = db
    .prepare("SELECT id, org_id, author_id, approver_ids, superseded_by FROM decisions")
    .all() as Array<{
      id: string;
      org_id: string;
      author_id: string;
      approver_ids: string;
      superseded_by: string | null;
    }>;

  for (const d of decisions) {
    const links = db
      .prepare("SELECT link_type, external_id FROM decision_links WHERE decision_id = ?")
      .all(d.id) as Array<{ link_type: string; external_id: string }>;
    edges.push(
      ...edgesForDecision({
        orgId: d.org_id,
        decisionId: d.id,
        authorId: d.author_id,
        approverIds: parseJsonArray(d.approver_ids),
        links,
      }),
    );
    if (d.superseded_by) {
      // d is superseded BY superseded_by → newer SUPERSEDES older(d).
      edges.push(edgeForSupersede(d.id, d.superseded_by, d.org_id));
    }
  }

  // ── Sessions: PRODUCED + ANNOTATED_BY from per-file annotation detail ───────
  const sessions = await listSessions(repoRoot);
  let sessionFileEdges = 0;
  for (const s of sessions) {
    for (const fc of s.filesChangedDetail ?? []) {
      const author = fc.modifiedBy?.author ?? null;
      const source = (fc.modifiedBy?.source ?? "ai") as "ai" | "human" | "mixed";
      for (const entryId of fc.entryIds ?? []) {
        const built = edgesForAnnotation({
          entryId,
          sessionId: s.id,
          author,
          actorSource: source,
          linkedDecisionIds: [],
        });
        edges.push(...built);
        sessionFileEdges += built.length;
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const byType = new Map<string, number>();
  for (const e of edges) byType.set(e.edge_type, (byType.get(e.edge_type) ?? 0) + 1);

  process.stdout.write(
    `\nBackfill summary (${WRITE ? "WRITE" : "DRY RUN"}):\n` +
    `  decisions scanned: ${decisions.length}\n` +
    `  sessions scanned:  ${sessions.length}\n` +
    `  edges derived:     ${edges.length} (session/file: ${sessionFileEdges})\n` +
    `  by type:\n` +
    [...byType.entries()].map(([t, n]) => `    ${t.padEnd(14)} ${n}`).join("\n") +
    `\n  graph_edges before: ${countEdges(db)}\n`,
  );

  if (!WRITE) {
    process.stdout.write("\n(dry run — re-run with --write to persist)\n");
    return;
  }

  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    for (const e of edges) insertEdge(db, e, now);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  process.stdout.write(`  graph_edges after:  ${countEdges(db)}\n`);
}

main().catch((err) => {
  process.stderr.write(`backfill-graph-edges failed: ${String(err)}\n`);
  process.exit(1);
});
