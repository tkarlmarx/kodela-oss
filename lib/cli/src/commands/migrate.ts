// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { readIndex, KODELA_DIR } from "@kodela/core";

export interface MigrateOptions {
  repoRoot: string;
  dryRun?: boolean;
}

export interface MigrateResult {
  entriesScanned: number;
  sheetsCreated: number;
  alreadySharded: number;
  errors: string[];
  dryRun: boolean;
}

function shardDir(repoRoot: string, id: string): string {
  const shard = id.slice(0, 2);
  return path.join(repoRoot, KODELA_DIR, "objects", shard);
}

function shardedObjectPath(repoRoot: string, id: string): string {
  const safeId = id.replace(/[^a-f0-9-]/gi, "");
  const shard = safeId.slice(0, 2);
  return path.join(repoRoot, KODELA_DIR, "objects", shard, `${safeId}.json`);
}

function flatObjectPath(repoRoot: string, id: string): string {
  const safeId = id.replace(/[^a-f0-9-]/gi, "");
  return path.join(repoRoot, KODELA_DIR, "objects", `${safeId}.json`);
}

export async function runMigrate(opts: MigrateOptions): Promise<MigrateResult> {
  const { repoRoot, dryRun = false } = opts;

  const index = await readIndex(repoRoot);
  const errors: string[] = [];
  let sheetsCreated = 0;
  let alreadySharded = 0;

  for (const id of index.entries) {
    const flatPath = flatObjectPath(repoRoot, id);
    const shardedPath = shardedObjectPath(repoRoot, id);

    const flatExists = await fs.access(flatPath).then(() => true).catch(() => false);
    const shardedExists = await fs.access(shardedPath).then(() => true).catch(() => false);

    if (shardedExists) {
      alreadySharded += 1;
      continue;
    }

    if (!flatExists) {
      errors.push(`Entry ${id}: flat object file not found at ${flatPath}`);
      continue;
    }

    if (!dryRun) {
      try {
        const dir = shardDir(repoRoot, id);
        await fs.mkdir(dir, { recursive: true });
        const content = await fs.readFile(flatPath, "utf-8");
        const tmpPath = `${shardedPath}.${Math.random().toString(36).slice(2)}.tmp`;
        await fs.writeFile(tmpPath, content, "utf-8");
        await fs.rename(tmpPath, shardedPath);
        await fs.unlink(flatPath);
        sheetsCreated += 1;
      } catch (err) {
        errors.push(`Entry ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      sheetsCreated += 1;
    }
  }

  return {
    entriesScanned: index.entries.length,
    sheetsCreated,
    alreadySharded,
    errors,
    dryRun,
  };
}

export function formatMigrateResult(result: MigrateResult): string {
  const lines: string[] = [];
  const mode = result.dryRun ? " (dry run)" : "";
  lines.push(`\nKodela Storage Migration${mode}`);
  lines.push(`  Entries scanned:   ${result.entriesScanned}`);
  lines.push(`  Already sharded:   ${result.alreadySharded}`);
  lines.push(`  Shards created:    ${result.sheetsCreated}`);

  if (result.errors.length > 0) {
    lines.push(`  Errors (${result.errors.length}):`);
    for (const e of result.errors) {
      lines.push(`    - ${e}`);
    }
  }

  if (result.dryRun) {
    lines.push("\nRun without --dry-run to apply changes.");
  }

  return lines.join("\n");
}
