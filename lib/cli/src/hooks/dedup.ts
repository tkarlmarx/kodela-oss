// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 52 — Hook Event Idempotency Guard
 *
 * Claude's PostToolUse hook can fire multiple times for the same file within
 * one session (e.g. Claude writes a file, then writes it again with a fix).
 * This guard prevents duplicate ContextEntry creation for the same
 * (sessionId, filePath, lineRange, day) combination.
 *
 * Storage: `.kodela/hook-dedup.json` — a flat object mapping dedup key →
 * ISO timestamp when the entry was recorded. Rotated (truncated) when it
 * exceeds MAX_DEDUP_ENTRIES.
 *
 * The dedup file is created lazily and never throws — all errors are
 * absorbed so hook processing never interrupts the developer workflow.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const KODELA_DIR = ".kodela";
const DEDUP_FILE = "hook-dedup.json";
const MAX_DEDUP_ENTRIES = 500;

function dedupFilePath(repoRoot: string): string {
  return path.join(repoRoot, KODELA_DIR, DEDUP_FILE);
}

/**
 * Compute a stable deduplication key for a hook event.
 *
 * Key inputs:
 *   - sessionId     — Claude session identifier
 *   - filePath      — repository-relative file path
 *   - lineStart     — start line (0 when no line range)
 *   - lineEnd       — end line (0 when no line range)
 *   - dayISO        — ISO-8601 date (YYYY-MM-DD) — resets daily
 */
export function computeDedupKey(
  sessionId: string,
  filePath: string,
  lineStart: number,
  lineEnd: number,
  dayISO: string,
): string {
  return createHash("sha256")
    .update(`${sessionId}\x00${filePath}\x00${lineStart}\x00${lineEnd}\x00${dayISO}`)
    .digest("hex");
}

/**
 * Read the current dedup map from disk.
 * Returns an empty object if the file does not exist or cannot be parsed.
 */
async function readDedupMap(
  repoRoot: string,
): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(dedupFilePath(repoRoot), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Write the dedup map to disk atomically.
 * Rotates (truncates oldest entries) when the map exceeds MAX_DEDUP_ENTRIES.
 * Silently swallows I/O errors.
 */
async function writeDedupMap(
  repoRoot: string,
  map: Record<string, string>,
): Promise<void> {
  try {
    const keys = Object.keys(map);
    let trimmed = map;
    if (keys.length > MAX_DEDUP_ENTRIES) {
      // Keep the most recent MAX_DEDUP_ENTRIES entries by insertion order
      const keep = keys.slice(keys.length - MAX_DEDUP_ENTRIES);
      trimmed = Object.fromEntries(keep.map((k) => [k, map[k]!]));
    }

    const tmpPath = dedupFilePath(repoRoot) + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(trimmed, null, 2), "utf-8");
    await fs.rename(tmpPath, dedupFilePath(repoRoot));
  } catch {
    // Silently ignore — dedup failures should never interrupt hook processing
  }
}

/**
 * Return `true` if this event has already been processed (key is in the dedup
 * map), `false` otherwise. Always returns `false` on I/O error.
 */
export async function checkDedup(
  repoRoot: string,
  key: string,
): Promise<boolean> {
  const map = await readDedupMap(repoRoot);
  return key in map;
}

/**
 * Record a dedup key as processed.
 * Creates `.kodela/hook-dedup.json` if it does not exist.
 * Silently swallows I/O errors.
 */
export async function recordDedup(
  repoRoot: string,
  key: string,
): Promise<void> {
  const map = await readDedupMap(repoRoot);
  map[key] = new Date().toISOString();
  await writeDedupMap(repoRoot, map);
}
