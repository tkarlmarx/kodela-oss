// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { PathTraversalError } from "../errors.js";
import { validateFilePath, validateRepoRoot, RelativePathSchema } from "../validation.js";

export function guardPath(repoRoot: string, relativePath: string): string {
  validateRepoRoot(repoRoot);
  try {
    RelativePathSchema.parse(relativePath);
  } catch (err) {
    throw new PathTraversalError(
      `Invalid path argument: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const resolvedRoot = path.resolve(repoRoot);
  const resolved = path.resolve(repoRoot, relativePath);

  if (
    !resolved.startsWith(resolvedRoot + path.sep) &&
    resolved !== resolvedRoot
  ) {
    throw new PathTraversalError(
      `Path "${relativePath}" escapes the repository root "${resolvedRoot}". ` +
        `Resolved to: "${resolved}"`,
    );
  }

  return resolved;
}

export async function verifyNoSymlinkEscape(
  repoRoot: string,
  resolvedPath: string,
): Promise<void> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(repoRoot);
  } catch {
    realRoot = path.resolve(repoRoot);
  }

  let checkPath = resolvedPath;
  let realAncestor: string | undefined;

  while (checkPath !== path.dirname(checkPath)) {
    try {
      realAncestor = await fs.realpath(checkPath);
      break;
    } catch {
      checkPath = path.dirname(checkPath);
    }
  }

  if (realAncestor === undefined) {
    return;
  }

  if (
    !realAncestor.startsWith(realRoot + path.sep) &&
    realAncestor !== realRoot &&
    !realAncestor.startsWith(realRoot + path.sep)
  ) {
    throw new PathTraversalError(
      `Symlink escape detected: real path "${realAncestor}" is outside repo root "${realRoot}".`,
    );
  }
}

export function normalizeRepoPath(filePath: string): string {
  validateFilePath(filePath);
  return _normalizeRepoPath(filePath);
}

function _normalizeRepoPath(filePath: string): string {
  if (/(^|[/\\])\.\.(\/|\\|$)/.test(filePath)) {
    throw new PathTraversalError(
      `Path "${filePath}" contains directory traversal segments (..) and cannot be normalized.`,
    );
  }
  return filePath.replace(/\\/g, "/");
}

export function hashFilePath(filePath: string): string {
  validateFilePath(filePath);
  return createHash("sha256").update(_normalizeRepoPath(filePath)).digest("hex");
}
