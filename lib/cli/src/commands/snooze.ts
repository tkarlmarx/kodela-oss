// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 20c — Scheduled reporting: snooze per-entry.
 *
 * Sets `snoozedUntil` on a ContextEntry so `kodela report` skips it until
 * the snooze expires.  Running `kodela snooze --clear <id>` removes the field.
 */

import { readIndex, readContextEntry, writeContextEntry } from "@kodela/core";

export type SnoozeOptions = {
  repoRoot: string;
  entryId: string;
  /** Number of days to snooze for (default 7). Ignored when `clear` is true. */
  days?: number;
  /** When true, clear an existing snooze rather than setting one. */
  clear?: boolean;
  /** Reference time; defaults to Date.now(). */
  now?: number;
};

export type SnoozeResult = {
  entryId: string;
  action: "snoozed" | "cleared";
  /** ISO-8601 string of when the snooze expires (absent when action is "cleared"). */
  snoozedUntil?: string;
};

export async function runSnooze(opts: SnoozeOptions): Promise<SnoozeResult> {
  const { repoRoot, entryId, days = 7, clear = false } = opts;
  const now = opts.now ?? Date.now();

  const index = await readIndex(repoRoot);
  if (!index.entries.includes(entryId)) {
    throw new Error(`Entry not found: ${entryId}`);
  }

  const entry = await readContextEntry(repoRoot, entryId);

  if (clear) {
    const updated = { ...entry, snoozedUntil: undefined, updatedAt: new Date(now).toISOString() };
    // Zod schema validates snoozedUntil when present; deleting it is fine.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (updated as any).snoozedUntil;
    await writeContextEntry(repoRoot, updated);
    return { entryId, action: "cleared" };
  }

  const snoozedUntil = new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
  const updated = { ...entry, snoozedUntil, updatedAt: new Date(now).toISOString() };
  await writeContextEntry(repoRoot, updated);
  return { entryId, action: "snoozed", snoozedUntil };
}

export function formatSnoozeResult(result: SnoozeResult): string {
  if (result.action === "cleared") {
    return `Kodela: snooze cleared for entry ${result.entryId}.`;
  }
  const until = result.snoozedUntil
    ? new Date(result.snoozedUntil).toDateString()
    : "unknown";
  return `Kodela: entry ${result.entryId} snoozed until ${until}.`;
}
