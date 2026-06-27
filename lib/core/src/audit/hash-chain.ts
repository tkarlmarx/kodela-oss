// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Append-only hash-chain audit log — Phase 5 of doc 23.
 *
 * Every entry is sha256-linked to its predecessor: tampering with any record
 * invalidates the chain from that point forward. Stored as JSONL at
 * `.kodela/audit/chain.jsonl` so it's grep-able + diffable + survives a
 * `.kodela/index.db` wipe.
 *
 * Doc 23 §5.1 calls this out for:
 *   - kodela_annotate_file
 *   - kodela_record_decision
 *   - kodela_session_end
 *   - synthesis worker writes
 *   - RBAC violations (Phase 5.4)
 *   - right-to-be-forgotten deletions (Phase 5.6 — deferred)
 *
 * The library is deliberately small. The hash is plain sha256 over a stable
 * JSON canonicalisation. No external dep on a Merkle tree library — we don't
 * need partial proofs, just chain integrity verification.
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

/** Concrete event kinds the chain knows about. Extend as new sources land. */
export type AuditEventKind =
  | "annotate_file"
  | "record_decision"
  | "session_end"
  | "synthesis_write"
  | "rbac_violation"
  | "capture_denied" // policy module rejected a capture (path glob, agent allow/deny, model allowlist)
  | "tenant_delete"
  | "test_event"; // for tests; production code SHOULD use a real kind

export interface AuditPayload {
  kind: AuditEventKind;
  /** Authoritative actor — usually orgId or anonymous. */
  actor?: string;
  /** Free-form, structured. Stable across reads — DO NOT include timestamps here; the entry already carries one. */
  data: Record<string, unknown>;
}

export interface AuditEntry {
  /** UUIDv4 — entry id. */
  id: string;
  /** ISO-8601 UTC. Caller-supplied so tests can pin it. */
  timestamp: string;
  /** Monotonic per-chain sequence, starting at 1. */
  seq: number;
  /** Hex sha256 of the previous entry's `entryHash`. "0".repeat(64) for genesis. */
  prevHash: string;
  /** Hex sha256 of the canonical JSON of `payload`. */
  payloadHash: string;
  /** The event body. */
  payload: AuditPayload;
  /** Hex sha256 of `prevHash + payloadHash + timestamp + seq`. */
  entryHash: string;
}

const GENESIS_PREV_HASH = "0".repeat(64);

/** Stable JSON serialisation: sorted keys, no whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(",")}}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hashPayload(payload: AuditPayload): string {
  return sha256Hex(canonicalJson(payload));
}

export function hashEntry(prevHash: string, payloadHash: string, timestamp: string, seq: number): string {
  return sha256Hex(`${prevHash}|${payloadHash}|${timestamp}|${seq}`);
}

export interface CreateEntryOptions {
  prevEntry: AuditEntry | null;
  payload: AuditPayload;
  /** ISO-8601; defaults to `new Date().toISOString()`. Override for tests. */
  timestamp?: string;
  /** UUID override for tests. */
  id?: string;
}

/** Compute a new entry without writing it. Pure — useful for tests + dry-runs. */
export function createEntry({
  prevEntry,
  payload,
  timestamp = new Date().toISOString(),
  id = randomUUID(),
}: CreateEntryOptions): AuditEntry {
  const prevHash = prevEntry?.entryHash ?? GENESIS_PREV_HASH;
  const seq = (prevEntry?.seq ?? 0) + 1;
  const payloadHash = hashPayload(payload);
  const entryHash = hashEntry(prevHash, payloadHash, timestamp, seq);
  return { id, timestamp, seq, prevHash, payloadHash, payload, entryHash };
}

/** Read all entries from a JSONL chain file. Returns [] if file missing. */
export async function readChain(chainPath: string): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(chainPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}

/**
 * Append a new entry. Reads the tail of the chain to find the previous entry,
 * computes the new entry, and atomically appends. Returns the new entry.
 *
 * Single-writer assumption: the MCP server is the only writer per repo.  If
 * that changes, replace the readChain+writeFile pattern with a SQLite-backed
 * sequence + WAL.
 */
export async function appendEntry(chainPath: string, payload: AuditPayload, options?: { timestamp?: string; id?: string }): Promise<AuditEntry> {
  const existing = await readChain(chainPath);
  const prevEntry = existing.length > 0 ? existing[existing.length - 1]! : null;
  const entry = createEntry({ prevEntry, payload, timestamp: options?.timestamp, id: options?.id });
  await fs.mkdir(dirname(chainPath), { recursive: true });
  await fs.appendFile(chainPath, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  return entry;
}

export type VerifyChainResult =
  | { ok: true; entryCount: number }
  | { ok: false; entryCount: number; brokenAtSeq: number; reason: string };

/**
 * Walk the chain and verify every link. Catches:
 *   - prevHash chain breaks (a record was modified)
 *   - payloadHash mismatch (a payload was edited in place)
 *   - entryHash mismatch (anything else tampered with)
 *   - seq gaps (an entry was deleted)
 *   - genesis prevHash != GENESIS_PREV_HASH
 */
export function verifyChain(entries: AuditEntry[]): VerifyChainResult {
  let prevHash = GENESIS_PREV_HASH;
  let expectedSeq = 1;
  for (const entry of entries) {
    if (entry.seq !== expectedSeq) {
      return { ok: false, entryCount: entries.length, brokenAtSeq: entry.seq, reason: `seq gap: expected ${expectedSeq}, got ${entry.seq}` };
    }
    if (entry.prevHash !== prevHash) {
      return { ok: false, entryCount: entries.length, brokenAtSeq: entry.seq, reason: "prevHash chain break" };
    }
    if (entry.payloadHash !== hashPayload(entry.payload)) {
      return { ok: false, entryCount: entries.length, brokenAtSeq: entry.seq, reason: "payload tampered (payloadHash mismatch)" };
    }
    if (entry.entryHash !== hashEntry(entry.prevHash, entry.payloadHash, entry.timestamp, entry.seq)) {
      return { ok: false, entryCount: entries.length, brokenAtSeq: entry.seq, reason: "entryHash tampered" };
    }
    prevHash = entry.entryHash;
    expectedSeq++;
  }
  return { ok: true, entryCount: entries.length };
}

/** Verify the chain at a specific path. Convenience wrapper. */
export async function verifyChainAt(chainPath: string): Promise<VerifyChainResult> {
  return verifyChain(await readChain(chainPath));
}
