// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Sprint 2 / [E.6] re-anchor migration — `kodela heal --re-anchor`.
 *
 * Walks every persisted ContextEntry in `.kodela/objects/`, recomputes its
 * `astAnchor.bodyHash + paramCount` using the tree-sitter dispatcher
 * (`buildAstAnchorAsync` in @kodela/core), and rewrites the entry when the
 * anchor changed.  After a successful run a marker file `.kodela/.tree-sitter-anchored`
 * is written; the mapping engine's default-on logic reads it to decide whether
 * to use the tree-sitter path without forcing the env-var flag.
 *
 * Why this exists: the hash-audit recorded 0 / 845 bodyHash compat between
 * the regex extractor (which the corpus was anchored with) and the
 * tree-sitter dispatcher (which heal-engine would use after the swap).
 * Flipping the flag without this migration silently breaks Tier-3 rename
 * resilience for the entire legacy cohort.  Running this once aligns the
 * persisted hashes with what `mapWithAstLayerAsync` computes at heal time.
 *
 * Properties:
 *   - **Idempotent.** A second run produces zero rewrites; every anchor
 *     already equals what tree-sitter emits.
 *   - **Append-only log.** Every entry produces a JSONL line in
 *     `.kodela/heal-reanchor.log.jsonl` regardless of outcome (rewritten /
 *     no-change / skipped) so the migration is fully auditable.
 *   - **Dry-run safe.** `--dry-run` computes everything and writes the log
 *     but never overwrites entry files or touches the marker.
 *   - **Source-aware.** Entries whose underlying source file is missing
 *     or whose lineRange no longer overlaps any AST node are logged as
 *     `skipped: no-source` / `skipped: no-overlap` and left untouched.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  readIndex,
  readContextEntry,
  writeContextEntry,
  buildAstAnchorAsync,
  isAstLayerApplicable,
} from "@kodela/core";
import type { AstAnchor } from "@kodela/core";

export const REANCHOR_MARKER_FILE = ".kodela/.tree-sitter-anchored";
export const REANCHOR_LOG_FILE = ".kodela/heal-reanchor.log.jsonl";

export type ReAnchorOptions = {
  repoRoot: string;
  dryRun?: boolean;
};

export type ReAnchorOutcome =
  | "rewritten"
  | "no-change"
  | "skipped:no-anchor"
  | "skipped:not-applicable"
  | "skipped:no-source"
  | "skipped:no-overlap"
  | "skipped:read-failed";

export type ReAnchorEntry = {
  entryId: string;
  filePath: string;
  outcome: ReAnchorOutcome;
  /** Old vs new anchor when rewritten; omitted otherwise. */
  before?: AstAnchor;
  after?: AstAnchor;
};

export type ReAnchorResult = {
  totalEntries: number;
  rewritten: number;
  unchanged: number;
  skipped: number;
  dryRun: boolean;
  markerWritten: boolean;
  logPath: string;
  entries: ReAnchorEntry[];
};

