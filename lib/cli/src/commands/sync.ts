// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import {
  readIndex,
  readContextEntry,
  loadLicense,
} from "@kodela/core";

export interface SyncOptions {
  repoRoot: string;
  serverUrl: string;
  apiKey: string;
  sessionId?: string;
  batchSize?: number;
  dryRun?: boolean;
}

export interface SyncResult {
  entriesFound: number;
  entriesSynced: number;
  entriesSkipped: number;
  errors: string[];
  dryRun: boolean;
}

async function syncBatch(
  entries: object[],
  sessionId: string,
  serverUrl: string,
  apiKey: string,
  orgId?: string,
): Promise<{ ok: boolean; error?: string }> {
  const payload = { sessionId, entries };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (orgId) {
    headers["X-Kodela-Org-Id"] = orgId;
  }
  const res = await fetch(`${serverUrl}/api/entries/session-batch`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown");
    return { ok: false, error: `HTTP ${res.status}: ${text}` };
  }

  return { ok: true };
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const {
    repoRoot,
    serverUrl,
    apiKey,
    sessionId,
    batchSize = 100,
    dryRun = false,
  } = opts;

  const license = await loadLicense(repoRoot);
  const orgId = license?.orgId;

  const index = await readIndex(repoRoot);
  const errors: string[] = [];
  let entriesSynced = 0;
  let entriesSkipped = 0;

  let ids = index.entries;

  const batchEntries: object[] = [];
  const batchSessionId = sessionId ?? `sync-${Date.now()}`;

  for (const id of ids) {
    let entry;
    try {
      entry = await readContextEntry(repoRoot, id);
    } catch (err) {
      errors.push(`Could not read entry ${id}: ${err instanceof Error ? err.message : String(err)}`);
      entriesSkipped += 1;
      continue;
    }

    if (sessionId && entry.sessionId !== sessionId) {
      entriesSkipped += 1;
      continue;
    }

    batchEntries.push(entry);

    if (batchEntries.length >= batchSize) {
      if (!dryRun) {
        const result = await syncBatch(batchEntries, batchSessionId, serverUrl, apiKey, orgId);
        if (!result.ok) {
          errors.push(result.error ?? "Unknown batch error");
        } else {
          entriesSynced += batchEntries.length;
        }
      } else {
        entriesSynced += batchEntries.length;
      }
      batchEntries.length = 0;
    }
  }

  if (batchEntries.length > 0) {
    if (!dryRun) {
      const result = await syncBatch(batchEntries, batchSessionId, serverUrl, apiKey, orgId);
      if (!result.ok) {
        errors.push(result.error ?? "Unknown batch error");
      } else {
        entriesSynced += batchEntries.length;
      }
    } else {
      entriesSynced += batchEntries.length;
    }
  }

  return {
    entriesFound: ids.length,
    entriesSynced,
    entriesSkipped,
    errors,
    dryRun,
  };
}

export function formatSyncResult(result: SyncResult): string {
  const lines: string[] = [];
  const mode = result.dryRun ? " (dry run)" : "";
  lines.push(`\nKodela Sync${mode}`);
  lines.push(`  Entries found:   ${result.entriesFound}`);
  lines.push(`  Entries synced:  ${result.entriesSynced}`);
  lines.push(`  Entries skipped: ${result.entriesSkipped}`);

  if (result.errors.length > 0) {
    lines.push(`  Errors (${result.errors.length}):`);
    for (const e of result.errors) {
      lines.push(`    - ${e}`);
    }
  }

  if (result.dryRun) {
    lines.push("\nRun without --dry-run to apply changes.");
  }

  return lines.join("\n");
}
