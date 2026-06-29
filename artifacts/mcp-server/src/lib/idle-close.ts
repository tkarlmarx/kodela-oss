// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Idle-session cleanup.
 *
 * Runs once at MCP server boot. Any session that:
 *   - has no `endedAt`
 *   - has not received an annotation or other state write within `maxIdleMs`
 *
 * gets auto-closed with `outcome: "abandoned"`. This prevents sessions from
 * piling up forever when the IDE crashes, the agent stops calling
 * `kodela_session_end`, or the developer simply walks away.
 *
 * The check is intentionally boot-time only in Sprint 1 / Pillar A. A
 * watcher-driven idle event loop is the right home for mid-session idle
 * detection (see the project design docs
 * §4 Pillar B).
 */

import { listSessions, readSession, writeSession } from "@kodela/core";
import { closeSession } from "@kodela/core/sessions";

export const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;

export interface IdleCloseResult {
  /** Sessions that were inspected (open at boot time). */
  inspected: number;
  /** Sessions that were closed because they exceeded the idle threshold. */
  closed: string[];
  /** Sessions that were left open (still within the threshold). */
  kept: string[];
}

/**
 * Determine the most recent activity timestamp for a session.
 *
 * Uses the latest of:
 *   - session.startedAt
 *   - max(filesChangedDetail[].lastUpdatedAt)
 *
 * Returns `0` if no timestamps can be parsed (treats as infinitely idle).
 */
function lastActivityMs(session: {
  startedAt: string;
  filesChangedDetail?: Array<{ lastUpdatedAt?: string }>;
}): number {
  const started = Date.parse(session.startedAt);
  let latest = Number.isFinite(started) ? started : 0;

  for (const detail of session.filesChangedDetail ?? []) {
    if (!detail.lastUpdatedAt) continue;
    const ts = Date.parse(detail.lastUpdatedAt);
    if (Number.isFinite(ts) && ts > latest) {
      latest = ts;
    }
  }

  return latest;
}

export async function closeIdleSessions(
  repoRoot: string,
  options?: {
    maxIdleMs?: number;
    now?: number;
    /** Optional session id to never auto-close (the actively bound session). */
    protectSessionId?: string;
  },
): Promise<IdleCloseResult> {
  const maxIdleMs = options?.maxIdleMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const now = options?.now ?? Date.now();
  const protectId = options?.protectSessionId;

  const sessions = await listSessions(repoRoot);
  const open = sessions.filter((s) => !s.endedAt);

  const closed: string[] = [];
  const kept: string[] = [];

  for (const session of open) {
    if (protectId && session.id === protectId) {
      kept.push(session.id);
      continue;
    }

    const activity = lastActivityMs(session);
    const idleMs = now - activity;

    if (idleMs < maxIdleMs) {
      kept.push(session.id);
      continue;
    }

    try {
      await closeSession(repoRoot, session.id);
      // Tag the outcome so downstream consumers can distinguish idle-abandon
      // from a normal explicit close.
      const after = await readSession(repoRoot, session.id);
      if (after) {
        await writeSession(repoRoot, {
          ...after,
          outcome: "abandoned",
          autoClosedReason: `idle ${Math.round(idleMs / 60_000)} min > ${Math.round(
            maxIdleMs / 60_000,
          )} min threshold`,
        } as typeof after & { outcome?: string; autoClosedReason?: string });
      }
      closed.push(session.id);
    } catch {
      // If the session is already mid-close from another process, just count it as kept.
      kept.push(session.id);
    }
  }

  return { inspected: open.length, closed, kept };
}