export async function runHealReAnchor(
  opts: ReAnchorOptions,
): Promise<ReAnchorResult> {
  const { repoRoot } = opts;
  const dryRun = opts.dryRun ?? false;

  const index = await readIndex(repoRoot);
  const ids = index.entries;

  const entries: ReAnchorEntry[] = [];
  let rewritten = 0;
  let unchanged = 0;
  let skipped = 0;

  // Read every source file at most once — multiple entries can share a file.
  const sourceCache = new Map<string, string | null>();
  async function readSource(filePath: string): Promise<string | null> {
    if (sourceCache.has(filePath)) return sourceCache.get(filePath)!;
    try {
      const content = await fs.readFile(path.join(repoRoot, filePath), "utf-8");
      sourceCache.set(filePath, content);
      return content;
    } catch {
      sourceCache.set(filePath, null);
      return null;
    }
  }

  for (const id of ids) {
    let entry;
    try {
      entry = await readContextEntry(repoRoot, id);
    } catch {
      entries.push({
        entryId: id,
        filePath: "<unknown>",
        outcome: "skipped:read-failed",
      });
      skipped++;
      continue;
    }

    if (entry.astAnchor === null) {
      entries.push({
        entryId: id,
        filePath: entry.filePath,
        outcome: "skipped:no-anchor",
      });
      skipped++;
      continue;
    }
    if (!isAstLayerApplicable(entry.filePath)) {
      entries.push({
        entryId: id,
        filePath: entry.filePath,
        outcome: "skipped:not-applicable",
      });
      skipped++;
      continue;
    }

    const fileContent = await readSource(entry.filePath);
    if (fileContent === null) {
      entries.push({
        entryId: id,
        filePath: entry.filePath,
        outcome: "skipped:no-source",
      });
      skipped++;
      continue;
    }

    const next = await buildAstAnchorAsync(
      entry.filePath,
      entry.lineRange,
      fileContent,
    );
    if (next === null) {
      entries.push({
        entryId: id,
        filePath: entry.filePath,
        outcome: "skipped:no-overlap",
      });
      skipped++;
      continue;
    }

    if (anchorsEqual(entry.astAnchor, next)) {
      entries.push({
        entryId: id,
        filePath: entry.filePath,
        outcome: "no-change",
      });
      unchanged++;
      continue;
    }

    entries.push({
      entryId: id,
      filePath: entry.filePath,
      outcome: "rewritten",
      before: entry.astAnchor,
      after: next,
    });
    rewritten++;

    if (!dryRun) {
      await writeContextEntry(repoRoot, {
        ...entry,
        astAnchor: next,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  await writeJsonlLog(repoRoot, entries);
  let markerWritten = false;
  if (!dryRun) {
    await writeMarker(repoRoot, {
      totalEntries: ids.length,
      rewritten,
      unchanged,
      skipped,
    });
    markerWritten = true;
  }

  return {
    totalEntries: ids.length,
    rewritten,
    unchanged,
    skipped,
    dryRun,
    markerWritten,
    logPath: REANCHOR_LOG_FILE,
    entries,
  };
}

function anchorsEqual(a: AstAnchor, b: AstAnchor): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.kind === b.kind &&
    a.name === b.name &&
    a.blockHash === b.blockHash &&
    a.bodyHash === b.bodyHash &&
    a.paramCount === b.paramCount &&
    (a.symbolId ?? null) === (b.symbolId ?? null)
  );
}

async function writeJsonlLog(
  repoRoot: string,
  entries: ReAnchorEntry[],
): Promise<void> {
  const logPath = path.join(repoRoot, REANCHOR_LOG_FILE);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const lines = entries
    .map((e) => JSON.stringify({ timestamp: new Date().toISOString(), ...e }))
    .join("\n");
  await fs.writeFile(logPath, lines + (entries.length > 0 ? "\n" : ""), "utf-8");
}

async function writeMarker(
  repoRoot: string,
  summary: { totalEntries: number; rewritten: number; unchanged: number; skipped: number },
): Promise<void> {
  const markerPath = path.join(repoRoot, REANCHOR_MARKER_FILE);
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(
    markerPath,
    JSON.stringify(
      {
        version: 1,
        completedAt: new Date().toISOString(),
        summary,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

export function formatReAnchorResult(result: ReAnchorResult): string {
  const lines: string[] = [];
  lines.push(
    `Re-anchor ${result.dryRun ? "(dry-run) " : ""}— ${result.totalEntries} entries scanned`,
  );
  lines.push(`  Rewritten:  ${result.rewritten}`);
  lines.push(`  Unchanged:  ${result.unchanged}`);
  lines.push(`  Skipped:    ${result.skipped}`);
  lines.push(`  Log:        ${result.logPath}`);
  if (result.markerWritten) {
    lines.push(
      `  Marker:     .kodela/.tree-sitter-anchored — tree-sitter is now the default heal path.`,
    );
  } else if (result.dryRun) {
    lines.push("  Marker:     (skipped — dry-run)");
  }
  return lines.join("\n");
}
