// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Utility helpers for iterating over all ContextEntry objects in a repository.
 */

import { readIndex, readContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";

/**
 * Return all ContextEntry objects stored in the repository.
 *
 * Entries that fail to load are silently skipped so a single corrupt entry
 * does not abort batch operations.
 */
export async function listAllEntries(repoRoot: string): Promise<ContextEntry[]> {
  let index: { entries: string[] };
  try {
    index = await readIndex(repoRoot);
  } catch {
    return [];
  }

  const results: ContextEntry[] = [];
  for (const id of index.entries) {
    try {
      const entry = await readContextEntry(repoRoot, id);
      results.push(entry);
    } catch {
      // Skip corrupt or missing entries
    }
  }
  return results;
}
