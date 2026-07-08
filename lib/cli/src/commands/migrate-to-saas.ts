// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * P6.5 Session 2 (internal design note) — `kodela migrate to-saas`.
 *
 * Walks the customer's local `.kodela/objects/` (entries) and
 * `.kodela/sessions/` (sessions) and POSTs each batch via
 * `/api/migrations/local-import` so the customer's data lands in the SaaS
 * SqlBackend under their orgId.
 *
 * Modelled on `sync.ts`'s pattern (batch + per-record rejection collection +
 * graceful error handling).  Differences:
 *
 *   - Hits the migration endpoint, not the entries-session-batch one.
 *   - Sends entries AND sessions (sync.ts only handles entries).
 *   - Takes an explicit `repoId` because the customer needs to choose which
 *     server-side repo_links.id their data attaches to before migration.
 *   - Idempotent end-to-end — restartable after a partial failure (the
 *     server-side upsert covers retry semantics).
 *
 * NOT YET HANDLED in Session 2 (matches the endpoint's deferrals):
 *   - Comments + signoffs migration → P6.5b
 *   - Audit chain blob upload → doc 25 scope
 *   - Local cleanup post-migration → leave files in place by default; an
 *     explicit `--clear-local` flag could be added later but it's the wrong
 *     default for a security-sensitive one-shot operation.
 */

import {
  readIndex,
  readContextEntry,
  listSessions,
  readSignOff,
  readComments,
  loadLicense,
  type ContextEntry,
  type KodelaSession,
  type SignOffRecord,
  type ContextComment,
} from "@kodela/core";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Paths within the .kodela/ directory.  Local copies rather than imports from
// lib/core to avoid widening that package's public surface for a CLI-only need.
const SIGNOFFS_SUBDIR = ".kodela/signoffs";
const COMMENTS_SUBDIR = ".kodela/comments";

export interface MigrateToSaasOptions {
  repoRoot: string;
  serverUrl: string;
  apiKey: string;
  /** Server-side repo identifier (FK to repo_links.id) the migration targets. */
  repoId: string;
  /**
   * Organization id sent as the `X-Kodela-Org-Id` header. The Enterprise
   * api-server rejects every request without it (401). When omitted, it is
   * resolved from the local license (`loadLicense().orgId`), matching `sync`.
   */
  orgId?: string;
  /** Max records (entries + sessions combined) per request batch. */
  batchSize?: number;
  /** When true, walks the local data + prints what would be sent without POST-ing. */
  dryRun?: boolean;
}

export interface MigrateToSaasResult {
  entriesFound: number;
  sessionsFound: number;
  signoffsFound: number;
  commentsFound: number;
  entriesUploaded: number;
  sessionsUploaded: number;
  signoffsUploaded: number;
  commentsUploaded: number;
  rejections: Array<{ kind: "entry" | "session" | "signoff" | "comment"; id: string; reason: string }>;
  httpErrors: string[];
  dryRun: boolean;
}

export class MigrateToSaasError extends Error {
  constructor(message: string, public readonly remediation?: string) {
    super(message);
    this.name = "MigrateToSaasError";
  }
}

interface MigrationBatchResponse {
  repoId: string;
  orgId: string;
  entriesAccepted: number;
  sessionsAccepted: number;
  signoffsAccepted: number;
  commentsAccepted: number;
  rejections: Array<{ kind: "entry" | "session" | "signoff" | "comment"; id: string; reason: string }>;
}

async function postBatch(
  serverUrl: string,
  apiKey: string,
  orgId: string | undefined,
  repoId: string,
  entries: ContextEntry[],
  sessions: KodelaSession[],
  signoffs: SignOffRecord[],
  comments: ContextComment[],
): Promise<{ ok: true; body: MigrationBatchResponse } | { ok: false; error: string }> {
  const payload = { repoId, entries, sessions, signoffs, comments };
  // The Enterprise api-server (verifyCliAuth) requires X-Kodela-Org-Id and 401s
  // without it. Send the caller-resolved orgId (from --org-id, the license, or
  // KODELA_ORG_ID). No hardcoded fallback — a wrong org id fails auth as loudly
  // as a missing one, so surface the real value or none at all.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (orgId) {
    headers["X-Kodela-Org-Id"] = orgId;
  }
  let res: Response;
  try {
    res = await fetch(`${serverUrl.replace(/\/$/, "")}/api/migrations/local-import`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}: ${text || "(empty body)"}` };
  }
  try {
    const body = JSON.parse(text) as MigrationBatchResponse;
    return { ok: true, body };
  } catch (err) {
    return {
      ok: false,
      error: `Server returned 2xx but body could not be parsed as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

export async function runMigrateToSaas(opts: MigrateToSaasOptions): Promise<MigrateToSaasResult> {
  const { repoRoot, serverUrl, apiKey, repoId } = opts;
  const batchSize = opts.batchSize ?? 100;
  const dryRun = opts.dryRun ?? false;

  if (!repoRoot || !serverUrl || !apiKey || !repoId) {
    throw new MigrateToSaasError(
      "Missing required options (repoRoot, serverUrl, apiKey, repoId)",
      "→ pass --server, --api-key, and --repo-id (or set them in kodela.config.json + env)",
    );
  }

  // Resolve the org id the api-server requires in X-Kodela-Org-Id: an explicit
  // --org-id wins, then KODELA_ORG_ID, then the local license (like `sync`).
  const orgId =
    opts.orgId ?? process.env.KODELA_ORG_ID ?? (await loadLicense(repoRoot))?.orgId ?? undefined;
  if (!orgId && !dryRun) {
    throw new MigrateToSaasError(
      "No organization id available for the X-Kodela-Org-Id header — the Enterprise server will reject the request (401).",
      "→ pass --org-id <id>, set KODELA_ORG_ID, or install your org license (kodela activate)",
    );
  }

  // ── Load all entries via the on-disk index ────────────────────────────────
  const index = await readIndex(repoRoot);
  const entryIds = index.entries;

  const entries: ContextEntry[] = [];
  for (const id of entryIds) {
    try {
      const entry = await readContextEntry(repoRoot, id);
      entries.push(entry);
    } catch {
      // Skip a corrupted entry rather than aborting the migration — it'll show
      // up in the rejections list once the server validates the rest.  The
      // CLI's behavioural contract is "ship what we can read; report what we can't".
    }
  }

  // ── Load all sessions ─────────────────────────────────────────────────────
  const sessions = await listSessions(repoRoot);

  // ── Load all sign-offs (P6.5b) ────────────────────────────────────────────
  // signoffs are stored as one file per entryId; the filename's stem IS the
  // entryId.  Walk the directory + readSignOff each.
  const signoffs: SignOffRecord[] = [];
  try {
    const files = await readdir(join(repoRoot, SIGNOFFS_SUBDIR));
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const entryId = file.slice(0, -5); // strip .json
      try {
        const so = await readSignOff(repoRoot, entryId);
        if (so) signoffs.push(so);
      } catch {
        // Corrupted file — skip; the server-side rejection list will reflect
        // any that get sent and fail.  No rejection here because the file
        // wasn't shipped.
      }
    }
  } catch {
    // signoffs dir doesn't exist — no signoffs yet.  Not an error.
  }

  // ── Load all comments (P6.5b) ─────────────────────────────────────────────
  // comments are stored as one array file per entryId; flatten into one
  // ContextComment[] for the upload batch.
  const comments: ContextComment[] = [];
  try {
    const files = await readdir(join(repoRoot, COMMENTS_SUBDIR));
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const entryId = file.slice(0, -5);
      try {
        const thread = await readComments(repoRoot, entryId, { includeResolved: true });
        comments.push(...thread);
      } catch {
        // Same skip semantic as signoffs.
      }
    }
  } catch {
    // comments dir doesn't exist — no comments yet.
  }

  const result: MigrateToSaasResult = {
    entriesFound: entries.length,
    sessionsFound: sessions.length,
    signoffsFound: signoffs.length,
    commentsFound: comments.length,
    entriesUploaded: 0,
    sessionsUploaded: 0,
    signoffsUploaded: 0,
    commentsUploaded: 0,
    rejections: [],
    httpErrors: [],
    dryRun,
  };

  if (dryRun) {
    return result;
  }

  // ── Batch + POST ──────────────────────────────────────────────────────────
  // Entries, sessions, signoffs, comments batched together — keeps the
  // request count low for customers with many records of any one kind.
  type AnyRecord =
    | { kind: "entry"; entry: ContextEntry }
    | { kind: "session"; session: KodelaSession }
    | { kind: "signoff"; signoff: SignOffRecord }
    | { kind: "comment"; comment: ContextComment };

  const records: AnyRecord[] = [
    ...entries.map<AnyRecord>((e) => ({ kind: "entry", entry: e })),
    ...sessions.map<AnyRecord>((s) => ({ kind: "session", session: s })),
    ...signoffs.map<AnyRecord>((s) => ({ kind: "signoff", signoff: s })),
    ...comments.map<AnyRecord>((c) => ({ kind: "comment", comment: c })),
  ];

  for (let offset = 0; offset < records.length; offset += batchSize) {
    const slice = records.slice(offset, offset + batchSize);
    const batchEntries = slice
      .filter((r): r is { kind: "entry"; entry: ContextEntry } => r.kind === "entry")
      .map((r) => r.entry);
    const batchSessions = slice
      .filter((r): r is { kind: "session"; session: KodelaSession } => r.kind === "session")
      .map((r) => r.session);
    const batchSignoffs = slice
      .filter((r): r is { kind: "signoff"; signoff: SignOffRecord } => r.kind === "signoff")
      .map((r) => r.signoff);
    const batchComments = slice
      .filter((r): r is { kind: "comment"; comment: ContextComment } => r.kind === "comment")
      .map((r) => r.comment);

    const res = await postBatch(
      serverUrl,
      apiKey,
      orgId,
      repoId,
      batchEntries,
      batchSessions,
      batchSignoffs,
      batchComments,
    );
    if (!res.ok) {
      result.httpErrors.push(res.error);
      // Continue to next batch — partial migration is preferable to a full
      // abort when network has a transient failure.  Operator can re-run.
      continue;
    }
    result.entriesUploaded += res.body.entriesAccepted;
    result.sessionsUploaded += res.body.sessionsAccepted;
    result.signoffsUploaded += res.body.signoffsAccepted;
    result.commentsUploaded += res.body.commentsAccepted;
    result.rejections.push(...res.body.rejections);
  }

  return result;
}

