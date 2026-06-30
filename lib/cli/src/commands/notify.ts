// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 43 — Push-based alerting when annotations drift.
 *
 * Three capabilities:
 *
 *  1. Local notification — writes a drift event to .kodela/notifications.jsonl
 *     (polled by the VS Code extension) and prints a prominent [DRIFT ALERT]
 *     line to stderr for terminal visibility.
 *
 *  2. Deduplication — .kodela/notify-state.json stores the last-notified
 *     timestamp and status per entry.  The same event is suppressed within
 *     a configurable quiet period (default 24 h).  Severity escalations
 *     (uncertain → orphaned) bypass the quiet period and fire immediately.
 *
 *  3. Webhook delivery — POSTs a JSON drift payload to each URL listed in
 *     config.notify.webhooks[].  The optional `secret` field is sent as the
 *     X-Kodela-Secret header for receiver-side verification.
 *     Author-map look-up populates `slackUserId` in the payload so downstream
 *     Slack/GitHub routing can target the right person without PII in Kodela
 *     storage.
 *
 * Called from watch.ts after every heal cycle (Phase A).
 * Server-side snapshot webhook delivery lives in dashboard.ts (Phase B).
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  readContextEntry,
} from "@kodela/core";
import type { MappingDecision } from "./heal-engine.js";
import type { NotifyConfig } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTIFY_STATE_FILE = ".kodela/notify-state.json";
const NOTIFICATIONS_LOG = ".kodela/notifications.jsonl";
const DEFAULT_QUIET_HOURS = 24;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DriftLevel = "uncertain" | "orphaned";

/**
 * A single drift notification record written to .kodela/notifications.jsonl.
 * No annotation note content is included.
 */
export type DriftNotification = {
  entryId: string;
  filePath: string;
  /** Author field from the ContextEntry — used for routing. */
  author: string;
  previousStatus: string;
  newStatus: DriftLevel;
  timestamp: string;
  /**
   * Slack user ID resolved via config.notify.author_map.
   * Present only when the author has an entry in the map.
   */
  slackUserId?: string;
};

export type NotifyStateEntry = {
  /** ISO timestamp of the last notification for this entry. */
  lastNotifiedAt: string;
  /** The drift status that triggered the last notification. */
  notifiedStatus: DriftLevel;
};

/** Persisted in .kodela/notify-state.json — keyed by entryId. */
export type NotifyState = Record<string, NotifyStateEntry>;

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

export async function readNotifyState(repoRoot: string): Promise<NotifyState> {
  try {
    const raw = await fs.readFile(
      path.join(repoRoot, NOTIFY_STATE_FILE),
      "utf-8",
    );
    return JSON.parse(raw) as NotifyState;
  } catch {
    return {};
  }
}

