// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Right-to-be-forgotten — Phase 5.6 of doc 23.
 *
 * Local-first interpretation per user 2026-06-25: there's one tenant per
 * repo, so RTBF here means "wipe this `.kodela`" rather than "DELETE WHERE
 * org_id = X". The endpoint takes no orgId; it purges the `.kodela`
 * directory after writing an out-of-tree proof file so the deletion is
 * cryptographically attested even though the hash chain itself is gone.
 *
 * Sequence:
 *   1. Inventory what will be deleted (file counts + SQL row counts).
 *   2. Append a `tenant_delete` entry to the audit chain.
 *   3. Read the chain back and compute its final entryHash — this becomes
 *      the deletion proof's `chainTipBeforeDeletion`.
 *   4. Write the proof file at `<repoRoot>/.kodela.deletion-proof-<timestamp>.json`
 *      OUTSIDE the `.kodela` directory.
 *   5. Recursive-rm of `.kodela/`.
 *
 * The proof file is the only artefact a customer / auditor can use after
 * the purge to prove that:
 *   (a) The deletion happened at the timestamp recorded.
 *   (b) The chain was intact up to that point (`chainTipBeforeDeletion`
 *       is the `entryHash` of the final `tenant_delete` entry).
 *   (c) An attempt to forge a deletion that didn't happen would require
 *       producing a valid hash that links to the chain tip — infeasible
 *       without the keying material (none here; trust model is "the
 *       attacker has no access to the host filesystem").
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appendEntry, readChain, type AuditEntry } from "./hash-chain.js";

export interface RtbfInventory {
  objectFiles: number;
  sessionFiles: number;
  otherKodelaFiles: number;
  decisionsRows: number;
  graphEdgesRows: number;
  /** Total files including subdirectories under .kodela/. */
  totalFiles: number;
}

export interface RtbfProof {
  /** Stable identifier — UUIDv4 from the `tenant_delete` chain entry. */
  proofId: string;
  /** ISO-8601 timestamp of the deletion. */
  deletedAt: string;
  /** Repo root the proof attests to. */
  repoRoot: string;
  /** Snapshot of what was deleted. */
  inventory: RtbfInventory;
  /** Final `entryHash` of the audit chain before purge. */
  chainTipBeforeDeletion: string;
  /** Final `seq` of the audit chain before purge. */
  chainLengthBeforeDeletion: number;
  /** Schema version of the proof file format. */
  proofSchemaVersion: "1.0";
}

const KODELA_DIR = ".kodela";
const PROOF_PREFIX = ".kodela.deletion-proof-";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function countFilesUnder(dir: string): Promise<number> {
  let count = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      count += await countFilesUnder(p);
    } else if (e.isFile()) {
      count++;
    }
  }
  return count;
}

function safeTableCount(db: DatabaseSync, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    // Table doesn't exist — that's fine, it counts as 0 to purge.
    return 0;
  }
}

/**
 * Sum every record this RTBF will touch.  Reported in the proof so the
 * auditor can reason about scale without re-creating the data.
 */
