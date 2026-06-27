// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 45 — Reviewer assignment for AI-generated annotations.
 *
 * `kodela assign <entryId> --to <email>` sets the `reviewerOwner` field on
 * the specified context entry, making it explicit who is responsible for
 * reviewing and signing off the AI-generated change.
 *
 * The command is deliberately lightweight — it only writes the assignment.
 * The actual sign-off is a separate action performed by `kodela signoff`.
 */

import { readContextEntry, writeContextEntry } from "@kodela/core";

export type AssignOptions = {
  repoRoot: string;
  entryId: string;
  to: string;
};

export type AssignResult = {
  entryId: string;
  filePath: string;
  reviewerOwner: string;
};

export async function runAssign(opts: AssignOptions): Promise<AssignResult> {
  const { repoRoot, entryId, to } = opts;

  const entry = await readContextEntry(repoRoot, entryId);

  const updated = {
    ...entry,
    reviewerOwner: to,
    updatedAt: new Date().toISOString(),
  };

  await writeContextEntry(repoRoot, updated);

  return {
    entryId: entry.id,
    filePath: entry.filePath,
    reviewerOwner: to,
  };
}

export function formatAssignResult(result: AssignResult): string {
  return (
    `Assigned reviewer for entry ${result.entryId}\n` +
    `  File:     ${result.filePath}\n` +
    `  Reviewer: ${result.reviewerOwner}`
  );
}
