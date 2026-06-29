// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Synthesis queue — durable, file-backed.
 *
 * Phase 2 of the project design docs
 *
 * Each event is one (sessionId, filePath) the worker should synthesize a
 * `why_changed / problem_solved / ai_reasoning` triple for. Events live as
 * single JSON files under `.kodela/synthesis-queue/`:
 *
 *   .kodela/synthesis-queue/
 *     ├── pending/<event-id>.json     ← waiting to be picked up
 *     ├── inflight/<event-id>.json    ← lease held by a worker
 *     ├── done/<event-id>.json        ← completed (retained for idempotency)
 *     └── failed/<event-id>.json      ← exhausted retries, surfaced for review
 *
 * The four-directory layout keeps `listPending()` a simple `readdir` and
 * gives the worker an atomic claim via `rename(pending → inflight)`. No
 * external queue dep — works on any filesystem with rename atomicity
 * (ext4, APFS, NTFS).
 *
 * Idempotency:
 *   - Event id is `sha256(sessionId + ":" + filePath)` so the SAME un-annotated
 *     file in the SAME session is always the same event id.
 *   - `enqueueSynthesisEvent()` is a no-op when the id already exists in any
 *     of the four directories.
 *   - `completeSynthesisEvent()` moves the inflight event to `done/` and
 *     persists the synthesized entry id alongside for later lookup.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

const QUEUE_DIR = ".kodela/synthesis-queue";
const PENDING_SUBDIR = "pending";
const INFLIGHT_SUBDIR = "inflight";
const DONE_SUBDIR = "done";
const FAILED_SUBDIR = "failed";

// ── Schemas ──────────────────────────────────────────────────────────────────

export const SynthesisEventSchema = z.object({
  /** Deterministic id derived from sha256(sessionId:filePath) — see eventIdFor. */
  id: z.string(),
  /** Session that surfaced the un-annotated file. */
  sessionId: z.string(),
  /** Repo-relative file path the worker should synthesize for. */
  filePath: z.string(),
  /** When the session ended — drives the freshness check on the worker side. */
  enqueuedAt: z.string().datetime(),
  /** Optional commit context. */
  commitSha: z.string().optional(),
  /** Number of retries (0 on first enqueue). */
  attempts: z.number().int().min(0).default(0),
  /** Last error message when retried. */
  lastError: z.string().optional(),
  /** Worker that holds the lease, when inflight. */
  leaseOwner: z.string().optional(),
  /** Lease expiry timestamp (ISO). */
  leaseUntil: z.string().datetime().optional(),
});

export type SynthesisEvent = z.infer<typeof SynthesisEventSchema>;

export const CompletedEventSchema = SynthesisEventSchema.extend({
  /** ContextEntry id the worker wrote. */
  resultEntryId: z.string(),
  /** Prompt template version used. */
  synthesisTemplateVersion: z.string(),
  /** Model id the worker called. */
  model: z.string(),
  /** Total tokens charged (input + output) — for telemetry. */
  tokens: z.number().int().min(0).optional(),
  /** Time the synthesis finished. */
  completedAt: z.string().datetime(),
});

export type CompletedEvent = z.infer<typeof CompletedEventSchema>;

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Deterministic event id — sha256(sessionId:filePath) truncated to 16 hex chars.
 * The same un-annotated file in the same session is always the same id, so
 * re-enqueuing is a cheap no-op (no duplicate work and no race window).
 */
export function eventIdFor(sessionId: string, filePath: string): string {
  return createHash("sha256")
    .update(`${sessionId}:${filePath}`)
    .digest("hex")
    .slice(0, 16);
}

function queueRoot(repoRoot: string): string {
  return path.join(repoRoot, QUEUE_DIR);
}

function pathsFor(repoRoot: string, id: string): {
  pending: string;
  inflight: string;
  done: string;
  failed: string;
} {
  const root = queueRoot(repoRoot);
  return {
    pending:  path.join(root, PENDING_SUBDIR,  `${id}.json`),
    inflight: path.join(root, INFLIGHT_SUBDIR, `${id}.json`),
    done:     path.join(root, DONE_SUBDIR,     `${id}.json`),
    failed:   path.join(root, FAILED_SUBDIR,   `${id}.json`),
  };
}

function ensureQueueDirs(repoRoot: string): void {
  const root = queueRoot(repoRoot);
  for (const sub of [PENDING_SUBDIR, INFLIGHT_SUBDIR, DONE_SUBDIR, FAILED_SUBDIR]) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
}