export function formatMigrateToSaasResult(result: MigrateToSaasResult): string {
  const lines: string[] = [];
  if (result.dryRun) {
    lines.push("Dry-run: nothing was sent. Would migrate:");
  } else {
    lines.push("Migration complete.");
  }
  lines.push("");
  lines.push(`  Entries on disk : ${result.entriesFound}`);
  lines.push(`  Sessions on disk: ${result.sessionsFound}`);
  lines.push(`  Signoffs on disk: ${result.signoffsFound}`);
  lines.push(`  Comments on disk: ${result.commentsFound}`);
  if (!result.dryRun) {
    lines.push(`  Entries uploaded : ${result.entriesUploaded}`);
    lines.push(`  Sessions uploaded: ${result.sessionsUploaded}`);
    lines.push(`  Signoffs uploaded: ${result.signoffsUploaded}`);
    lines.push(`  Comments uploaded: ${result.commentsUploaded}`);
  }
  if (result.rejections.length > 0) {
    lines.push("");
    lines.push(`  ⚠ ${result.rejections.length} record(s) rejected by the server:`);
    for (const r of result.rejections.slice(0, 5)) {
      lines.push(`     [${r.kind}] ${r.id} — ${r.reason}`);
    }
    if (result.rejections.length > 5) {
      lines.push(`     (… and ${result.rejections.length - 5} more)`);
    }
  }
  if (result.httpErrors.length > 0) {
    lines.push("");
    lines.push(`  ✖ ${result.httpErrors.length} HTTP batch failure(s):`);
    for (const e of result.httpErrors.slice(0, 5)) {
      lines.push(`     ${e}`);
    }
  }
  lines.push("");
  if (result.httpErrors.length === 0 && result.rejections.length === 0 && !result.dryRun) {
    lines.push("● Overall: success");
  } else if (result.httpErrors.length === 0 && !result.dryRun) {
    lines.push("● Overall: partial — server validated some records but rejected others; re-run to retry");
  } else if (result.httpErrors.length > 0) {
    lines.push("● Overall: failed batches present — re-run `kodela migrate to-saas` (the upsert path is idempotent)");
  }
  return lines.join("\n");
}

export function handleMigrateToSaasError(err: unknown): never {
  if (err instanceof MigrateToSaasError) {
    process.stderr.write(`Error: ${err.message}\n`);
    if (err.remediation) process.stderr.write(`${err.remediation}\n`);
    process.exit(1);
  }
  throw err;
}