export async function writeNotifyState(
  repoRoot: string,
  state: NotifyState,
): Promise<void> {
  const filePath = path.join(repoRoot, NOTIFY_STATE_FILE);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Returns true when a drift notification should fire for this entry.
 *
 * Rules:
 *  - If the entry has never been notified → always fire.
 *  - If the status escalated from "uncertain" to "orphaned" → fire immediately
 *    (ignores quiet period — severity escalation is always surfaced).
 *  - Otherwise → fire only when quietHours have elapsed since last notification.
 */
export function shouldNotify(
  entryId: string,
  newStatus: DriftLevel,
  state: NotifyState,
  quietHours: number,
): boolean {
  const prior = state[entryId];
  if (!prior) return true;

  if (prior.notifiedStatus === "uncertain" && newStatus === "orphaned") {
    return true;
  }

  const quietMs = quietHours * 60 * 60 * 1000;
  return Date.now() - new Date(prior.lastNotifiedAt).getTime() > quietMs;
}

// ---------------------------------------------------------------------------
// Local notification emission
// ---------------------------------------------------------------------------

/**
 * Writes the notification to .kodela/notifications.jsonl (VS Code extension
 * polls this file) and prints a [DRIFT ALERT] banner to stderr.
 */
export async function emitLocalNotification(
  notification: DriftNotification,
  repoRoot: string,
  stderr: NodeJS.WriteStream = process.stderr,
): Promise<void> {
  try {
    const logPath = path.join(repoRoot, NOTIFICATIONS_LOG);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(
      logPath,
      JSON.stringify(notification) + "\n",
      "utf-8",
    );
  } catch {
    // non-fatal — best-effort log append
  }

  const badge =
    notification.newStatus === "orphaned" ? "⚠ ORPHANED" : "⚡ UNCERTAIN";
  stderr.write(
    `[DRIFT ALERT] ${badge}: ${notification.filePath} ` +
      `(entry ${notification.entryId.slice(0, 8)}…, author: ${notification.author})\n` +
      `  Status changed: ${notification.previousStatus} → ${notification.newStatus}\n` +
      `  Run \`kodela heal\` to reattach or \`kodela archive\` to dismiss.\n`,
  );
}

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

export type WebhookPayload = {
  event: "drift";
  entryId: string;
  filePath: string;
  author: string;
  previousStatus: string;
  newStatus: DriftLevel;
  timestamp: string;
  slackUserId?: string;
};

/**
 * POSTs a drift notification payload to each configured webhook URL.
 * All errors are silently suppressed — webhook delivery is best-effort and
 * must never block or crash the watch loop.
 */
export async function deliverWebhooks(
  webhooks: Array<{ url: string; secret?: string }>,
  payload: WebhookPayload,
): Promise<void> {
  for (const wh of webhooks) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (wh.secret) {
        headers["X-Kodela-Secret"] = wh.secret;
      }
      void fetch(wh.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {
        // best-effort
      });
    } catch {
      // non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Processes mapping decisions from one heal cycle, detects drift transitions,
 * deduplicates via .kodela/notify-state.json, emits local notifications, and
 * delivers webhooks.
 *
 * Called from `handleBatch` in watch.ts after every heal cycle.
 * When `decisions` is undefined (collectDecisions was not enabled in the
 * heal engine) this function is a no-op.
 */
export async function processDriftNotifications(
  decisions: MappingDecision[] | undefined,
  repoRoot: string,
  notifyConfig: NotifyConfig | undefined,
  stderr: NodeJS.WriteStream = process.stderr,
): Promise<void> {
  if (!decisions || decisions.length === 0) return;

  // Only process entries that have landed in a drift state.
  const drifted = decisions.filter(
    (d) =>
      d.after.status === "uncertain" || d.after.status === "orphaned",
  );

  if (drifted.length === 0) return;

  const quietHours = notifyConfig?.quiet_hours ?? DEFAULT_QUIET_HOURS;
  const webhooks = notifyConfig?.webhooks ?? [];
  const authorMap = notifyConfig?.author_map ?? {};

  const state = await readNotifyState(repoRoot);
  const updatedState: NotifyState = { ...state };
  const now = new Date().toISOString();

  for (const decision of drifted) {
    const newStatus = decision.after.status as DriftLevel;

    if (!shouldNotify(decision.entryId, newStatus, state, quietHours)) {
      continue;
    }

    // Try to read the entry author for routing purposes.
    let author = "unknown";
    try {
      const entry = await readContextEntry(repoRoot, decision.entryId);
      author = entry.author;
    } catch {
      // Entry may already be orphaned and unreadable — fall back to "unknown"
    }

    const slackUserId = authorMap[author]?.slack_user_id;

    const notification: DriftNotification = {
      entryId: decision.entryId,
      filePath: decision.filePath,
      author,
      previousStatus: decision.before.status,
      newStatus,
      timestamp: now,
      ...(slackUserId !== undefined ? { slackUserId } : {}),
    };

    await emitLocalNotification(notification, repoRoot, stderr);

    if (webhooks.length > 0) {
      const payload: WebhookPayload = {
        event: "drift",
        entryId: decision.entryId,
        filePath: decision.filePath,
        author,
        previousStatus: decision.before.status,
        newStatus,
        timestamp: now,
        ...(slackUserId !== undefined ? { slackUserId } : {}),
      };
      void deliverWebhooks(webhooks, payload).catch(() => {});
    }

    updatedState[decision.entryId] = {
      lastNotifiedAt: now,
      notifiedStatus: newStatus,
    };
  }

  // Persist updated state only when something changed.
  if (JSON.stringify(updatedState) !== JSON.stringify(state)) {
    await writeNotifyState(repoRoot, updatedState);
  }
}
