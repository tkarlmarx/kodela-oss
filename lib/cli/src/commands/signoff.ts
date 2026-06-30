// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 45 — Structured AI code review sign-off workflow.
 *
 * Two modes:
 *
 *   kodela signoff <entryId> [--comment "Verified logic correct"]
 *     Records a sign-off for the given entry.  Clears `reviewRequired`,
 *     writes a `SignOffRecord` to `.kodela/signoffs/<entryId>.json`, and
 *     updates `updatedAt` on the entry.  The reviewer is determined from
 *     `git config user.email` (falling back to `git config user.name`, then
 *     to the KODELA_REVIEWER env var, then to the literal string "unknown").
 *
 *   kodela signoff --pending
 *     Lists all entries where `reviewRequired === true` and no sign-off
 *     record exists yet.  Useful in CI to surface the exact set of changes
 *     that still need a human review gate.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  readIndex,
  readContextEntry,
  writeContextEntry,
  readSignOff,
  writeSignOff,
} from "@kodela/core";
import type { ContextEntry, SignOffRecord } from "@kodela/core";

const execFileAsync = promisify(execFile);

async function resolveReviewer(repoRoot: string): Promise<string> {
  if (process.env["KODELA_REVIEWER"]) {
    return process.env["KODELA_REVIEWER"];
  }
  try {
    const { stdout: email } = await execFileAsync(
      "git",
      ["config", "user.email"],
      { cwd: repoRoot },
    );
    const trimmed = email.trim();
    if (trimmed) return trimmed;
  } catch {
    // fall through to name
  }
  try {
    const { stdout: name } = await execFileAsync(
      "git",
      ["config", "user.name"],
      { cwd: repoRoot },
    );
    const trimmed = name.trim();
    if (trimmed) return trimmed;
  } catch {
    // fall through to unknown
  }
  return "unknown";
}

export type SignoffOptions = {
  repoRoot: string;
  entryId?: string;
  comment?: string;
  pending?: boolean;
};

export type SignoffResult =
  | { mode: "signed"; record: SignOffRecord; filePath: string }
  | { mode: "pending"; entries: ContextEntry[] };

export async function runSignoff(opts: SignoffOptions): Promise<SignoffResult> {
  const { repoRoot } = opts;

  if (opts.pending) {
    const index = await readIndex(repoRoot);
    const allEntries = await Promise.all(
      index.entries.map((id) => readContextEntry(repoRoot, id)),
    );

    const pending: ContextEntry[] = [];
    for (const entry of allEntries) {
      if (!entry.reviewRequired) continue;
      const existing = await readSignOff(repoRoot, entry.id);
      if (!existing) {
        pending.push(entry);
      }
    }
    return { mode: "pending", entries: pending };
  }

  if (!opts.entryId) {
    throw new Error("entryId is required unless --pending is specified");
  }

  const entry = await readContextEntry(repoRoot, opts.entryId);
  const reviewer = await resolveReviewer(repoRoot);

  const record: SignOffRecord = {
    id: randomUUID(),
    entryId: entry.id,
    reviewer,
    signedOffAt: new Date().toISOString(),
    ...(opts.comment ? { comment: opts.comment } : {}),
  };

  await writeSignOff(repoRoot, record);

  const updated = {
    ...entry,
    reviewRequired: false,
    updatedAt: new Date().toISOString(),
  };
  await writeContextEntry(repoRoot, updated);

  return { mode: "signed", record, filePath: entry.filePath };
}

export function formatSignoffResult(result: SignoffResult): string {
  if (result.mode === "signed") {
    const lines = [
      `Signed off entry ${result.record.entryId}`,
      `  File:       ${result.filePath}`,
      `  Reviewer:   ${result.record.reviewer}`,
      `  Signed at:  ${result.record.signedOffAt}`,
    ];
    if (result.record.comment) {
      lines.push(`  Comment:    ${result.record.comment}`);
    }
    lines.push(`  reviewRequired cleared.`);
    return lines.join("\n");
  }

  if (result.entries.length === 0) {
    return "No pending sign-offs — all AI-generated changes have been reviewed.";
  }

  const lines = [`Pending sign-offs (${result.entries.length}):`];
  for (const e of result.entries) {
    const owner = e.reviewerOwner ? ` → assigned to ${e.reviewerOwner}` : "";
    lines.push(`  ${e.id}  ${e.filePath}${owner}`);
  }
  return lines.join("\n");
}
