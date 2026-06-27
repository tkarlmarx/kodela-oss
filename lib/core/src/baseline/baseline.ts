// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  readBaseline,
  writeBaseline,
  ensureKodelaDir,
  KODELA_DIR,
} from "../storage/storage.js";
import { guardPath } from "../storage/path-guard.js";
import { buildAstFingerprint, isAstLayerApplicable } from "../engine/ast-layer.js";
import {
  BaselineAlreadyExistsError,
} from "../errors.js";
import { SCHEMA_VERSION } from "../schema/index.js";
import type { BaselineFile } from "../schema/index.js";
import {
  validateRepoRoot,
  InitBaselineOptionsSchema,
} from "../validation.js";

const FS_CONCURRENCY_LIMIT = 16;

async function withBoundedConcurrency<T>(
  items: readonly string[],
  concurrency: number,
  fn: (item: string) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]!);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

export type BaselineCreatedEvent = {
  type: "BaselineCreated";
  repoRoot: string;
  trackedFileCount: number;
  createdAt: string;
  alreadyExisted: boolean;
};

export type InitBaselineOptions = {
  force?: boolean;
  fileGlobs?: string[];
};

const DEFAULT_IGNORE_PATTERNS: RegExp[] = [
  /node_modules/,
  /\.git\//,
  /\.kodela\//,
  /dist\//,
  /build\//,
  /coverage\//,
  /\.next\//,
  /\.nuxt\//,
];

function shouldIgnore(filePath: string): boolean {
  return DEFAULT_IGNORE_PATTERNS.some((p) => p.test(filePath));
}

async function collectSourceFiles(repoRoot: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent<string>[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf-8" });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(repoRoot, fullPath).replace(/\\/g, "/");

      if (shouldIgnore(relPath)) continue;

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        results.push(relPath);
      }
    }
  }

  await walk(repoRoot);
  return results;
}

async function hashFileContent(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

async function buildAstFingerprintForFile(filePath: string): Promise<string> {
  if (!isAstLayerApplicable(filePath)) return "";
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return buildAstFingerprint(content);
  } catch {
    return "";
  }
}

export async function initBaseline(
  repoRoot: string,
  options: InitBaselineOptions = {},
): Promise<BaselineCreatedEvent> {
  validateRepoRoot(repoRoot);
  InitBaselineOptionsSchema.parse(options);

  const existing = await readBaseline(repoRoot);

  if (existing !== null && options.force !== true) {
    return {
      type: "BaselineCreated",
      repoRoot,
      trackedFileCount: Object.keys(existing.trackedFiles).length,
      createdAt: existing.createdAt,
      alreadyExisted: true,
    };
  }

  await ensureKodelaDir(repoRoot);

  const sourceFiles = await collectSourceFiles(repoRoot);
  const trackedFiles: BaselineFile["trackedFiles"] = {};

  await withBoundedConcurrency(
    sourceFiles,
    FS_CONCURRENCY_LIMIT,
    async (relPath) => {
      const absPath = guardPath(repoRoot, relPath);
      try {
        const [contentHash, astFingerprint] = await Promise.all([
          hashFileContent(absPath),
          buildAstFingerprintForFile(absPath),
        ]);
        trackedFiles[relPath] = { contentHash, astFingerprint };
      } catch {
        // Skip files that can't be read (e.g., binary files)
      }
    },
  );

  const createdAt = new Date().toISOString();

  const baseline: BaselineFile = {
    schemaVersion: SCHEMA_VERSION,
    createdAt,
    trackedFiles,
  };

  await writeBaseline(repoRoot, baseline);

  return {
    type: "BaselineCreated",
    repoRoot,
    trackedFileCount: Object.keys(trackedFiles).length,
    createdAt,
    alreadyExisted: false,
  };
}

export async function isBaselineInitialized(repoRoot: string): Promise<boolean> {
  validateRepoRoot(repoRoot);
  const baseline = await readBaseline(repoRoot);
  return baseline !== null;
}

export async function getBaseline(
  repoRoot: string,
): Promise<BaselineFile | null> {
  validateRepoRoot(repoRoot);
  return readBaseline(repoRoot);
}

export { BaselineAlreadyExistsError };
