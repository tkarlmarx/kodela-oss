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

export interface CentralBackendConfig {
  serverUrl: string;
  apiKey: string;
  flushIntervalMs?: number;
  maxQueueSize?: number;
}

interface QueuedEntry {
  entry: ContextEntry;
  repoRoot: string;
  queuedAt: number;
}

export class CentralStorageBackend implements StorageBackend {
  readonly mode = "central" as const;

  private readonly config: Required<CentralBackendConfig>;
  private readonly queue: QueuedEntry[] = [];
  private flushErrors = 0;
  private lastFlushAt: string | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt = Date.now();

  constructor(config: CentralBackendConfig) {
    this.config = {
      serverUrl: config.serverUrl,
      apiKey: config.apiKey,
      flushIntervalMs: config.flushIntervalMs ?? 30_000,
      maxQueueSize: config.maxQueueSize ?? 500,
    };

    this.flushTimer = setInterval(() => {
      this.drainQueue().catch(() => {
        this.flushErrors += 1;
      });
    }, this.config.flushIntervalMs);
  }

  async writeEntry(entry: ContextEntry): Promise<WriteResult> {
    const repoRoot = process.env.KODELA_REPO_ROOT ?? process.cwd();

    await writeContextEntry(repoRoot, entry);

    if (this.queue.length < this.config.maxQueueSize) {
      this.queue.push({ entry, repoRoot, queuedAt: Date.now() });
    }

    return { id: entry.id, stored: true, queued: true };
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

  async flushSession(
    sessionId: string,
    repoRoot: string,
  ): Promise<FlushSessionResult> {
    const sessionEntries = this.queue.filter(
      (q) => q.entry.sessionId === sessionId && q.repoRoot === repoRoot,
    );

    if (sessionEntries.length === 0) {
      return { sessionId, entriesFlushed: 0, errors: [] };
    }

    const result = await this.sendBatch(sessionEntries);

    if (result.errors.length === 0) {
      for (const item of sessionEntries) {
        const idx = this.queue.indexOf(item);
        if (idx !== -1) this.queue.splice(idx, 1);
      }
    }

    return result;
  }

  // P6.5 (internal design note) — session methods delegate to storage.ts.  Central
  // is write-through-to-server for entries but keeps the canonical session
  // record locally; the dashboard/SaaS path reads sessions from SqlBackend
  // server-side after they're flushed via the entry batch upload.
  async writeSession(session: KodelaSession, repoRoot: string): Promise<void> {
    return writeSession(repoRoot, session);
  }

  async readSession(sessionId: string, repoRoot: string): Promise<KodelaSession | null> {
    return readSession(repoRoot, sessionId);
  }

  async listSessions(repoRoot: string): Promise<KodelaSession[]> {
    return listSessions(repoRoot);
  }

  private async sendBatch(items: QueuedEntry[]): Promise<FlushSessionResult> {
    const sessionId = items[0]?.entry.sessionId ?? "unknown";
    const errors: string[] = [];

    try {
      const payload = {
        sessionId,
        entries: items.map((i) => i.entry),
      };

      const res = await fetch(`${this.config.serverUrl}/api/entries/session-batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "unknown error");
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      this.lastFlushAt = new Date().toISOString();
    } catch (err) {
      this.flushErrors += 1;
      errors.push(err instanceof Error ? err.message : String(err));
    }

    return {
      sessionId,
      entriesFlushed: errors.length === 0 ? items.length : 0,
      errors,
    };
  }

  private async drainQueue(): Promise<void> {
    if (this.queue.length === 0) return;

    const bySession = new Map<string, QueuedEntry[]>();
    for (const item of this.queue) {
      const sid = item.entry.sessionId ?? "__no_session__";
      const bucket = bySession.get(sid) ?? [];
      bucket.push(item);
      bySession.set(sid, bucket);
    }

    for (const [, items] of bySession) {
      const result = await this.sendBatch(items);
      if (result.errors.length === 0) {
        for (const item of items) {
          const idx = this.queue.indexOf(item);
          if (idx !== -1) this.queue.splice(idx, 1);
        }
      }
    }
  }

  stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  getMetrics(): BackendMetrics {
    return {
      mode: "central",
      queueDepth: this.queue.length,
      flushErrors: this.flushErrors,
      lastFlushAt: this.lastFlushAt,
      uptimeMs: Date.now() - this.startedAt,
    };
  }
}
