// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { readIndex, readContextEntry, deleteContextEntry, ensureKodelaDir, loadLicense, SCHEMA_VERSION } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { recordCliEvent } from "../audit/recordCliEvent.js";

const KODELA_DIR = ".kodela";
const ARCHIVES_DIR = "archives";

export type ArchiveOptions = {
  maxDays?: number;
  dryRun?: boolean;
  repoRoot: string;
};

export type ArchiveResult = {
  total: number;
  archived: number;
  skipped: number;
  archivedEntries: ContextEntry[];
  dryRun: boolean;
  archivePath?: string;
};

function isOlderThanDays(dateStr: string, days: number): boolean {
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays > days;
}

export async function runArchive(opts: ArchiveOptions): Promise<ArchiveResult> {
  const { repoRoot, maxDays = 90, dryRun = false } = opts;

  const index = await readIndex(repoRoot);
  const allEntries = await Promise.all(
    index.entries.map((id) => readContextEntry(repoRoot, id)),
  );

  const toArchive = allEntries.filter(
    (e) => e.status === "orphaned" && isOlderThanDays(e.updatedAt, maxDays),
  );

  if (toArchive.length === 0) {
    return {
      total: allEntries.length,
      archived: 0,
      skipped: allEntries.length,
      archivedEntries: [],
      dryRun,
    };
  }

  if (dryRun) {
    return {
      total: allEntries.length,
      archived: toArchive.length,
      skipped: allEntries.length - toArchive.length,
      archivedEntries: toArchive,
      dryRun,
    };
  }

  await ensureKodelaDir(repoRoot);
  const archiveDir = path.join(repoRoot, KODELA_DIR, ARCHIVES_DIR);
  await fs.mkdir(archiveDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(archiveDir, `${timestamp}.json`);

  const archiveData = {
    schemaVersion: SCHEMA_VERSION,
    archivedAt: new Date().toISOString(),
    entries: toArchive,
  };

  await fs.writeFile(archivePath, JSON.stringify(archiveData, null, 2) + "\n", "utf-8");

  const actor = process.env["KODELA_AUTHOR"] ?? process.env["GIT_AUTHOR_NAME"] ?? "unknown";

  for (const entry of toArchive) {
    await deleteContextEntry(repoRoot, entry.id);
  }

  const license = await loadLicense(repoRoot);
  const orgId = license?.orgId;
  if (orgId) {
    for (const entry of toArchive) {
      void recordCliEvent(
        {
          eventType: "context_archived",
          actor,
          orgId,
          filePath: entry.filePath,
          entryId: entry.id,
          metadata: { status: entry.status, updatedAt: entry.updatedAt },
        },
        repoRoot,
      );
    }
  }

  return {
    total: allEntries.length,
    archived: toArchive.length,
    skipped: allEntries.length - toArchive.length,
    archivedEntries: toArchive,
    dryRun,
    archivePath: path.relative(repoRoot, archivePath),
  };
}

export function formatArchiveResult(result: ArchiveResult): string {
  const prefix = result.dryRun ? "[DRY RUN] " : "";

  if (result.archived === 0) {
    return `${prefix}No entries eligible for archival (orphaned > ${90} days old).`;
  }

  const lines = [
    `${prefix}Archived ${result.archived} entr${result.archived !== 1 ? "ies" : "y"} (of ${result.total} total).`,
  ];

  if (result.archivePath) {
    lines.push(`  Written to .kodela/${result.archivePath}`);
  }

  if (result.archivedEntries.length > 0) {
    lines.push("");
    lines.push("Archived entries:");
    for (const e of result.archivedEntries) {
      lines.push(`  ${e.filePath}:${e.lineRange.start}-${e.lineRange.end} — "${e.note.slice(0, 60)}"`);
    }
  }

  return lines.join("\n");
}
