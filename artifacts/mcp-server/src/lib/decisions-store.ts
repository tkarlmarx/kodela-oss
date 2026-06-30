// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Decision Intelligence — storage layer (MVP).
 *
 * Owns three tables in the `.kodela/index.db` SQLite database:
 *   decisions          — primary decision rows
 *   decision_options   — alternatives considered (rejected + chosen)
 *   decision_links     — links to tickets, sessions, entries, PRs, etc.
 *
 * Also persists a human-readable JSON copy at `.kodela/decisions/{id}.json`
 * so decisions are grep-able and survive DB rebuilds (matching the
 * `.kodela/objects/` ContextEntry pattern).
 *
 * MVP scope: SQLite only. The Postgres adapter parity, the lib/db
 * `KodelaStorage` interface extension, and the dashboard read path
 * are deferred — see the project design docs
 */

import crypto from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { insertEdge, edgesForDecision, edgeForSupersede } from "./graph-store.js";

const DECISIONS_JSON_DIR = "decisions";
const SCHEMA_VERSION = "1.0.0" as const;
const DEFAULT_ORG = "_default" as const;

// ── DDL ─────────────────────────────────────────────────────────────────────

const DDL_DECISIONS = `
CREATE TABLE IF NOT EXISTS decisions (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL DEFAULT '_default',
  repo_id             TEXT,
  title               TEXT NOT NULL,
  category            TEXT NOT NULL CHECK (category IN ('architecture','security','business','compliance','operational','deprecation')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('proposed','active','superseded','archived','rejected')),
  visibility          TEXT NOT NULL DEFAULT 'public-to-org',
  problem             TEXT NOT NULL,
  decision            TEXT NOT NULL,
  reason              TEXT NOT NULL,
  consequences        TEXT,
  trade_offs          TEXT,
  outcome             TEXT,
  outcome_recorded_at TEXT,
  author_id           TEXT NOT NULL,
  approver_ids        TEXT NOT NULL DEFAULT '[]',
  tags                TEXT NOT NULL DEFAULT '[]',
  superseded_by       TEXT,
  supersedes          TEXT NOT NULL DEFAULT '[]',
  last_reviewed_at    TEXT NOT NULL,
  decided_at          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  schema_version      TEXT NOT NULL DEFAULT '1.0.0'
);
` as const;

const DDL_DECISIONS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS decisions_org_id_idx     ON decisions(org_id);",
  "CREATE INDEX IF NOT EXISTS decisions_category_idx   ON decisions(category);",
  "CREATE INDEX IF NOT EXISTS decisions_status_idx     ON decisions(status);",
  "CREATE INDEX IF NOT EXISTS decisions_decided_at_idx ON decisions(decided_at);",
] as const;

const DDL_DECISION_OPTIONS = `
CREATE TABLE IF NOT EXISTS decision_options (
  id              TEXT PRIMARY KEY,
  decision_id     TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  description     TEXT NOT NULL,
  pros            TEXT,
  cons            TEXT,
  was_chosen      INTEGER NOT NULL DEFAULT 0,
  rejection_reason TEXT,
  position        INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);
` as const;

const DDL_DECISION_OPTIONS_INDEX =
  "CREATE INDEX IF NOT EXISTS decision_options_decision_id_idx ON decision_options(decision_id);";

const DDL_DECISION_LINKS = `
CREATE TABLE IF NOT EXISTS decision_links (
  id              TEXT PRIMARY KEY,
  decision_id     TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  link_type       TEXT NOT NULL CHECK (link_type IN ('ticket','session','entry','pr','commit','incident','adr','document','discussion')),
  external_id     TEXT NOT NULL,
  display_label   TEXT,
  created_at      TEXT NOT NULL
);
` as const;

const DDL_DECISION_LINKS_INDEX =
  "CREATE INDEX IF NOT EXISTS decision_links_decision_id_idx ON decision_links(decision_id);";

