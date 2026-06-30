// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 23 G3 — `kodela correct` command.
 *
 * Performs an in-place correction of source classification for all context
 * entries in a given file without requiring delete + re-add.
 *
 * When applied:
 *   - `source` is set to the user-specified value.
 *   - `confidence` and `attributionConfidence` are set to 1.0 (user is authoritative).
 *   - `userOverride: true` marks the entry as human-corrected.
 *   - `canUpgradeAttribution: false` locks the entry against automated re-classification.
 *   - `reviewRequired: false` clears the review flag (the user just reviewed it).
 *   - `aiTool` is cleared when `--source human` is used.
 *
 * Example:
 *   kodela correct docs/Tech/Adhoc/GitvsKodela.md --source human
 */

import { readIndex, readContextEntry, writeContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { normalizeFilePath } from "../utils/repo.js";

export type CorrectSource = "human" | "ai" | "unknown";

export type CorrectOptions = {
  repoRoot: string;
  filePath: string;
  source: CorrectSource;
  dryRun?: boolean;
};

export type CorrectResult = {
  updatedCount: number;
  entries: ContextEntry[];
  dryRun: boolean;
  filePath: string;
  source: CorrectSource;
};

export async function runCorrect(opts: CorrectOptions): Promise<CorrectResult> {
  const { repoRoot, source, dryRun = false } = opts;
  const filePath = normalizeFilePath(opts.filePath);

  const index = await readIndex(repoRoot);
  const allEntries = await Promise.all(
    index.entries.map((id) => readContextEntry(repoRoot, id)),
  );

  const fileEntries = allEntries.filter(
    (e) => normalizeFilePath(e.filePath) === filePath,
  );

  if (fileEntries.length === 0) {
    return { updatedCount: 0, entries: [], dryRun, filePath, source };
  }

  const now = new Date().toISOString();

  const updatedEntries: ContextEntry[] = fileEntries.map((entry) => {
    const updated: ContextEntry = {
      ...entry,
      source,
      // User is the authoritative source — always 1.0.
      confidence: 1.0,
      attributionConfidence: 1.0,
      // Gap 23 G3 trust invariant: lock this entry against automated re-classification.
      userOverride: true,
      canUpgradeAttribution: false,
      reviewRequired: false,
      updatedAt: now,
      // Clear aiTool when correcting to human (it wasn't AI-generated).
      aiTool: source === "human" ? undefined : entry.aiTool,
    };
    return updated;
  });

  if (!dryRun) {
    await Promise.all(
      updatedEntries.map((entry) => writeContextEntry(repoRoot, entry)),
    );
  }

  return {
    updatedCount: updatedEntries.length,
    entries: updatedEntries,
    dryRun,
    filePath,
    source,
  };
}

export function formatCorrectResult(result: CorrectResult): string {
  if (result.updatedCount === 0) {
    return `No context entries found for ${result.filePath}.`;
  }

  const prefix = result.dryRun ? "[DRY RUN] " : "";
  const entryWord = result.updatedCount === 1 ? "entry" : "entries";
  return (
    `${prefix}Corrected ${result.updatedCount} ${entryWord} in ${result.filePath}\n` +
    `  source: "${result.source}" | confidence: 1.0 | userOverride: true (locked against auto-reclassification)`
  );
}
