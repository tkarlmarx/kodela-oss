// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Memory Graph — edge storage layer (MVP).
 *
 * Owns one table in `.kodela/index.db`:
 *   graph_edges — directed, typed edges between nodes.
 *
 * Nodes are NOT stored separately (doc 04 §4): an edge endpoint is a typed
 * reference `(node_type, node_id)` into an existing row — e.g.
 * `('FILE_CHANGE', <entries.id>)`, `('DECISION', 'DEC-0007')`,
 * `('AI_SESSION', <session uuid>)`. A materialized nodes table is only worth it
 * past ~10M edges.
 *
 * Storage divergence from spec: doc 04 §4 specifies Postgres (recursive CTE,
 * jsonb, REFERENCES orgs). This repo's entire store is SQLite, so we mirror the
 * decisions-store pattern (same .kodela/index.db) and traverse with a bounded
 * iterative BFS in TypeScript rather than a recursive CTE — far easier to verify
 * at the hundreds-of-edges scale we have, and the CTE's payoff only shows at
 * Postgres/10M-edge scale.
 *
 * Every edge carries `capture_path` (doc 13 §9) and `extracted_by`/`confidence`
 * (doc 04 §3). MCP-authored edges are `capture_path='mcp'`, `extracted_by='rule'`,
 * `confidence=1.0`.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = "1.0.0" as const;
const DEFAULT_ORG = "_default" as const;

// ── Vocabulary (doc 04 §2/§3) ────────────────────────────────────────────────

export type GraphNodeType =
  | "USER"
  | "REQUIREMENT"
  | "TICKET"
  | "PROMPT"
  | "AI_SESSION"
  | "DECISION"
  | "FILE_CHANGE"
  | "COMMIT"
  | "PULL_REQUEST"
  | "APPROVAL"
  | "RELEASE"
  | "INCIDENT"
  | "DOCUMENT"
  | "DISCUSSION"
  | "ADR";

export type GraphEdgeType =
  | "AUTHORED"
  | "APPROVED"
  | "REVIEWED"
  | "OWNS"
  | "SPAWNED"
  | "MOTIVATES"
  | "DRIVES"
  | "REFERENCED_BY"
  | "STARTED"
  | "REFERENCES"
  | "PRODUCED"
  | "IMPLEMENTS"
  | "BELONGS_TO"
  | "ANNOTATED_BY"
  | "INCLUDED_IN"
  | "REVERTS"
  | "AUTHORED_BY"
  | "APPROVED_BY"
  | "GRANTED_BY"
  | "RELEASED_IN"
  | "DEPLOYED_BY"
  | "AFFECTED_BY"
  | "ROLLED_BACK_BY"
  | "CAUSED_BY"
  | "RESOLVED_BY"
  | "SUPERSEDES"
  | "LINKS_TO"
  | "CODIFIES"
  | "MENTIONS";

export type ExtractedBy = "rule" | "heuristic" | "llm" | "manual";
export type CapturePath =
  | "mcp"
  | "watcher.vscode"
  | "watcher.cli"
  | "watcher.jetbrains"
  | "watcher.browser"
  | "webhook"
  | "synthesis";

export interface EdgeInput {
  org_id?: string;
  edge_type: GraphEdgeType;
  source_node_type: GraphNodeType;
  source_node_id: string;
  target_node_type: GraphNodeType;
  target_node_id: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
  extracted_by?: ExtractedBy;
  capture_path?: CapturePath;
}

export interface EdgeRow {
  id: string;
  org_id: string;
  edge_type: GraphEdgeType;
  source_node_type: GraphNodeType;
  source_node_id: string;
  target_node_type: GraphNodeType;
  target_node_id: string;
  metadata: Record<string, unknown>;
  confidence: number;
  extracted_by: ExtractedBy;
  capture_path: CapturePath;
  created_at: string;
  /**
   * Phase 3 bitemporal: edge becomes valid at this instant. Defaults to
   * `created_at` on writes that omit it. Old rows backfilled from `created_at`.
   */
  valid_from: string;
  /**
   * When set, the edge stops being valid as of this instant. `null` means
   * 'still valid'. Set by {@link supersedeEdge} when a decision /
   * relationship is replaced — the row is preserved so historical queries
   * via {@link selectEdgesValidAt} keep working.
   */
  valid_until: string | null;
  schema_version: string;
}

