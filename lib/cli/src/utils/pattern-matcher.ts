// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import path from "node:path";

/**
 * Convert a gitignore-style pattern (relative to `repoRoot`) into a
 * predicate over absolute paths.
 *
 * Supported syntax:
 *  - `dir/`      → any path component named `dir`
 *  - `/file`     → anchored to repo root
 *  - `*.ext`     → basename wildcard
 *  - `a/**`      → everything inside directory `a`
 *  - exact names → matched anywhere in the path
 */
export function patternToMatcher(
  repoRoot: string,
  pattern: string,
): (absPath: string) => boolean {
  return (absPath: string) => {
    const rel = path.relative(repoRoot, absPath).replace(/\\/g, "/");

    if (pattern.endsWith("/")) {
      const dir = pattern.slice(0, -1);
      return rel === dir || rel.startsWith(dir + "/") || rel.includes("/" + dir + "/");
    }

    if (pattern.startsWith("/")) {
      const anchored = pattern.slice(1);
      return rel === anchored || rel.startsWith(anchored + "/");
    }

    if (pattern.includes("*")) {
      const regexSrc = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\./g, "\\.")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, ".*");
      const re = new RegExp("^" + regexSrc + "(/.*)?$");
      return re.test(rel);
    }

    return (
      rel === pattern ||
      rel.startsWith(pattern + "/") ||
      rel.endsWith("/" + pattern) ||
      rel.includes("/" + pattern + "/")
    );
  };
}

/**
 * Build an array of matcher predicates from an array of glob patterns.
 * Each predicate tests an absolute path against the pattern.
 */
export function buildMatchers(
  repoRoot: string,
  patterns: string[],
): Array<(absPath: string) => boolean> {
  return patterns.map((p) => patternToMatcher(repoRoot, p));
}
