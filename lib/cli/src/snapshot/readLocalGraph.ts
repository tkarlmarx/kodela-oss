// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Read a repo's fused graph (decisions + options + links + currently-valid
 * edges) out of the local `.kodela/index.db`, in the wire shape the dashboard's
 * graph-ingest endpoint expects (parity PR #2). org_id / repo_id are NOT sent —
 * the server scopes every row to the authenticated org + the route's repoId.
 *
 * Open-core, read-only: a plain `node:sqlite` dump. Returns `null` whenever the
 * db, the graph tables, or any rows are absent (older repos, or repos whose
 * agents never recorded a decision) — the snapshot push then carries metrics
 * only, exactly as before.
 */
import path from "node:path";
import fs from "node:fs";

export interface LocalGraphPayload {
  decisions: Array<Record<string, unknown>>;
  decisionOptions: Array<Record<string, unknown>>;
  decisionLinks: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

function tableExists(db: import("node:sqlite").DatabaseSync, name: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

export async function readLocalGraph(repoRoot: string): Promise<LocalGraphPayload | null> {
  const dbPath = path.join(repoRoot, ".kodela", "index.db");
  if (!fs.existsSync(dbPath)) return null;

  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = (await import("node:sqlite")) as typeof import("node:sqlite"));
  } catch {
    return null; // node:sqlite unavailable (older Node) — degrade to metrics-only.
  }

  let db: import("node:sqlite").DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  try {
    if (!tableExists(db, "graph_edges") && !tableExists(db, "decisions")) return null;

    const decisions = tableExists(db, "decisions")
      ? (db
          .prepare(
            `SELECT id, title, category, status, visibility, problem, decision, reason,
                    consequences, trade_offs AS tradeOffs, outcome,
                    outcome_evidence AS outcomeEvidence, author_id AS authorId,
                    approver_ids AS approverIds, tags, superseded_by AS supersededBy,
                    supersedes, last_reviewed_at AS lastReviewedAt,
                    decided_at AS decidedAt, schema_version AS schemaVersion
               FROM decisions`,
          )
          .all() as Array<Record<string, unknown>>)
      : [];

    const decisionOptions = tableExists(db, "decision_options")
      ? (db
          .prepare(
            `SELECT id, decision_id AS decisionId, label, description, pros, cons,
                    was_chosen AS wasChosen, rejection_reason AS rejectionReason, position
               FROM decision_options`,
          )
          .all() as Array<Record<string, unknown>>)
      : [];

    const decisionLinks = tableExists(db, "decision_links")
      ? (db
          .prepare(
            `SELECT id, decision_id AS decisionId, link_type AS linkType,
                    external_id AS externalId, display_label AS displayLabel
               FROM decision_links`,
          )
          .all() as Array<Record<string, unknown>>)
      : [];

    // Only currently-valid edges travel (valid_until IS NULL or still in the
    // future). The server closes any edge it holds that this set omits.
    const nowIso = new Date().toISOString();
    const edgeRows = tableExists(db, "graph_edges")
      ? (db
          .prepare(
            `SELECT edge_type AS edgeType, source_node_type AS sourceNodeType,
                    source_node_id AS sourceNodeId, target_node_type AS targetNodeType,
                    target_node_id AS targetNodeId, metadata, confidence,
                    extracted_by AS extractedBy, capture_path AS capturePath,
                    valid_from AS validFrom, valid_until AS validUntil,
                    schema_version AS schemaVersion
               FROM graph_edges
              WHERE valid_from IS NOT NULL AND (valid_until IS NULL OR valid_until > ?)`,
          )
          .all(nowIso) as Array<Record<string, unknown>>)
      : [];

    const edges = edgeRows.map((e) => {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(String(e.metadata ?? "{}")) as Record<string, unknown>;
      } catch {
        metadata = {};
      }
      return { ...e, metadata, confidence: e.confidence == null ? undefined : Number(e.confidence) };
    });

    if (
      decisions.length === 0 &&
      decisionOptions.length === 0 &&
      decisionLinks.length === 0 &&
      edges.length === 0
    ) {
      return null;
    }

    return { decisions, decisionOptions, decisionLinks, edges };
  } catch {
    return null;
  } finally {
    db.close();
  }
}
