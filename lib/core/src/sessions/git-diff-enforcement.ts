// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Git-diff enforcement helper.
 *
 * Given a baseline commit (captured at session_start), returns the list of
 * files that have changed in the working tree since that baseline. This is
 * the authoritative source for session_end enforcement — it replaces the
 * watcher as the primary signal for "what files need annotation."
 *
 * The watcher's data is preserved as a secondary signal but git is
 * authoritative for enforcement.
 */

import { execSync } from "node:child_process";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GitChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Returns the union of:
 *   1. Files changed in commits since baselineCommit (committed changes)
 *   2. Files changed in the working tree (staged + unstaged) vs HEAD
 *   3. New untracked files (respecting .gitignore)
 *
 * Deduplicates by path — if a file appears in multiple categories, the
 * first-seen status wins (committed > working tree > untracked).
 */
export function getFilesChangedSince(
  repoRoot: string,
  baselineCommit: string,
): GitChangedFile[] {
  const files = new Map<string, GitChangedFile>();

  // 1. Committed changes since baseline
  if (baselineCommit) {
    try {
      const output = execSync(
        `git diff --name-status ${baselineCommit} HEAD`,
        { cwd: repoRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      );
      for (const f of parseNameStatus(output)) {
        files.set(f.path, f);
      }
    } catch {
      // Baseline commit may have been garbage collected or is unreachable.
      // Fall through to working tree check.
    }
  }

  // 2. Working tree (staged + unstaged) vs HEAD
  try {
    const output = execSync(
      "git diff --name-status HEAD",
      { cwd: repoRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    for (const f of parseNameStatus(output)) {
      if (!files.has(f.path)) {
        files.set(f.path, f);
      }
    }
  } catch {
    // No HEAD yet (fresh repo with no commits). Tolerate.
  }

  // 3. Staged changes not yet in HEAD
  try {
    const output = execSync(
      "git diff --cached --name-status",
      { cwd: repoRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    for (const f of parseNameStatus(output)) {
      if (!files.has(f.path)) {
        files.set(f.path, f);
      }
    }
  } catch {
    // Tolerate.
  }

  // 4. Untracked files (respecting .gitignore)
  try {
    const output = execSync(
      "git ls-files --others --exclude-standard",
      { cwd: repoRoot, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    for (const line of output.split("\n").filter(Boolean)) {
      if (!files.has(line)) {
        files.set(line, { path: line, status: "untracked" });
      }
    }
  } catch {
    // Tolerate.
  }

  return [...files.values()];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseNameStatus(output: string): GitChangedFile[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const code = parts[0] ?? "";
      // For renames (R100\told\tnew), take the target (new) path
      const filePath = parts.length >= 3 ? parts[2]! : parts[1] ?? "";
      return { path: filePath, status: mapStatusCode(code) };
    })
    .filter((f) => f.path.length > 0);
}

function mapStatusCode(code: string): GitChangedFile["status"] {
  const first = code.charAt(0);
  if (first === "A") return "added";
  if (first === "M") return "modified";
  if (first === "D") return "deleted";
  if (first === "R") return "renamed";
  return "modified";
}