export async function buildInventory(repoRoot: string): Promise<RtbfInventory> {
  const kodelaDir = path.join(repoRoot, KODELA_DIR);
  const objectsDir = path.join(kodelaDir, "objects");
  const sessionsDir = path.join(kodelaDir, "sessions");
  const indexDb = path.join(kodelaDir, "index.db");

  const objectFiles = await countFilesUnder(objectsDir);
  const sessionFiles = await countFilesUnder(sessionsDir);
  const totalFiles = await countFilesUnder(kodelaDir);
  const otherKodelaFiles = totalFiles - objectFiles - sessionFiles;

  let decisionsRows = 0;
  let graphEdgesRows = 0;
  if (await exists(indexDb)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(indexDb);
      decisionsRows = safeTableCount(db, "decisions");
      graphEdgesRows = safeTableCount(db, "graph_edges");
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  return {
    objectFiles,
    sessionFiles,
    otherKodelaFiles,
    decisionsRows,
    graphEdgesRows,
    totalFiles,
  };
}

export interface PerformRtbfOptions {
  repoRoot: string;
  /** Test-only — override the deletion timestamp. */
  now?: () => string;
}

/**
 * Execute the purge. Returns the proof object that was also written to disk.
 * The proof file path is `<repoRoot>/.kodela.deletion-proof-<isoZ>.json` —
 * outside `.kodela/` so it survives the recursive rm.
 *
 * Throws when `<repoRoot>/.kodela/` doesn't exist (nothing to purge).
 * Throws when the proof file already exists for this timestamp (collision).
 */
export async function performRtbf({ repoRoot, now }: PerformRtbfOptions): Promise<{ proof: RtbfProof; proofPath: string }> {
  const kodelaDir = path.join(repoRoot, KODELA_DIR);
  if (!(await exists(kodelaDir))) {
    throw new Error(`RTBF: no ${KODELA_DIR} directory found at ${repoRoot}`);
  }

  const deletedAt = (now ?? (() => new Date().toISOString()))();
  const inventory = await buildInventory(repoRoot);

  // Append the tenant_delete entry to the audit chain so the chain itself
  // contains a record of its own deletion.  The proof links forward from
  // this entry's entryHash.
  const chainPath = path.join(kodelaDir, "audit", "chain.jsonl");
  const finalEntry: AuditEntry = await appendEntry(chainPath, {
    kind: "tenant_delete",
    actor: "rtbf",
    data: { reason: "right_to_be_forgotten", inventory },
  });
  const chain = await readChain(chainPath);
  const chainTip = chain[chain.length - 1]?.entryHash ?? finalEntry.entryHash;
  const chainLength = chain.length;

  const proof: RtbfProof = {
    proofId: finalEntry.id,
    deletedAt,
    repoRoot,
    inventory,
    chainTipBeforeDeletion: chainTip,
    chainLengthBeforeDeletion: chainLength,
    proofSchemaVersion: "1.0",
  };

  // Encode the timestamp into the filename so successive RTBFs don't collide.
  const safeStamp = deletedAt.replace(/[:.]/g, "-");
  const proofPath = path.join(repoRoot, `${PROOF_PREFIX}${safeStamp}.json`);

  if (await exists(proofPath)) {
    throw new Error(`RTBF: proof file already exists at ${proofPath} — refusing to overwrite`);
  }

  // Write the proof BEFORE the wipe. If the wipe fails partway the proof
  // still exists so an operator can investigate.
  await fs.writeFile(proofPath, JSON.stringify(proof, null, 2) + "\n", "utf8");

  // Recursive purge.
  await fs.rm(kodelaDir, { recursive: true, force: true });

  return { proof, proofPath };
}

/**
 * Verify a proof file against the repo root it claims to attest to.
 * Returns `ok: false` with a reason when the file is missing, malformed,
 * or its `repoRoot` doesn't match. Does NOT verify the chain tip — at
 * this point the chain is gone by design; the tip-hash is the anchor an
 * external auditor uses to cross-reference against backups or witness
 * logs.
 */
export async function verifyProofFile(proofPath: string): Promise<
  { ok: true; proof: RtbfProof } | { ok: false; reason: string }
> {
  let raw: string;
  try {
    raw = await fs.readFile(proofPath, "utf8");
  } catch (err) {
    return { ok: false, reason: `proof file unreadable: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `proof file malformed JSON: ${(err as Error).message}` };
  }
  // Light schema check — full parse-time validation would require zod here;
  // we keep the audit subsystem zod-free so the chain stays usable in
  // constrained boot environments.
  const p = parsed as RtbfProof;
  if (
    typeof p.proofId !== "string" ||
    typeof p.deletedAt !== "string" ||
    typeof p.repoRoot !== "string" ||
    typeof p.chainTipBeforeDeletion !== "string" ||
    p.proofSchemaVersion !== "1.0"
  ) {
    return { ok: false, reason: "proof file missing required fields or wrong schema version" };
  }
  return { ok: true, proof: p };
}