function eventExistsAnywhere(repoRoot: string, id: string): boolean {
  const p = pathsFor(repoRoot, id);
  return fs.existsSync(p.pending)
      || fs.existsSync(p.inflight)
      || fs.existsSync(p.done)
      || fs.existsSync(p.failed);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueue one synthesis event. Idempotent — if an event with the same id
 * already exists in any directory, this is a no-op and returns `false`.
 *
 * Returns `true` when a new event was written to `pending/`.
 */
export function enqueueSynthesisEvent(
  repoRoot: string,
  input: {
    sessionId: string;
    filePath: string;
    commitSha?: string;
  },
): { enqueued: boolean; id: string; eventPath: string } {
  ensureQueueDirs(repoRoot);
  const id = eventIdFor(input.sessionId, input.filePath);
  const paths = pathsFor(repoRoot, id);

  if (eventExistsAnywhere(repoRoot, id)) {
    return { enqueued: false, id, eventPath: paths.pending };
  }

  const event: SynthesisEvent = {
    id,
    sessionId: input.sessionId,
    filePath: input.filePath,
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
  };

  // Atomic write: write to a tmp file in the same directory and rename. This
  // protects a concurrent `listPending()` from observing a half-written file.
  const tmp = `${paths.pending}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(event, null, 2), "utf8");
  fs.renameSync(tmp, paths.pending);

  return { enqueued: true, id, eventPath: paths.pending };
}

/**
 * List all pending events, ordered by enqueuedAt ascending (oldest first).
 * Quietly skips entries that fail to parse.
 */
export function listPendingEvents(repoRoot: string): SynthesisEvent[] {
  const dir = path.join(queueRoot(repoRoot), PENDING_SUBDIR);
  if (!fs.existsSync(dir)) return [];

  const events: SynthesisEvent[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), "utf8");
      const parsed = SynthesisEventSchema.parse(JSON.parse(raw));
      events.push(parsed);
    } catch {
      // Skip — the worker will surface the read error in its own loop on the
      // next iteration when it tries to claim this id directly.
    }
  }
  return events.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
}

/**
 * Atomically claim a pending event by renaming it into `inflight/`. Returns
 * the event when claimed, `null` if another worker beat us to it (the
 * rename will fail). Stamps a lease with the owner string and an expiry
 * `leaseSeconds` ahead so a stuck worker doesn't block the queue.
 */
export function claimPendingEvent(
  repoRoot: string,
  id: string,
  options?: { leaseOwner?: string; leaseSeconds?: number },
): SynthesisEvent | null {
  const paths = pathsFor(repoRoot, id);
  if (!fs.existsSync(paths.pending)) return null;
  try {
    fs.renameSync(paths.pending, paths.inflight);
  } catch {
    return null;
  }
  const raw = fs.readFileSync(paths.inflight, "utf8");
  const event = SynthesisEventSchema.parse(JSON.parse(raw));

  const leaseSeconds = options?.leaseSeconds ?? 120;
  const leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const stamped: SynthesisEvent = {
    ...event,
    leaseOwner: options?.leaseOwner ?? `worker-${process.pid}`,
    leaseUntil,
  };
  fs.writeFileSync(paths.inflight, JSON.stringify(stamped, null, 2), "utf8");
  return stamped;
}

/**
 * Mark an inflight event as completed. Moves it to `done/` and stamps the
 * resulting ContextEntry id + synthesis metadata for later lookup (the
 * dashboard reads this when showing "synthesized from event …").
 */
export function completeSynthesisEvent(
  repoRoot: string,
  id: string,
  result: {
    resultEntryId: string;
    synthesisTemplateVersion: string;
    model: string;
    tokens?: number;
  },
): void {
  const paths = pathsFor(repoRoot, id);
  if (!fs.existsSync(paths.inflight)) {
    throw new Error(`completeSynthesisEvent: event ${id} is not inflight`);
  }
  const raw = fs.readFileSync(paths.inflight, "utf8");
  const event = SynthesisEventSchema.parse(JSON.parse(raw));

  const completed: CompletedEvent = {
    ...event,
    resultEntryId: result.resultEntryId,
    synthesisTemplateVersion: result.synthesisTemplateVersion,
    model: result.model,
    ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(paths.done, JSON.stringify(completed, null, 2), "utf8");
  fs.unlinkSync(paths.inflight);
}

/**
 * Move an inflight event to `failed/` after a terminal error (no more
 * retries). The worker should bump `attempts` and write back to `pending/`
 * for transient failures (use `requeueInflightEvent`), this is for the
 * give-up path.
 */
export function failSynthesisEvent(
  repoRoot: string,
  id: string,
  error: string,
): void {
  const paths = pathsFor(repoRoot, id);
  if (!fs.existsSync(paths.inflight)) return;
  const raw = fs.readFileSync(paths.inflight, "utf8");
  const event = SynthesisEventSchema.parse(JSON.parse(raw));
  const final: SynthesisEvent = {
    ...event,
    attempts: event.attempts + 1,
    lastError: error.slice(0, 500),
    leaseOwner: undefined,
    leaseUntil: undefined,
  };
  fs.writeFileSync(paths.failed, JSON.stringify(final, null, 2), "utf8");
  fs.unlinkSync(paths.inflight);
}

/**
 * Return an inflight event to `pending/` after a transient failure. Bumps
 * `attempts` and stamps `lastError`. The worker can implement exponential
 * backoff externally by scheduling its own delay before re-listing pending.
 */
export function requeueInflightEvent(
  repoRoot: string,
  id: string,
  error: string,
): void {
  const paths = pathsFor(repoRoot, id);
  if (!fs.existsSync(paths.inflight)) return;
  const raw = fs.readFileSync(paths.inflight, "utf8");
  const event = SynthesisEventSchema.parse(JSON.parse(raw));
  const next: SynthesisEvent = {
    ...event,
    attempts: event.attempts + 1,
    lastError: error.slice(0, 500),
    leaseOwner: undefined,
    leaseUntil: undefined,
  };
  fs.writeFileSync(paths.pending, JSON.stringify(next, null, 2), "utf8");
  fs.unlinkSync(paths.inflight);
}

/**
 * Scan `inflight/` for events whose lease has expired and rescue them back
 * to `pending/`. Called periodically by the worker so a crashed sibling
 * doesn't permanently block synthesis of a file.
 */
export function rescueExpiredLeases(repoRoot: string, now: number = Date.now()): string[] {
  const dir = path.join(queueRoot(repoRoot), INFLIGHT_SUBDIR);
  if (!fs.existsSync(dir)) return [];
  const rescued: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), "utf8");
      const event = SynthesisEventSchema.parse(JSON.parse(raw));
      if (event.leaseUntil && Date.parse(event.leaseUntil) < now) {
        requeueInflightEvent(repoRoot, event.id, "lease expired");
        rescued.push(event.id);
      }
    } catch {
      // Skip
    }
  }
  return rescued;
}
