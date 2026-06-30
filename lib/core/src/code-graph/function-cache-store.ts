// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Function-cache — Phase 4 of doc 23.
 *
 * Stores the {@link CodeGraphFunction}[] that the Tree-sitter dispatcher
 * emitted for `(file_path, content_hash)` so the graph API can answer
 * `?expandFile=<path>` in O(rows) instead of O(parse+wasm-init).
 *
 * Key invariant: the cache key is `(file_path, content_hash)`.  When a file's
 * content changes, the SHA-256 changes, the cache misses, the parser runs,
 * and a new row replaces the stale one via INSERT ... ON CONFLICT.  Old rows
 * for the same path with a different hash are NOT preserved — the cache is
 * a memoization, not a history; bitemporal edges already serve that role.
 *
 * Cohabits `.kodela/index.db` with graph_edges + decisions; same DatabaseSync
 * handle gets passed in.  No schema_version on rows because the cache is
 * disposable — a schema change just runs `DROP TABLE function_cache` and lets
 * the next parse repopulate.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CodeGraphFunction } from "./types.js";

const DDL_FUNCTION_CACHE = `
CREATE TABLE IF NOT EXISTS function_cache (
  file_path     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  functions     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (file_path, content_hash)
);
` as const;

const DDL_FUNCTION_CACHE_INDEXES = [
  "CREATE INDEX IF NOT EXISTS function_cache_file_idx ON function_cache(file_path);",
] as const;

/** Idempotent migration; safe to call on every MCP server boot. */
export function ensureFunctionCacheTables(db: DatabaseSync): void {
  db.exec(DDL_FUNCTION_CACHE);
  for (const stmt of DDL_FUNCTION_CACHE_INDEXES) db.exec(stmt);
}

/** Deterministic SHA-256 over the raw bytes of a source file. */
export function hashFileContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Cache hit returns the previously-parsed function list (decoded from JSON).
 * Cache miss returns `null` — the caller is expected to re-parse and then
 * call {@link writeCachedFunctions} with the new result.
 */
export function readCachedFunctions(
  db: DatabaseSync,
  filePath: string,
  contentHash: string,
): CodeGraphFunction[] | null {
  const row = db
    .prepare("SELECT functions FROM function_cache WHERE file_path = ? AND content_hash = ?")
    .get(filePath, contentHash) as { functions: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.functions);
    return Array.isArray(parsed) ? (parsed as CodeGraphFunction[]) : null;
  } catch {
    // A malformed row is treated as a miss — the caller will re-parse and
    // overwrite via the ON CONFLICT path below.
    return null;
  }
}

/**
 * Write the parsed function list under (filePath, contentHash).  Idempotent —
 * re-running on the same key is a no-op for the row contents (only created_at
 * refreshes via DO UPDATE).
 */
export function writeCachedFunctions(
  db: DatabaseSync,
  filePath: string,
  contentHash: string,
  functions: CodeGraphFunction[],
): void {
  const now = new Date().toISOString();
  const payload = JSON.stringify(functions);
  db.prepare(
    `INSERT INTO function_cache (file_path, content_hash, functions, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(file_path, content_hash) DO UPDATE SET
       functions = excluded.functions,
       created_at = excluded.created_at`,
  ).run(filePath, contentHash, payload, now);
}

/**
 * Garbage-collect cache rows for `filePath` whose hash is no longer the
 * current one.  Optional — bounded growth is acceptable in Phase 1; the API
 * route can call this opportunistically on hit-after-stale.
 */
export function invalidateOtherHashes(
  db: DatabaseSync,
  filePath: string,
  keepHash: string,
): number {
  const result = db
    .prepare("DELETE FROM function_cache WHERE file_path = ? AND content_hash != ?")
    .run(filePath, keepHash);
  return Number(result.changes ?? 0);
}

/** Row count — used by tests and the diagnostics dashboard. */
export function countCachedRows(db: DatabaseSync, filePath?: string): number {
  if (filePath) {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM function_cache WHERE file_path = ?")
      .get(filePath) as { n: number } | undefined;
    return row?.n ?? 0;
  }
  const row = db.prepare("SELECT COUNT(*) AS n FROM function_cache").get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}
