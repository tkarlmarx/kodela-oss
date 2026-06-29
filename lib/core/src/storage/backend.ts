// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import type { ContextEntry, KodelaSession } from "../schema/index.js";

export type WriteResult = {
  id: string;
  stored: boolean;
  queued: boolean;
};

export type FlushSessionResult = {
  sessionId: string;
  entriesFlushed: number;
  errors: string[];
};

export type StorageBackendMode = "local" | "central" | "saas";

export type BackendMetrics = {
  mode: StorageBackendMode;
  queueDepth: number;
  flushErrors: number;
  lastFlushAt: string | null;
  uptimeMs: number;
};

/**
 * P6.5 (internal design note) widened this interface with three session methods so SaaS
 * mode can serve dashboard queries without the api-server walking customer
 * filesystems.  LocalBackend + CentralBackend delegate to `storage.ts`'s
 * existing filesystem helpers; SqlBackend implements them natively against
 * the `sessions` Drizzle table.
 *
 * The interface intentionally does NOT widen for comments/signoffs/baselines
 * — those land in P6.5b after P6.6 row-filter audit ships.  Keeping P6.5's
 * surface narrow makes the audit tractable.
 */
export interface StorageBackend {
  readonly mode: StorageBackendMode;

  writeEntry(entry: ContextEntry): Promise<WriteResult>;

  readEntry(repoRoot: string, id: string): Promise<ContextEntry>;

  deleteEntry(repoRoot: string, id: string): Promise<void>;

  listEntryIds(repoRoot: string): Promise<string[]>;

  flushSession(
    sessionId: string,
    repoRoot: string,
  ): Promise<FlushSessionResult>;

  /**
   * Persist a KodelaSession record.  Local/Central back this with the
   * filesystem (`.kodela/sessions/<id>.json`); SaaS upserts into the
   * `sessions` SQL table.
   */
  writeSession(session: KodelaSession, repoRoot: string): Promise<void>;

  /**
   * Read a KodelaSession by id.  Returns `null` when not found (mirrors the
   * existing `storage.readSession` contract — does NOT throw on missing).
   */
  readSession(sessionId: string, repoRoot: string): Promise<KodelaSession | null>;

  /**
   * List all sessions visible to this backend's tenant context.  Order is
   * implementation-defined (Local: oldest first; SaaS: most-recent first via
   * an indexed `started_at DESC`).
   */
  listSessions(repoRoot: string): Promise<KodelaSession[]>;

  getMetrics(): BackendMetrics;
}