export function ensureDecisionTables(db: DatabaseSync): void {
  db.exec(DDL_DECISIONS);
  for (const stmt of DDL_DECISIONS_INDEXES) db.exec(stmt);
  db.exec(DDL_DECISION_OPTIONS);
  db.exec(DDL_DECISION_OPTIONS_INDEX);
  db.exec(DDL_DECISION_LINKS);
  db.exec(DDL_DECISION_LINKS_INDEX);
  addColumnIfMissing(db, "decisions", "outcome_evidence", "TEXT NOT NULL DEFAULT '[]'");
}

/**
 * Idempotent ALTER TABLE ADD COLUMN — SQLite has no `ADD COLUMN IF NOT EXISTS`,
 * so guard against the column already existing via PRAGMA table_info. Lets the
 * decisions schema evolve in place across server upgrades without a rebuild.
 */
function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// ── Types ───────────────────────────────────────────────────────────────────

export type DecisionCategory =
  | "architecture"
  | "security"
  | "business"
  | "compliance"
  | "operational"
  | "deprecation";

export type DecisionStatus =
  | "proposed"
  | "active"
  | "superseded"
  | "archived"
  | "rejected";

export type DecisionVisibility =
  | "public-to-org"
  | "team-restricted"
  | "restricted";

export type DecisionLinkType =
  | "ticket"
  | "session"
  | "entry"
  | "pr"
  | "commit"
  | "incident"
  | "adr"
  | "document"
  | "discussion";

export interface DecisionOptionInput {
  label: string;
  description: string;
  pros?: string;
  cons?: string;
  was_chosen: boolean;
  rejection_reason?: string;
}

export interface DecisionLinkInput {
  link_type: DecisionLinkType;
  external_id: string;
  display_label?: string;
}

export interface RecordDecisionInput {
  org_id?: string;
  repo_id?: string;
  title: string;
  category: DecisionCategory;
  problem: string;
  decision: string;
  reason: string;
  consequences?: string;
  trade_offs?: string;
  options: DecisionOptionInput[];
  author_id: string;
  approver_ids?: string[];
  tags?: string[];
  visibility?: DecisionVisibility;
  decided_at: string;
  initial_links?: DecisionLinkInput[];
}

export interface DecisionRow {
  id: string;
  org_id: string;
  repo_id: string | null;
  title: string;
  category: DecisionCategory;
  status: DecisionStatus;
  visibility: DecisionVisibility;
  problem: string;
  decision: string;
  reason: string;
  consequences: string | null;
  trade_offs: string | null;
  outcome: string | null;
  outcome_recorded_at: string | null;
  outcome_evidence: DecisionEvidenceLink[];
  author_id: string;
  approver_ids: string[];
  tags: string[];
  superseded_by: string | null;
  supersedes: string[];
  last_reviewed_at: string;
  decided_at: string;
  created_at: string;
  updated_at: string;
  schema_version: string;
}

export interface DecisionOptionRow {
  id: string;
  decision_id: string;
  label: string;
  description: string;
  pros: string | null;
  cons: string | null;
  was_chosen: boolean;
  rejection_reason: string | null;
  position: number;
  created_at: string;
}

export interface DecisionLinkRow {
  id: string;
  decision_id: string;
  link_type: DecisionLinkType;
  external_id: string;
  display_label: string | null;
  created_at: string;
}

export interface DecisionWithRelated {
  decision: DecisionRow;
  options: DecisionOptionRow[];
  links: DecisionLinkRow[];
}

/** Evidence supporting a recorded decision outcome (07 §3.6). */
export interface DecisionEvidenceLink {
  kind: string;
  url: string;
  label?: string;
}

// ── ID generation ───────────────────────────────────────────────────────────

/**
 * Generate the next DEC-NNNN id for an org. Sequential per org.
 *
 * Format: `DEC-${4-or-more-digit-zero-padded-int}` (4 digits up to DEC-9999,
 * then expands naturally). Sequence is per-org so two orgs can both have DEC-0001.
 */