// ── DDL ──────────────────────────────────────────────────────────────────────

const DDL_GRAPH_EDGES = `
CREATE TABLE IF NOT EXISTS graph_edges (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL DEFAULT '_default',
  edge_type         TEXT NOT NULL,
  source_node_type  TEXT NOT NULL,
  source_node_id    TEXT NOT NULL,
  target_node_type  TEXT NOT NULL,
  target_node_id    TEXT NOT NULL,
  metadata          TEXT NOT NULL DEFAULT '{}',
  confidence        REAL NOT NULL DEFAULT 1.0,
  extracted_by      TEXT NOT NULL DEFAULT 'rule',
  capture_path      TEXT NOT NULL DEFAULT 'mcp',
  created_at        TEXT NOT NULL,
  valid_from        TEXT,
  valid_until       TEXT,
  schema_version    TEXT NOT NULL DEFAULT '1.1.0'
);
` as const;

const DDL_GRAPH_EDGES_INDEXES = [
  "CREATE INDEX IF NOT EXISTS graph_edges_org_id_idx ON graph_edges(org_id);",
  "CREATE INDEX IF NOT EXISTS graph_edges_source_idx ON graph_edges(source_node_type, source_node_id);",
  "CREATE INDEX IF NOT EXISTS graph_edges_target_idx ON graph_edges(target_node_type, target_node_id);",
  "CREATE INDEX IF NOT EXISTS graph_edges_type_idx ON graph_edges(edge_type);",
  // Dedup key (doc 04 §4) — also the ON CONFLICT target for idempotent upserts.
  "CREATE UNIQUE INDEX IF NOT EXISTS graph_edges_unique_idx ON graph_edges(org_id, edge_type, source_node_type, source_node_id, target_node_type, target_node_id);",
  // Phase 3 — bitemporal queries (doc 23). asOf scans hit valid_from + valid_until in one index.
  "CREATE INDEX IF NOT EXISTS graph_edges_valid_idx ON graph_edges(valid_from, valid_until);",
] as const;

/**
 * Idempotent migration that ensures the graph_edges table exists and carries
 * the bitemporal columns added in Phase 3 of doc 23. Safe to run on:
 *
 *   1. A fresh database — the CREATE TABLE includes valid_from/valid_until.
 *   2. A pre-bitemporal database — the ALTER TABLEs add the columns; the
 *      UPDATE backfills valid_from = created_at so every legacy edge is
 *      treated as 'valid since it was first written, never invalidated'.
 *   3. An already-migrated database — every step is a no-op.
 *
 * SQLite's `ALTER TABLE … ADD COLUMN` throws when the column already exists,
 * so we wrap each ALTER in its own try/catch instead of using a pragma probe
 * (cheaper than two PRAGMA round-trips and equivalent in correctness).
 */
