// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { KODELA_DIR } from "@kodela/core";

export interface GcOptions {
  repoRoot: string;
  scope: "events" | "sessions" | "all";
  olderThanDays?: number;
  dryRun?: boolean;
}

export interface GcResult {
  filesRemoved: number;
  bytesFreed: number;
  errors: string[];
  dryRun: boolean;
}

function eventLogDir(repoRoot: string): string {
  return path.join(repoRoot, KODELA_DIR, "events");
}

function sessionDir(repoRoot: string): string {
  return path.join(repoRoot, KODELA_DIR, "sessions");
}

async function gcDirectory(
  dir: string,
  cutoffMs: number,
  dryRun: boolean,
): Promise<{ removed: number; bytesFreed: number; errors: string[] }> {
  let removed = 0;
  let bytesFreed = 0;
  const errors: string[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { removed, bytesFreed, errors };
  }

  for (const filename of entries) {
    if (!filename.endsWith(".json") && !filename.endsWith(".jsonl")) continue;

    const fullPath = path.join(dir, filename);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.mtimeMs < cutoffMs) {
        bytesFreed += stat.size;
        if (!dryRun) {
          await fs.unlink(fullPath);
        }
        removed += 1;
      }
    } catch (err) {
      errors.push(`${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { removed, bytesFreed, errors };
}

export async function runGc(opts: GcOptions): Promise<GcResult> {
  const { repoRoot, scope, olderThanDays = 90, dryRun = false } = opts;

  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  let totalRemoved = 0;
  let totalBytesFreed = 0;
  const allErrors: string[] = [];

  if (scope === "events" || scope === "all") {
    const evDir = eventLogDir(repoRoot);
    const { removed, bytesFreed, errors } = await gcDirectory(evDir, cutoffMs, dryRun);
    totalRemoved += removed;
    totalBytesFreed += bytesFreed;
    allErrors.push(...errors);
  }

  if (scope === "sessions" || scope === "all") {
    const sessDir = sessionDir(repoRoot);
    const { removed, bytesFreed, errors } = await gcDirectory(sessDir, cutoffMs, dryRun);
    totalRemoved += removed;
    totalBytesFreed += bytesFreed;
    allErrors.push(...errors);
  }

  return {
    filesRemoved: totalRemoved,
    bytesFreed: totalBytesFreed,
    errors: allErrors,
    dryRun,
  };
}

export function formatGcResult(result: GcResult, olderThanDays: number): string {
  const lines: string[] = [];
  const mode = result.dryRun ? " (dry run)" : "";
  lines.push(`\nKodela GC${mode} — entries older than ${olderThanDays} days`);
  lines.push(`  Files removed:  ${result.filesRemoved}`);
  lines.push(`  Space freed:    ${(result.bytesFreed / 1024).toFixed(1)} KiB`);

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
