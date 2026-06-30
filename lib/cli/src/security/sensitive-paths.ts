// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Checks whether a relative file path matches any security-sensitive path pattern.
 *
 * Patterns are plain string segments:
 *   - Prefix match: "auth/" matches "auth/login.ts" and "src/auth/session.ts"
 *   - Substring match: any segment appearance in the path
 *
 * This is intentionally simple — no full glob engine needed for path segment matching.
 */
export function isSensitivePath(
  filePath: string,
  patterns: string[],
): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  for (const pattern of patterns) {
    const p = pattern.replace(/\\/g, "/").toLowerCase();
    if (normalized.includes(p)) return true;
  }
  return false;
}

/**
 * Returns the list of matching sensitive patterns for a given file path.
 * Useful for generating informative tags.
 */
export function matchingSensitivePaths(
  filePath: string,
  patterns: string[],
): string[] {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return patterns.filter((p) =>
    normalized.includes(p.replace(/\\/g, "/").toLowerCase()),
  );
}