function nextDecisionId(db: DatabaseSync, orgId: string): string {
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(CAST(SUBSTR(id, 5) AS INTEGER)), 0) AS max_seq " +
      "FROM decisions WHERE org_id = ?",
    )
    .get(orgId) as { max_seq: number } | undefined;
  const next = (row?.max_seq ?? 0) + 1;
  return `DEC-${String(next).padStart(4, "0")}`;
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Throws if `options` violates the "≥2 options + exactly one chosen" rule. */
function validateOptions(options: DecisionOptionInput[]): void {
  if (options.length < 2) {
    throw new Error(
      "Decision must consider at least 2 options (a 'do nothing' counts).",
    );
  }
  const chosen = options.filter((o) => o.was_chosen);
  if (chosen.length !== 1) {
    throw new Error(
      `Decision must have exactly one option marked was_chosen=true (found ${chosen.length}).`,
    );
  }
  for (const o of options) {
    if (!o.was_chosen && !o.rejection_reason) {
      throw new Error(
        `Option "${o.label}" has was_chosen=false but no rejection_reason.`,
      );
    }
  }
}

// ── Insert ──────────────────────────────────────────────────────────────────

export function insertDecision(
  db: DatabaseSync,
  repoRoot: string,
  input: RecordDecisionInput,
): DecisionWithRelated {
  validateOptions(input.options);

  const orgId = input.org_id ?? DEFAULT_ORG;
  const id = nextDecisionId(db, orgId);
  const now = new Date().toISOString();

  const decisionRow: DecisionRow = {
    id,
    org_id: orgId,
    repo_id: input.repo_id ?? null,
    title: input.title,
    category: input.category,
    // MVP: skip approver-count enforcement → land as 'active' immediately when
    // any approver_ids supplied. Without approvers it stays 'proposed'.
    status: (input.approver_ids ?? []).length > 0 ? "active" : "proposed",
    visibility: input.visibility ?? "public-to-org",
    problem: input.problem,
    decision: input.decision,
    reason: input.reason,
    consequences: input.consequences ?? null,
    trade_offs: input.trade_offs ?? null,
    outcome: null,
    outcome_recorded_at: null,
    // INSERT omits this column → DB applies DEFAULT '[]'. Kept in the in-memory
    // row so the JSON copy and the DecisionRow type agree.
    outcome_evidence: [],
    author_id: input.author_id,
    approver_ids: input.approver_ids ?? [],
    tags: input.tags ?? [],
    superseded_by: null,
    supersedes: [],
    last_reviewed_at: now,
    decided_at: input.decided_at,
    created_at: now,
    updated_at: now,
    schema_version: SCHEMA_VERSION,
  };

  // ── Transaction: decision + options + links written atomically ───────────
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO decisions (
        id, org_id, repo_id, title, category, status, visibility,
        problem, decision, reason, consequences, trade_offs,
        outcome, outcome_recorded_at,
        author_id, approver_ids, tags,
        superseded_by, supersedes,
        last_reviewed_at, decided_at, created_at, updated_at, schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      decisionRow.id,
      decisionRow.org_id,
      decisionRow.repo_id,
      decisionRow.title,
      decisionRow.category,
      decisionRow.status,
      decisionRow.visibility,
      decisionRow.problem,
      decisionRow.decision,
      decisionRow.reason,
      decisionRow.consequences,
      decisionRow.trade_offs,
      decisionRow.outcome,
      decisionRow.outcome_recorded_at,
      decisionRow.author_id,
      JSON.stringify(decisionRow.approver_ids),
      JSON.stringify(decisionRow.tags),
      decisionRow.superseded_by,
      JSON.stringify(decisionRow.supersedes),
      decisionRow.last_reviewed_at,
      decisionRow.decided_at,
      decisionRow.created_at,
      decisionRow.updated_at,
      decisionRow.schema_version,
    );

    const optionRows: DecisionOptionRow[] = input.options.map((o, idx) => ({
      id: `${id}-OPT-${String(idx + 1).padStart(2, "0")}`,
      decision_id: id,
      label: o.label,
      description: o.description,
      pros: o.pros ?? null,
      cons: o.cons ?? null,
      was_chosen: o.was_chosen,
      rejection_reason: o.rejection_reason ?? null,
      position: idx,
      created_at: now,
    }));

    const insertOption = db.prepare(
      `INSERT INTO decision_options (
        id, decision_id, label, description, pros, cons, was_chosen,
        rejection_reason, position, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const o of optionRows) {
      insertOption.run(
        o.id,
        o.decision_id,
        o.label,
        o.description,
        o.pros,
        o.cons,
        o.was_chosen ? 1 : 0,
        o.rejection_reason,
        o.position,
        o.created_at,
      );
    }

    const linkRows: DecisionLinkRow[] = (input.initial_links ?? []).map((l) => ({
      id: crypto.randomUUID(),
      decision_id: id,
      link_type: l.link_type,
      external_id: l.external_id,
      display_label: l.display_label ?? null,
      created_at: now,
    }));

    if (linkRows.length > 0) {
      const insertLink = db.prepare(
        `INSERT INTO decision_links (
          id, decision_id, link_type, external_id, display_label, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const l of linkRows) {
        insertLink.run(
          l.id,
          l.decision_id,
          l.link_type,
          l.external_id,
          l.display_label,
          l.created_at,
        );
      }
    }

    // ── Memory-graph edges (internal design note) — same txn as the decision ──
    for (const edge of edgesForDecision({
      orgId: decisionRow.org_id,
      decisionId: id,
      authorId: input.author_id,
      approverIds: input.approver_ids,
      links: linkRows.map((l) => ({ link_type: l.link_type, external_id: l.external_id })),
    })) {
      insertEdge(db, edge, now);
    }

    db.exec("COMMIT");

    // ── Persist human-readable JSON copy (best-effort, post-commit) ────────
    persistDecisionJson(repoRoot, decisionRow, optionRows, linkRows);

    return { decision: decisionRow, options: optionRows, links: linkRows };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ── Read ────────────────────────────────────────────────────────────────────

export function getDecision(db: DatabaseSync, id: string): DecisionWithRelated | null {
  const raw = db
    .prepare("SELECT * FROM decisions WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!raw) return null;

  const decision = hydrateDecision(raw);

  const options = (
    db
      .prepare(
        "SELECT * FROM decision_options WHERE decision_id = ? ORDER BY position ASC",
      )
      .all(id) as Record<string, unknown>[]
  ).map(hydrateOption);

  const links = (
    db
      .prepare(
        "SELECT * FROM decision_links WHERE decision_id = ? ORDER BY created_at ASC",
      )
      .all(id) as Record<string, unknown>[]
  ).map(hydrateLink);

  return { decision, options, links };
}

/** A rejected option grouped across decisions — the "rejected technology / alternative" source. */
export interface RejectedAlternative {
  label: string;
  count: number;
  reasons: string[];
  decision_ids: string[];
}

/**
 * Rejected alternatives across all decisions (internal design note) — the engine of the
 * Project-DNA "avoid rejected technologies" gate. Pulls every losing option
 * (`was_chosen=0`), groups by lower-cased label, and keeps the rejection
 * reasons + the decisions that rejected it, ordered by how often it was rejected.
 */
export function listRejectedAlternatives(
  db: DatabaseSync,
  orgId?: string,
): RejectedAlternative[] {
  const params: string[] = [];
  let whereOrg = "";
  if (orgId) {
    whereOrg = "WHERE d.org_id = ?";
    params.push(orgId);
  }
  const rows = db
    .prepare(
      `SELECT o.label AS label, o.rejection_reason AS reason, o.decision_id AS decision_id
         FROM decision_options o
         JOIN decisions d ON d.id = o.decision_id
         ${whereOrg ? whereOrg + " AND" : "WHERE"} o.was_chosen = 0`,
    )
    .all(...params) as Array<{ label: string; reason: string | null; decision_id: string }>;

  const byLabel = new Map<string, RejectedAlternative>();
  for (const r of rows) {
    const key = r.label.trim().toLowerCase();
    if (!key) continue;
    let agg = byLabel.get(key);
    if (!agg) {
      agg = { label: r.label.trim(), count: 0, reasons: [], decision_ids: [] };
      byLabel.set(key, agg);
    }
    agg.count += 1;
    if (r.reason && !agg.reasons.includes(r.reason)) agg.reasons.push(r.reason);
    if (!agg.decision_ids.includes(r.decision_id)) agg.decision_ids.push(r.decision_id);
  }
  return [...byLabel.values()].sort((a, b) => b.count - a.count);
}

// ── Outcome ─────────────────────────────────────────────────────────────────

/**
 * Record the realized outcome of a decision (07 §3.6): what actually happened
 * after the decision shipped, plus optional evidence links. Sets `outcome`,
 * stamps `outcome_recorded_at`, stores `outcome_evidence` (JSON), and refreshes
 * the grep-able JSON copy. Does not change the decision's status.
 *
 * Throws if the decision does not exist.
 */
export function recordDecisionOutcome(
  db: DatabaseSync,
  repoRoot: string,
  decisionId: string,
  outcome: string,
  evidence: DecisionEvidenceLink[] = [],
): DecisionWithRelated {
  const exists = db
    .prepare("SELECT id FROM decisions WHERE id = ?")
    .get(decisionId) as { id: string } | undefined;
  if (!exists) {
    throw new Error(`Decision ${decisionId} not found.`);
  }

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE decisions SET outcome = ?, outcome_recorded_at = ?, " +
    "outcome_evidence = ?, updated_at = ? WHERE id = ?",
  ).run(outcome, now, JSON.stringify(evidence), now, decisionId);

  const updated = getDecision(db, decisionId);
  if (!updated) {
    // Should be unreachable — the row existed a statement ago.
    throw new Error(`Decision ${decisionId} vanished after outcome update.`);
  }
  persistDecisionJson(repoRoot, updated.decision, updated.options, updated.links);
  return updated;
}

export function listDecisions(
  db: DatabaseSync,
  filters: {
    org_id?: string;
    repo_id?: string;
    category?: DecisionCategory;
    status?: DecisionStatus;
    limit?: number;
  } = {},
): DecisionRow[] {
  type SqlParam = string | number;
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (filters.org_id) {
    where.push("org_id = ?");
    params.push(filters.org_id);
  }
  if (filters.repo_id) {
    where.push("repo_id = ?");
    params.push(filters.repo_id);
  }
  if (filters.category) {
    where.push("category = ?");
    params.push(filters.category);
  }
  if (filters.status) {
    where.push("status = ?");
    params.push(filters.status);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = filters.limit ?? 50;
  const rows = db
    .prepare(
      `SELECT * FROM decisions ${whereSql} ORDER BY decided_at DESC LIMIT ?`,
    )
    .all(...params, limit) as Record<string, unknown>[];
  return rows.map(hydrateDecision);
}

// ── Search ──────────────────────────────────────────────────────────────────

export interface SearchDecisionsFilters {
  org_id?: string;
  repo_id?: string;
  query?: string;
  category?: DecisionCategory;
  status?: DecisionStatus;
  tags?: string[];
  decided_after?: string;  // ISO 8601
  decided_before?: string; // ISO 8601
  limit?: number;
}

export interface SearchDecisionsResult {
  results: Array<{
    decision_id: string;
    title: string;
    category: DecisionCategory;
    status: DecisionStatus;
    snippet: string;
    decided_at: string;
    score: number;
  }>;
  total: number;
}

/**
 * Keyword search (MVP). Matches case-insensitive substring against
 * title + problem + decision + reason + tags.
 *
 * Semantic search via embeddings is deferred to Phase 2.
 */
export function searchDecisions(
  db: DatabaseSync,
  filters: SearchDecisionsFilters,
): SearchDecisionsResult {
  type SqlParam = string | number;
  const where: string[] = [];
  const params: SqlParam[] = [];

  if (filters.org_id) {
    where.push("org_id = ?");
    params.push(filters.org_id);
  }
  if (filters.repo_id) {
    where.push("repo_id = ?");
    params.push(filters.repo_id);
  }
  if (filters.category) {
    where.push("category = ?");
    params.push(filters.category);
  }
  if (filters.status) {
    where.push("status = ?");
    params.push(filters.status);
  }
  if (filters.decided_after) {
    where.push("decided_at >= ?");
    params.push(filters.decided_after);
  }
  if (filters.decided_before) {
    where.push("decided_at <= ?");
    params.push(filters.decided_before);
  }
  if (filters.query && filters.query.trim().length > 0) {
    const q = `%${filters.query.toLowerCase()}%`;
    where.push(
      "(LOWER(title) LIKE ? OR LOWER(problem) LIKE ? OR LOWER(decision) LIKE ? OR LOWER(reason) LIKE ? OR LOWER(tags) LIKE ?)",
    );
    params.push(q, q, q, q, q);
  }
  if (filters.tags && filters.tags.length > 0) {
    // SQLite-friendly tag match: tags is a JSON string; substring-match each tag.
    for (const t of filters.tags) {
      where.push("LOWER(tags) LIKE ?");
      params.push(`%"${t.toLowerCase()}"%`);
    }
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(filters.limit ?? 25, 200);

  const rows = db
    .prepare(
      `SELECT id, title, category, status, decided_at, problem, reason
       FROM decisions
       ${whereSql}
       ORDER BY decided_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<{
      id: string;
      title: string;
      category: string;
      status: string;
      decided_at: string;
      problem: string;
      reason: string;
    }>;

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM decisions ${whereSql}`)
    .get(...params) as { n: number };

  return {
    results: rows.map((r) => ({
      decision_id: r.id,
      title: r.title,
      category: r.category as DecisionCategory,
      status: r.status as DecisionStatus,
      snippet:
        r.reason.length > 200 ? r.reason.slice(0, 200) + "…" : r.reason,
      decided_at: r.decided_at,
      score: scoreMatch(filters.query, r.title, r.problem, r.reason),
    })),
    total: totalRow.n,
  };
}

/**
 * Tiny relevance score for keyword mode: count of occurrences in title × 3,
 * problem × 2, reason × 1. Returns 1.0 when no query (date-sorted listings).
 */
function scoreMatch(
  query: string | undefined,
  title: string,
  problem: string,
  reason: string,
): number {
  if (!query || query.trim().length === 0) return 1.0;
  const q = query.toLowerCase();
  const titleHits = countSubstr(title.toLowerCase(), q) * 3;
  const problemHits = countSubstr(problem.toLowerCase(), q) * 2;
  const reasonHits = countSubstr(reason.toLowerCase(), q);
  const raw = titleHits + problemHits + reasonHits;
  return Math.min(1.0, raw / 10);
}

function countSubstr(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

// ── Supersede ───────────────────────────────────────────────────────────────

export interface SupersedeDecisionResult {
  old_decision_id: string;
  new_decision_id: string;
  status_old: "superseded";
  status_new: "active" | "proposed";
}

/**
 * Transactional supersede:
 *   1. Mark the old decision status='superseded' and set superseded_by=newId.
 *   2. Create the new decision (via insertDecision logic) with supersedes=[oldId].
 *
 * Both writes commit together or both roll back. Both decision JSON files are
 * refreshed on disk.
 */
export function supersedeDecision(
  db: DatabaseSync,
  repoRoot: string,
  oldDecisionId: string,
  newDecisionInput: RecordDecisionInput,
): { result: SupersedeDecisionResult; newDecision: DecisionWithRelated } {
  const existing = db
    .prepare("SELECT * FROM decisions WHERE id = ?")
    .get(oldDecisionId) as Record<string, unknown> | undefined;

  if (!existing) {
    throw new Error(`Decision ${oldDecisionId} not found.`);
  }

  const oldStatus = String(existing.status);
  if (oldStatus === "superseded" || oldStatus === "archived" || oldStatus === "rejected") {
    throw new Error(
      `Decision ${oldDecisionId} cannot be superseded — current status is ${oldStatus}.`,
    );
  }

  // insertDecision opens its own BEGIN/COMMIT; we wrap the supersede edge in
  // a separate transaction immediately afterward so both writes are durable
  // before the JSON files are refreshed.
  const newDecision = insertDecision(db, repoRoot, newDecisionInput);

  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare(
      "UPDATE decisions SET status = ?, superseded_by = ?, updated_at = ? WHERE id = ?",
    ).run("superseded", newDecision.decision.id, now, oldDecisionId);

    // record supersedes on the new decision
    const supersedesArr = [...newDecision.decision.supersedes, oldDecisionId];
    db.prepare(
      "UPDATE decisions SET supersedes = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(supersedesArr), now, newDecision.decision.id);

    // DECISION —SUPERSEDES→ DECISION edge, same txn as the status flip.
    insertEdge(
      db,
      edgeForSupersede(oldDecisionId, newDecision.decision.id, newDecision.decision.org_id),
      now,
    );

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Refresh JSON copies for both decisions so disk view stays in sync.
  const oldRehydrated = getDecision(db, oldDecisionId);
  const newRehydrated = getDecision(db, newDecision.decision.id);
  if (oldRehydrated) {
    persistDecisionJson(repoRoot, oldRehydrated.decision, oldRehydrated.options, oldRehydrated.links);
  }
  if (newRehydrated) {
    persistDecisionJson(repoRoot, newRehydrated.decision, newRehydrated.options, newRehydrated.links);
  }

  return {
    result: {
      old_decision_id: oldDecisionId,
      new_decision_id: newDecision.decision.id,
      status_old: "superseded",
      status_new: newRehydrated?.decision.status === "active" ? "active" : "proposed",
    },
    newDecision: newRehydrated ?? newDecision,
  };
}

// ── Hydration helpers ───────────────────────────────────────────────────────

function hydrateDecision(raw: Record<string, unknown>): DecisionRow {
  return {
    id: String(raw.id),
    org_id: String(raw.org_id),
    repo_id: raw.repo_id == null ? null : String(raw.repo_id),
    title: String(raw.title),
    category: raw.category as DecisionCategory,
    status: raw.status as DecisionStatus,
    visibility: raw.visibility as DecisionVisibility,
    problem: String(raw.problem),
    decision: String(raw.decision),
    reason: String(raw.reason),
    consequences: raw.consequences == null ? null : String(raw.consequences),
    trade_offs: raw.trade_offs == null ? null : String(raw.trade_offs),
    outcome: raw.outcome == null ? null : String(raw.outcome),
    outcome_recorded_at:
      raw.outcome_recorded_at == null ? null : String(raw.outcome_recorded_at),
    outcome_evidence: parseEvidence(raw.outcome_evidence),
    author_id: String(raw.author_id),
    approver_ids: parseJsonArray(raw.approver_ids),
    tags: parseJsonArray(raw.tags),
    superseded_by: raw.superseded_by == null ? null : String(raw.superseded_by),
    supersedes: parseJsonArray(raw.supersedes),
    last_reviewed_at: String(raw.last_reviewed_at),
    decided_at: String(raw.decided_at),
    created_at: String(raw.created_at),
    updated_at: String(raw.updated_at),
    schema_version: String(raw.schema_version),
  };
}

function hydrateOption(raw: Record<string, unknown>): DecisionOptionRow {
  return {
    id: String(raw.id),
    decision_id: String(raw.decision_id),
    label: String(raw.label),
    description: String(raw.description),
    pros: raw.pros == null ? null : String(raw.pros),
    cons: raw.cons == null ? null : String(raw.cons),
    was_chosen: raw.was_chosen === 1 || raw.was_chosen === true,
    rejection_reason:
      raw.rejection_reason == null ? null : String(raw.rejection_reason),
    position: Number(raw.position),
    created_at: String(raw.created_at),
  };
}

function hydrateLink(raw: Record<string, unknown>): DecisionLinkRow {
  return {
    id: String(raw.id),
    decision_id: String(raw.decision_id),
    link_type: raw.link_type as DecisionLinkType,
    external_id: String(raw.external_id),
    display_label: raw.display_label == null ? null : String(raw.display_label),
    created_at: String(raw.created_at),
  };
}

function parseJsonArray(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseEvidence(v: unknown): DecisionEvidenceLink[] {
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is Record<string, unknown> => e != null && typeof e === "object")
      .map((e) => ({
        kind: String(e.kind ?? ""),
        url: String(e.url ?? ""),
        label: e.label == null ? undefined : String(e.label),
      }));
  } catch {
    return [];
  }
}

// ── JSON persistence (grep-able copy) ───────────────────────────────────────

function persistDecisionJson(
  repoRoot: string,
  decision: DecisionRow,
  options: DecisionOptionRow[],
  links: DecisionLinkRow[],
): void {
  const dir = path.join(repoRoot, ".kodela", DECISIONS_JSON_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, `${decision.id}.json`);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    decision,
    options,
    links,
  };
  writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}
