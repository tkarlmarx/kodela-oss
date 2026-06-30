// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Auto-exclude rules for git-diff enforcement.
 *
 * Files matching these patterns are excluded from annotation enforcement —
 * they legitimately don't need per-file context entries. Lock files,
 * generated code, vendored deps, and Kodela's own storage are all excluded.
 *
 * Uses a simple pattern matcher (no minimatch dependency) that supports
 * four glob shapes (escaped with HTML entities here because the literal
 * sequence "&#42;&#47;" closes a JSDoc block):
 *   - "&#42;&#42;/&lt;name&gt;" — matches filename anywhere in the tree
 *   - "&lt;dir&gt;/&#42;&#42;" — matches everything inside a directory
 *   - "&#42;.&lt;ext&gt;"     — matches file extension
 *   - Exact path                — matches the literal path
 */

import fs from "node:fs";
import path from "node:path";

// ── Built-in exclusion patterns ───────────────────────────────────────────────

const AUTO_EXCLUDE_PATTERNS: string[] = [
  // Lock files (exact filenames, anywhere in tree)
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/go.sum",

  // Generated directories
  "dist/**",
  "build/**",
  "out/**",
  ".next/**",
  "coverage/**",
  "node_modules/**",

  // Generated files
  "*.generated.ts",
  "*.generated.js",
  "*.gen.go",
  "*.d.ts",

  // Vendored
  "vendor/**",

  // Kodela's own storage
  ".kodela/**",

  // Common config files that rarely need explanation
  "**/.gitignore",
  "**/.gitattributes",
  "**/.editorconfig",
];

// ── Pattern matching ──────────────────────────────────────────────────────────

/**
 * Simple glob-like matcher. Supports four shapes (entities used because
 * literal "&#42;&#47;" closes a JSDoc comment):
 *   "&#42;&#42;/&lt;name&gt;" — filename match anywhere
 *   "&lt;dir&gt;/&#42;&#42;" — directory prefix match
 *   "&#42;.&lt;ext&gt;"     — extension match
 *   "&lt;exact&gt;"          — exact path match
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  // `**/<name>` — match filename anywhere in tree
  if (pattern.startsWith("**/")) {
    const name = pattern.slice(3);
    // If name contains no wildcards, match as filename or suffix
    if (!name.includes("*")) {
      return filePath.endsWith("/" + name) || filePath === name;
    }
    // `**/*.<ext>` — extension match anywhere
    if (name.startsWith("*.")) {
      const ext = name.slice(1); // ".ext"
      return filePath.endsWith(ext);
    }
    return false;
  }

  // `<dir>/**` — everything inside a directory
  if (pattern.endsWith("/**")) {
    const dir = pattern.slice(0, -3);
    return filePath.startsWith(dir + "/") || filePath === dir;
  }

  // `*.<ext>` — extension match (root level)
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1); // ".ext"
    return filePath.endsWith(ext);
  }

  // Exact match
  return filePath === pattern;
}

function isAutoExcluded(filePath: string): boolean {
  return AUTO_EXCLUDE_PATTERNS.some((pattern) => matchesPattern(filePath, pattern));
}

// ── .kodelaignore loader ──────────────────────────────────────────────────────

/**
 * Load .kodelaignore patterns from the repo root.
 * Returns a matcher function. If the file doesn't exist, returns a no-op.
 *
 * .kodelaignore uses the same pattern syntax as the auto-exclude list above.
 * Lines starting with # are comments. Empty lines are skipped.
 */
function loadKodelaIgnorePatterns(repoRoot: string): string[] {
  const ignorePath = path.join(repoRoot, ".kodelaignore");
  try {
    const content = fs.readFileSync(ignorePath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function isKodelaIgnored(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(filePath, pattern));
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface PartitionResult {
  /** Files that require annotation — enforcement applies to these. */
  enforced: string[];
  /** Files excluded by built-in auto-exclude rules. */
  autoExcluded: string[];
  /** Files excluded by .kodelaignore patterns. */
  kodelaIgnored: string[];
}

/**
 * Partition a list of changed file paths into enforced vs excluded.
 *
 * @param filePaths - All files detected as changed by git
 * @param repoRoot - Repo root for loading .kodelaignore
 */
export function partitionFiles(
  filePaths: string[],
  repoRoot: string,
): PartitionResult {
  const kodelaIgnorePatterns = loadKodelaIgnorePatterns(repoRoot);

  const enforced: string[] = [];
  const autoExcluded: string[] = [];
  const kodelaIgnored: string[] = [];

  for (const p of filePaths) {
    if (isAutoExcluded(p)) {
      autoExcluded.push(p);
    } else if (isKodelaIgnored(p, kodelaIgnorePatterns)) {
      kodelaIgnored.push(p);
    } else {
      enforced.push(p);
    }
  }

  return { enforced, autoExcluded, kodelaIgnored };
}
