// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import type { ContextEntry, KodelaSession } from "../schema/index.js";
import {
  readContextEntry,
  writeContextEntry,
  deleteContextEntry,
  readIndex,
  writeSession,
  readSession,
  listSessions,
} from "./storage.js";
import type {
  StorageBackend,
  WriteResult,
  FlushSessionResult,
  BackendMetrics,
} from "./backend.js";

export class LocalStorageBackend implements StorageBackend {
  readonly mode = "local" as const;

  private readonly startedAt = Date.now();

  async writeEntry(entry: ContextEntry): Promise<WriteResult> {
    const repoRoot = process.env.KODELA_REPO_ROOT ?? process.cwd();
    await writeContextEntry(repoRoot, entry);
    return { id: entry.id, stored: true, queued: false };
  }

  async readEntry(repoRoot: string, id: string): Promise<ContextEntry> {
    return readContextEntry(repoRoot, id);
  }

  async deleteEntry(repoRoot: string, id: string): Promise<void> {
    return deleteContextEntry(repoRoot, id);
  }

  async listEntryIds(repoRoot: string): Promise<string[]> {
    const index = await readIndex(repoRoot);
    return index.entries;
  }

  async flushSession(sessionId: string): Promise<FlushSessionResult> {
    return {
      sessionId,
      entriesFlushed: 0,
      errors: [],
    };
  }

  // P6.5 (internal design note) — session methods delegate to storage.ts's existing
  // filesystem helpers.  Keeping LocalBackend lean here means existing
  // storage.ts callers continue to work without going through the backend.
  async writeSession(session: KodelaSession, repoRoot: string): Promise<void> {
    return writeSession(repoRoot, session);
  }

  async readSession(sessionId: string, repoRoot: string): Promise<KodelaSession | null> {
    return readSession(repoRoot, sessionId);
  }

  async listSessions(repoRoot: string): Promise<KodelaSession[]> {
    return listSessions(repoRoot);
  }

  getMetrics(): BackendMetrics {
    return {
      mode: "local",
      queueDepth: 0,
      flushErrors: 0,
      lastFlushAt: null,
      uptimeMs: Date.now() - this.startedAt,
    };
  }
}
