// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
const KNOWN_MODULE_SEGMENTS: ReadonlySet<string> = new Set([
  "auth",
  "authentication",
  "billing",
  "payment",
  "payments",
  "security",
  "crypto",
  "cryptography",
  "credentials",
  "tokens",
  "secrets",
  "api",
  "db",
  "database",
  "config",
  "configuration",
  "utils",
  "helpers",
  "services",
  "models",
  "controllers",
  "routes",
  "middleware",
  "hooks",
  "components",
  "pages",
  "views",
  "tests",
  "engine",
  "storage",
  "baseline",
  "schema",
  "watcher",
  "diff",
  "cli",
  "core",
]);

/**
 * Detect the logical module name for a file path.
 *
 * Strategy:
 * 1. Walk path segments left-to-right; return the first segment that matches
 *    a known module name (case-insensitive).
 * 2. Fallback: return the immediate parent directory name.
 * 3. If no parent directory exists (file is at root), return "root".
 *
 * The result is always lowercase.
 */
export function detectModule(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");

  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (KNOWN_MODULE_SEGMENTS.has(lower)) {
      return lower;
    }
  }

  const parentIndex = segments.length - 2;
  if (parentIndex >= 0 && segments[parentIndex] !== "") {
    return segments[parentIndex].toLowerCase();
  }

  return "root";
}
