// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Shared lazy-open for the SQLite index used by the Decision Intelligence tools.
 *
 * The MCP server attempts `openIndex` once at boot (see index.ts main()). If
 * that fails — transient permissions, a missing dir, the sqlite native module
 * not loaded yet — the boot-time `db` handle stays null. Without a retry, every
 * decision tool returns "requires .kodela/index.db" for the rest of the process
 * lifetime, so a single failed boot permanently disables decision-intelligence
 * until restart.
 *
 * This helper retries the open and ensures the decision schema, so any decision
 * tool can self-heal on its next call. Historically only kodela_record_decision
 * carried this logic inline; it now lives here so all four decision tools share
 * the same recovery path (the boot warning in index.ts already promises this).
 */

import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openIndex, KODELA_DIR } from "@kodela/core";
import { ensureDecisionTables } from "./decisions-store.js";
import { ensureGraphTables } from "./graph-store.js";

/**
 * Return `db` when the boot-time handle is live; otherwise attempt a fresh
 * open of `.kodela/index.db` (ensuring decision tables) and return that. Returns
 * null only when the retry also fails — callers should surface a clear error.
 */
export function resolveDecisionDb(
  repoRoot: string,
  db: DatabaseSync | null,
  toolName: string,
): DatabaseSync | null {
  if (db !== null) return db;
  try {
    const dbPath = path.join(repoRoot, KODELA_DIR, "index.db");
    const handle = openIndex(dbPath);
    ensureDecisionTables(handle);
    ensureGraphTables(handle);
    return handle;
  } catch (err) {
    process.stderr.write(
      `[kodela-mcp] ${toolName} lazy-open failed: ${String(err)}\n`,
    );
    return null;
  }
}

/**
 * Standard error payload when both the boot handle and the lazy re-open failed.
 */
export const DECISION_DB_UNAVAILABLE =
  "Decision Intelligence could not open .kodela/index.db. " +
  "Check that node:sqlite is available (Node 24+) and that the .kodela " +
  "directory is writable. See stderr for the exact open error.";
