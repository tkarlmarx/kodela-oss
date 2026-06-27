// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

// node:sqlite is only available in Node 24+. We import it lazily inside
// openIndex() so the module can be loaded on Node 20 without crashing —
// it will only throw when you actually try to open a database.
type DatabaseSync = import("node:sqlite").DatabaseSync;
let DatabaseSyncClass: (new (path: string) => DatabaseSync) | null = null;

async function getDatabaseSync(): Promise<new (path: string) => DatabaseSync> {
  if (DatabaseSyncClass) return DatabaseSyncClass;
  try {
    const mod = await import("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
    DatabaseSyncClass = mod.DatabaseSync;
    return DatabaseSyncClass;
  } catch {
    throw new Error(
      "node:sqlite is not available in this Node.js version. " +
      "Upgrade to Node.js 24+ to use the SQLite index.",
    );
  }
}

// createRequire works in both CJS and ESM module modes. The original code
// used bare `require()` which throws "require is not defined in ES module
// scope" when this file is loaded by an ESM consumer (e.g. tsx serving the
// MCP server). That broke MCP boot openIndex AND the record-decision
// lazy-open retry path — both went through this function.
const requireFromHere = createRequire(import.meta.url);

function getDatabaseSyncSync(): new (path: string) => DatabaseSync {
  if (DatabaseSyncClass) return DatabaseSyncClass;
  const mod = requireFromHere("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
  DatabaseSyncClass = mod.DatabaseSync;
  return DatabaseSyncClass;
}

export interface EntryRow {
  id: string;
  filePath: string;
  schemaVersion: string;
  status: string;
  severity: string;
  source: string;
  confidence: number;
  scope: string | null;
  sessionId: string | null;
  clusterId: string | null;
  reviewRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ClusterRow {
  id: string;
  sessionId: string;
  clusterIndex: number;
  startedAt: string;
  endedAt: string | null;
  triggerType: string;
  goal: string | null;
  scope: string | null;
  eventCount: number;
  aggregatedRisk: string | null;
  filesChanged: string;
  version: number;
  parentId: string | null;
  supersededBy: string | null;
}

export interface SessionRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  model: string | null;
  clusterCount: number;
  totalFiles: number;
  aggregatedRisk: string | null;
  filesChanged: string;
}

export interface EmbeddingRow {
  entryId: string;
  vector: Buffer;
  model: string;
  embeddedAt: string;
}

export interface ExtractionQueueRow {
  id: string;
  clusterId: string;
  sessionId: string;
  queuedAt: string;
  status: string;
  attempt: number;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entries (
  id               TEXT PRIMARY KEY,
  file_path        TEXT NOT NULL,
  schema_version   TEXT NOT NULL,
  status           TEXT NOT NULL,
  severity         TEXT NOT NULL,
  source           TEXT NOT NULL,
  confidence       REAL NOT NULL,
  scope            TEXT,
  session_id       TEXT,
  cluster_id       TEXT,
  review_required  INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intent_clusters (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  cluster_index    INTEGER NOT NULL,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  trigger_type     TEXT NOT NULL,
  goal             TEXT,
  scope            TEXT,
  event_count      INTEGER NOT NULL DEFAULT 0,
  aggregated_risk  TEXT,
  files_changed    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  model            TEXT,
  cluster_count    INTEGER NOT NULL DEFAULT 0,
  total_files      INTEGER NOT NULL DEFAULT 0,
  aggregated_risk  TEXT,
  files_changed    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_entries (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  entry_id   TEXT NOT NULL REFERENCES entries(id),
  cluster_id TEXT NOT NULL REFERENCES intent_clusters(id),
  PRIMARY KEY (session_id, entry_id)
);

CREATE TABLE IF NOT EXISTS embeddings (
  entry_id     TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  vector       BLOB NOT NULL,
  model        TEXT NOT NULL,
  embedded_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extraction_queue (
  id           TEXT PRIMARY KEY,
  cluster_id   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  queued_at    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  attempt      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_entries_file     ON entries(file_path);
CREATE INDEX IF NOT EXISTS idx_entries_session  ON entries(session_id);
CREATE INDEX IF NOT EXISTS idx_entries_cluster  ON entries(cluster_id);
CREATE INDEX IF NOT EXISTS idx_clusters_session ON intent_clusters(session_id);
`;

const openDatabases = new Map<string, DatabaseSync>();

export function openIndex(dbPath: string): DatabaseSync {
  const existing = openDatabases.get(dbPath);
  if (existing) return existing;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const DB = getDatabaseSyncSync();
  const db = new DB(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);
  openDatabases.set(dbPath, db);
  return db;
}

export function initSchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
  const lineageMigrations = [
    "ALTER TABLE intent_clusters ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE intent_clusters ADD COLUMN parent_id TEXT",
    "ALTER TABLE intent_clusters ADD COLUMN superseded_by TEXT",
  ];
  for (const sql of lineageMigrations) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — safe to ignore
    }
  }
}

export function closeIndex(dbPath: string): void {
  const db = openDatabases.get(dbPath);
  if (db) {
    db.close();
    openDatabases.delete(dbPath);
  }
}

export function upsertEntry(db: DatabaseSync, entry: EntryRow): void {
  const stmt = db.prepare(`
    INSERT INTO entries (
      id, file_path, schema_version, status, severity, source,
      confidence, scope, session_id, cluster_id, review_required,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      file_path = excluded.file_path,
      schema_version = excluded.schema_version,
      status = excluded.status,
      severity = excluded.severity,
      source = excluded.source,
      confidence = excluded.confidence,
      scope = excluded.scope,
      session_id = excluded.session_id,
      cluster_id = excluded.cluster_id,
      review_required = excluded.review_required,
      updated_at = excluded.updated_at
  `);
  stmt.run(
    entry.id,
    entry.filePath,
    entry.schemaVersion,
    entry.status,
    entry.severity,
    entry.source,
    entry.confidence,
    entry.scope ?? null,
    entry.sessionId ?? null,
    entry.clusterId ?? null,
    entry.reviewRequired ? 1 : 0,
    entry.createdAt,
    entry.updatedAt,
  );
}

export function deleteEntry(db: DatabaseSync, id: string): void {
  db.prepare("DELETE FROM entries WHERE id = ?").run(id);
}

export function getEntryIds(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT id FROM entries").all() as { id: string }[];
  return rows.map((r) => r.id);
}

export function queryEntries(
  db: DatabaseSync,
  filter: Partial<{
    filePath: string;
    sessionId: string;
    clusterId: string;
    status: string;
    source: string;
  }>,
): EntryRow[] {
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (filter.filePath) {
    conditions.push("file_path = ?");
    params.push(filter.filePath);
  }
  if (filter.sessionId) {
    conditions.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.clusterId) {
    conditions.push("cluster_id = ?");
    params.push(filter.clusterId);
  }
  if (filter.status) {
    conditions.push("status = ?");
    params.push(filter.status);
  }
  if (filter.source) {
    conditions.push("source = ?");
    params.push(filter.source);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM entries ${where}`).all(...params) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: r.id as string,
    filePath: r.file_path as string,
    schemaVersion: r.schema_version as string,
    status: r.status as string,
    severity: r.severity as string,
    source: r.source as string,
    confidence: r.confidence as number,
    scope: r.scope as string | null,
    sessionId: r.session_id as string | null,
    clusterId: r.cluster_id as string | null,
    reviewRequired: r.review_required === 1,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}

export function upsertCluster(db: DatabaseSync, cluster: ClusterRow): void {
  const stmt = db.prepare(`
    INSERT INTO intent_clusters (
      id, session_id, cluster_index, started_at, ended_at,
      trigger_type, goal, scope, event_count, aggregated_risk, files_changed,
      version, parent_id, superseded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      ended_at = excluded.ended_at,
      event_count = excluded.event_count,
      aggregated_risk = excluded.aggregated_risk,
      files_changed = excluded.files_changed,
      scope = excluded.scope,
      version = excluded.version,
      superseded_by = excluded.superseded_by
  `);
  stmt.run(
    cluster.id,
    cluster.sessionId,
    cluster.clusterIndex,
    cluster.startedAt,
    cluster.endedAt ?? null,
    cluster.triggerType,
    cluster.goal ?? null,
    cluster.scope ?? null,
    cluster.eventCount,
    cluster.aggregatedRisk ?? null,
    cluster.filesChanged,
    cluster.version ?? 1,
    cluster.parentId ?? null,
    cluster.supersededBy ?? null,
  );
}

export function upsertSession(db: DatabaseSync, session: SessionRow): void {
  const stmt = db.prepare(`
    INSERT INTO sessions (
      id, started_at, ended_at, model, cluster_count,
      total_files, aggregated_risk, files_changed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      ended_at = excluded.ended_at,
      model = excluded.model,
      cluster_count = excluded.cluster_count,
      total_files = excluded.total_files,
      aggregated_risk = excluded.aggregated_risk,
      files_changed = excluded.files_changed
  `);
  stmt.run(
    session.id,
    session.startedAt,
    session.endedAt ?? null,
    session.model ?? null,
    session.clusterCount,
    session.totalFiles,
    session.aggregatedRisk ?? null,
    session.filesChanged,
  );
}

export function linkSessionEntry(
  db: DatabaseSync,
  sessionId: string,
  entryId: string,
  clusterId: string,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO session_entries (session_id, entry_id, cluster_id)
    VALUES (?, ?, ?)
  `).run(sessionId, entryId, clusterId);
}

export function upsertEmbedding(db: DatabaseSync, row: EmbeddingRow): void {
  db.prepare(`
    INSERT INTO embeddings (entry_id, vector, model, embedded_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      vector = excluded.vector,
      model = excluded.model,
      embedded_at = excluded.embedded_at
  `).run(row.entryId, row.vector, row.model, row.embeddedAt);
}

export function getEmbedding(db: DatabaseSync, entryId: string): EmbeddingRow | null {
  const row = db.prepare(
    "SELECT * FROM embeddings WHERE entry_id = ?",
  ).get(entryId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    entryId: row.entry_id as string,
    vector: row.vector as Buffer,
    model: row.model as string,
    embeddedAt: row.embedded_at as string,
  };
}

export function enqueueClusterExtraction(
  db: DatabaseSync,
  clusterId: string,
  sessionId: string,
): void {
  const existing = db.prepare(
    "SELECT id FROM extraction_queue WHERE cluster_id = ? AND status IN ('pending', 'processing')",
  ).get(clusterId);
  if (existing) return;

  db.prepare(`
    INSERT INTO extraction_queue (id, cluster_id, session_id, queued_at, status, attempt)
    VALUES (?, ?, ?, ?, 'pending', 0)
  `).run(randomUUID(), clusterId, sessionId, new Date().toISOString());
}

export function getPendingExtractionQueue(db: DatabaseSync): ExtractionQueueRow[] {
  const rows = db.prepare(
    "SELECT * FROM extraction_queue WHERE status = 'pending' ORDER BY queued_at ASC",
  ).all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    clusterId: r.cluster_id as string,
    sessionId: r.session_id as string,
    queuedAt: r.queued_at as string,
    status: r.status as string,
    attempt: r.attempt as number,
  }));
}

export function findEntryByClusterAndFile(
  db: DatabaseSync,
  clusterId: string,
  filePath: string,
): EntryRow | null {
  const row = db.prepare(
    "SELECT * FROM entries WHERE cluster_id = ? AND file_path = ?",
  ).get(clusterId, filePath) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    filePath: row.file_path as string,
    schemaVersion: row.schema_version as string,
    status: row.status as string,
    severity: row.severity as string,
    source: row.source as string,
    confidence: row.confidence as number,
    scope: row.scope as string | null,
    sessionId: row.session_id as string | null,
    clusterId: row.cluster_id as string | null,
    reviewRequired: row.review_required === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToClusterRow(r: Record<string, unknown>): ClusterRow {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    clusterIndex: r.cluster_index as number,
    startedAt: r.started_at as string,
    endedAt: r.ended_at as string | null,
    triggerType: r.trigger_type as string,
    goal: r.goal as string | null,
    scope: r.scope as string | null,
    eventCount: r.event_count as number,
    aggregatedRisk: r.aggregated_risk as string | null,
    filesChanged: r.files_changed as string,
    version: (r.version as number | undefined) ?? 1,
    parentId: r.parent_id as string | null,
    supersededBy: r.superseded_by as string | null,
  };
}

export function getCluster(db: DatabaseSync, id: string): ClusterRow | null {
  const row = db.prepare(
    "SELECT * FROM intent_clusters WHERE id = ?",
  ).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToClusterRow(row);
}

export function queryClusters(
  db: DatabaseSync,
  filter: Partial<{
    sessionId: string;
    filePath: string;
    scope: string;
    excludeSuperseded: boolean;
  }> = {},
): ClusterRow[] {
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (filter.sessionId) {
    conditions.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.scope) {
    conditions.push("scope = ?");
    params.push(filter.scope);
  }
  if (filter.excludeSuperseded) {
    conditions.push("superseded_by IS NULL");
  }
  if (filter.filePath) {
    conditions.push("files_changed LIKE ?");
    params.push(`%${filter.filePath}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT * FROM intent_clusters ${where} ORDER BY started_at DESC`,
  ).all(...params) as Record<string, unknown>[];
  return rows.map(rowToClusterRow);
}

export function getSession(db: DatabaseSync, id: string): SessionRow | null {
  const row = db.prepare(
    "SELECT * FROM sessions WHERE id = ?",
  ).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    startedAt: row.started_at as string,
    endedAt: row.ended_at as string | null,
    model: row.model as string | null,
    clusterCount: row.cluster_count as number,
    totalFiles: row.total_files as number,
    aggregatedRisk: row.aggregated_risk as string | null,
    filesChanged: row.files_changed as string,
  };
}
