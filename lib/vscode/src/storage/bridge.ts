// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readIndex,
  readContextEntry,
  writeContextEntry,
  deleteContextEntry,
} from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { loadConfig } from "@kodela/cli";
import type { KodelaConfig } from "@kodela/cli";

const execFileAsync = promisify(execFile);

export async function findRepoRoot(startDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: startDir, timeout: 5000 },
    );
    return stdout.trim();
  } catch {
    return startDir;
  }
}

export async function loadAllEntries(repoRoot: string): Promise<ContextEntry[]> {
  try {
    const index = await readIndex(repoRoot);
    return await Promise.all(
      index.entries.map((id) => readContextEntry(repoRoot, id)),
    );
  } catch (err: unknown) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code !== "ENOENT") {
      console.warn("[Kodela] Failed to load entries:", err);
    }
    return [];
  }
}

export async function saveEntry(
  repoRoot: string,
  entry: ContextEntry,
): Promise<void> {
  await writeContextEntry(repoRoot, entry);
}

export async function removeEntry(
  repoRoot: string,
  id: string,
): Promise<void> {
  await deleteContextEntry(repoRoot, id);
}

export async function loadWorkspaceConfig(
  repoRoot: string,
): Promise<KodelaConfig> {
  return loadConfig(repoRoot);
}