export function ensureGraphTables(db: DatabaseSync): void {
  db.exec(DDL_GRAPH_EDGES);

  // Phase 3 idempotent ALTERs — no-op on fresh installs (column exists),
  // additive on pre-bitemporal databases.
  try {
    db.exec("ALTER TABLE graph_edges ADD COLUMN valid_from TEXT");
  } catch {
    // Column already present — fresh install or already migrated.
  }
  try {
    db.exec("ALTER TABLE graph_edges ADD COLUMN valid_until TEXT");
  } catch {
    // Same.
  }

  // Backfill valid_from for any rows written before the migration. Idempotent:
  // the WHERE clause makes this a no-op on migrated rows.
  db.exec("UPDATE graph_edges SET valid_from = created_at WHERE valid_from IS NULL");

  for (const stmt of DDL_GRAPH_EDGES_INDEXES) db.exec(stmt);
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Idempotent edge insert. On the dedup key it keeps the highest confidence and
 * refreshes metadata — implementing doc 04 §7.3 reconciliation for free, and
 * making repeated `annotate_file` calls safe (they re-attempt the same edges).
 *
 * Phase 3 bitemporal: `valid_from = now` on first insert. The ON CONFLICT
 * UPDATE deliberately does NOT touch valid_from — re-asserting the same
 * relationship doesn't reset its validity window. It also clears valid_until
 * when a previously-superseded edge gets re-asserted (so a relationship that
 * was retired then re-validated is queryable as 'current' again).
 */
export function insertEdge(db: DatabaseSync, edge: EdgeInput, now: string): void {
  db.prepare(
    `INSERT INTO graph_edges (
       id, org_id, edge_type,
       source_node_type, source_node_id,
       target_node_type, target_node_id,
       metadata, confidence, extracted_by, capture_path,
       created_at, valid_from, valid_until, schema_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(org_id, edge_type, source_node_type, source_node_id, target_node_type, target_node_id)
     DO UPDATE SET
       confidence  = MAX(confidence, excluded.confidence),
       metadata    = excluded.metadata,
       valid_until = NULL`,
  ).run(
    crypto.randomUUID(),
    edge.org_id ?? DEFAULT_ORG,
    edge.edge_type,
    edge.source_node_type,
    edge.source_node_id,
    edge.target_node_type,
    edge.target_node_id,
    JSON.stringify(edge.metadata ?? {}),
    edge.confidence ?? 1.0,
    edge.extracted_by ?? "rule",
    edge.capture_path ?? "mcp",
    now,
    now,
    SCHEMA_VERSION,
  );
}

/**
 * Phase 3 — mark an edge as no longer valid as of `validUntil`. The row is
 * preserved on disk so historical bitemporal queries via
 * {@link selectEdgesValidAt} continue to return it for asOf < validUntil.
 *
 * Returns the number of rows updated (0 when the edge id was not found).
 */
export function supersedeEdge(
  db: DatabaseSync,
  edgeId: string,
  validUntil: string,
): number {
  const result = db
    .prepare(
      `UPDATE graph_edges SET valid_until = ?
       WHERE id = ? AND (valid_until IS NULL OR valid_until > ?)`,
    )
    .run(validUntil, edgeId, validUntil);
  return Number(result.changes ?? 0);
}

/**
 * Phase 3 — return every edge that was valid at `asOfIso`. An edge is valid
 * when `valid_from <= asOf AND (valid_until IS NULL OR valid_until > asOf)`.
 *
 * Both inputs are ISO-8601 strings to keep comparison lexicographic (which is
 * monotonic for the YYYY-MM-DDTHH:mm:ss.sssZ shape SQLite stores). Pass
 * `new Date().toISOString()` for "now"; the comparison handles the
 * still-valid-rows (`valid_until IS NULL`) branch in SQL so no client-side
 * filtering is needed.
 */
export function selectEdgesValidAt(
  db: DatabaseSync,
  asOfIso: string,
  opts: { orgId?: string; edgeTypes?: GraphEdgeType[] } = {},
): EdgeRow[] {
  const where: string[] = [
    "valid_from IS NOT NULL",
    "valid_from <= ?",
    "(valid_until IS NULL OR valid_until > ?)",
  ];
  const params: Array<string | number> = [asOfIso, asOfIso];
  if (opts.orgId) {
    where.push("org_id = ?");
    params.push(opts.orgId);
  }
  if (opts.edgeTypes && opts.edgeTypes.length > 0) {
    where.push(`edge_type IN (${opts.edgeTypes.map(() => "?").join(", ")})`);
    params.push(...opts.edgeTypes);
  }
  const rows = db
    .prepare(`SELECT * FROM graph_edges WHERE ${where.join(" AND ")}`)
    .all(...params) as Record<string, unknown>[];
  return rows.map(hydrateEdge);
}

/** Write a batch of edges in one transaction. Best-effort failures are not swallowed. */
export function insertEdges(db: DatabaseSync, edges: EdgeInput[], now: string): void {
  if (edges.length === 0) return;
  db.exec("BEGIN");
  try {
    for (const e of edges) insertEdge(db, e, now);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

function hydrateEdge(raw: Record<string, unknown>): EdgeRow {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(String(raw.metadata ?? "{}")) as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  return {
    id: String(raw.id),
    org_id: String(raw.org_id),
    edge_type: raw.edge_type as GraphEdgeType,
    source_node_type: raw.source_node_type as GraphNodeType,
    source_node_id: String(raw.source_node_id),
    target_node_type: raw.target_node_type as GraphNodeType,
    target_node_id: String(raw.target_node_id),
    metadata,
    confidence: Number(raw.confidence),
    extracted_by: raw.extracted_by as ExtractedBy,
    capture_path: raw.capture_path as CapturePath,
    created_at: String(raw.created_at),
    // Phase 3 bitemporal — present on every row after ensureGraphTables runs.
    // Defensive fallback to created_at handles the gap between the migration
    // and a subsequent UPDATE if a reader races with the backfill.
    valid_from: raw.valid_from != null ? String(raw.valid_from) : String(raw.created_at),
    valid_until: raw.valid_until != null ? String(raw.valid_until) : null,
    schema_version: String(raw.schema_version),
  };
}

/** Outgoing edges from a node, optionally filtered by edge type and min confidence. */
export function outgoingEdges(
  db: DatabaseSync,
  nodeType: GraphNodeType,
  nodeId: string,
  opts: { edgeTypes?: GraphEdgeType[]; minConfidence?: number } = {},
): EdgeRow[] {
  const where: string[] = ["source_node_type = ?", "source_node_id = ?"];
  const params: Array<string | number> = [nodeType, nodeId];
  if (opts.edgeTypes && opts.edgeTypes.length > 0) {
    where.push(`edge_type IN (${opts.edgeTypes.map(() => "?").join(", ")})`);
    params.push(...opts.edgeTypes);
  }
  if (opts.minConfidence != null) {
    where.push("confidence >= ?");
    params.push(opts.minConfidence);
  }
  const rows = db
    .prepare(`SELECT * FROM graph_edges WHERE ${where.join(" AND ")}`)
    .all(...params) as Record<string, unknown>[];
  return rows.map(hydrateEdge);
}

/** Incoming edges to a node (for undirected neighbor queries). */
export function incomingEdges(
  db: DatabaseSync,
  nodeType: GraphNodeType,
  nodeId: string,
  opts: { edgeTypes?: GraphEdgeType[]; minConfidence?: number } = {},
): EdgeRow[] {
  const where: string[] = ["target_node_type = ?", "target_node_id = ?"];
  const params: Array<string | number> = [nodeType, nodeId];
  if (opts.edgeTypes && opts.edgeTypes.length > 0) {
    where.push(`edge_type IN (${opts.edgeTypes.map(() => "?").join(", ")})`);
    params.push(...opts.edgeTypes);
  }
  if (opts.minConfidence != null) {
    where.push("confidence >= ?");
    params.push(opts.minConfidence);
  }
  const rows = db
    .prepare(`SELECT * FROM graph_edges WHERE ${where.join(" AND ")}`)
    .all(...params) as Record<string, unknown>[];
  return rows.map(hydrateEdge);
}

/** Count all edges (used by tests / diagnostics). */
export function countEdges(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM graph_edges").get() as { n: number };
  return row.n;
}

// ── Ingestion edge builders (doc 04 §5 paths) ───────────────────────────────
//
// Pure functions: build the EdgeInput[] for an event so each MCP tool stays
// thin. Callers persist with insertEdges(db, edges, now). All MCP-origin edges
// are extracted_by='rule', capture_path='mcp', confidence 1.0 (the defaults).

/** decision_links.link_type → graph edge (doc 04 path #9). */
const LINK_TYPE_EDGE: Record<
  string,
  { edge: GraphEdgeType; node: GraphNodeType; dir: "to-decision" | "from-decision" }
> = {
  // FILE_CHANGE/TICKET/INCIDENT point INTO the decision they motivate/implement.
  entry:      { edge: "IMPLEMENTS", node: "FILE_CHANGE", dir: "to-decision" },
  ticket:     { edge: "MOTIVATES",  node: "TICKET",      dir: "to-decision" },
  incident:   { edge: "MOTIVATES",  node: "INCIDENT",    dir: "to-decision" },
  session:    { edge: "IMPLEMENTS", node: "AI_SESSION",  dir: "to-decision" },
  commit:     { edge: "BELONGS_TO", node: "COMMIT",      dir: "to-decision" },
  pr:         { edge: "INCLUDED_IN", node: "PULL_REQUEST", dir: "to-decision" },
  // The decision points OUT to the documents/discussions it links to.
  adr:        { edge: "LINKS_TO", node: "ADR",        dir: "from-decision" },
  document:   { edge: "LINKS_TO", node: "DOCUMENT",   dir: "from-decision" },
  discussion: { edge: "LINKS_TO", node: "DISCUSSION", dir: "from-decision" },
};

/** Path #2 — kodela_annotate_file. */
export function edgesForAnnotation(input: {
  orgId?: string;
  entryId: string;
  sessionId?: string | null;
  author?: string | null;
  actorSource: "ai" | "human" | "mixed";
  linkedDecisionIds?: string[];
}): EdgeInput[] {
  const edges: EdgeInput[] = [];
  const org = input.orgId;
  if (input.sessionId) {
    edges.push({
      org_id: org,
      edge_type: "PRODUCED",
      source_node_type: "AI_SESSION",
      source_node_id: input.sessionId,
      target_node_type: "FILE_CHANGE",
      target_node_id: input.entryId,
    });
  }
  if (input.author) {
    // FILE_CHANGE —ANNOTATED_BY→ USER always; USER —AUTHORED→ FILE_CHANGE when human-written.
    edges.push({
      org_id: org,
      edge_type: "ANNOTATED_BY",
      source_node_type: "FILE_CHANGE",
      source_node_id: input.entryId,
      target_node_type: "USER",
      target_node_id: input.author,
    });
    if (input.actorSource === "human" || input.actorSource === "mixed") {
      edges.push({
        org_id: org,
        edge_type: "AUTHORED",
        source_node_type: "USER",
        source_node_id: input.author,
        target_node_type: "FILE_CHANGE",
        target_node_id: input.entryId,
      });
    }
  }
  for (const decId of input.linkedDecisionIds ?? []) {
    edges.push({
      org_id: org,
      edge_type: "IMPLEMENTS",
      source_node_type: "FILE_CHANGE",
      source_node_id: input.entryId,
      target_node_type: "DECISION",
      target_node_id: decId,
    });
  }
  return edges;
}

/** Paths #8 + #9 — kodela_record_decision (author/approvers + typed links). */
export function edgesForDecision(input: {
  orgId?: string;
  decisionId: string;
  authorId: string;
  approverIds?: string[];
  links?: Array<{ link_type: string; external_id: string }>;
}): EdgeInput[] {
  const org = input.orgId;
  const edges: EdgeInput[] = [
    {
      org_id: org,
      edge_type: "AUTHORED",
      source_node_type: "USER",
      source_node_id: input.authorId,
      target_node_type: "DECISION",
      target_node_id: input.decisionId,
    },
  ];
  for (const approver of input.approverIds ?? []) {
    edges.push({
      org_id: org,
      edge_type: "APPROVED",
      source_node_type: "USER",
      source_node_id: approver,
      target_node_type: "DECISION",
      target_node_id: input.decisionId,
    });
  }
  for (const link of input.links ?? []) {
    const m = LINK_TYPE_EDGE[link.link_type];
    if (!m) continue;
    if (m.dir === "to-decision") {
      edges.push({
        org_id: org,
        edge_type: m.edge,
        source_node_type: m.node,
        source_node_id: link.external_id,
        target_node_type: "DECISION",
        target_node_id: input.decisionId,
      });
    } else {
      edges.push({
        org_id: org,
        edge_type: m.edge,
        source_node_type: "DECISION",
        source_node_id: input.decisionId,
        target_node_type: m.node,
        target_node_id: link.external_id,
      });
    }
  }
  return edges;
}

/** kodela_supersede_decision — DECISION —SUPERSEDES→ DECISION. */
export function edgeForSupersede(
  oldDecisionId: string,
  newDecisionId: string,
  orgId?: string,
): EdgeInput {
  return {
    org_id: orgId,
    edge_type: "SUPERSEDES",
    source_node_type: "DECISION",
    source_node_id: newDecisionId,
    target_node_type: "DECISION",
    target_node_id: oldDecisionId,
  };
}
