// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 54 Phase C — `kodela://file/{path}` MCP resource
 *
 * Exposes the same context data as the `kodela_get_context` tool but as an
 * MCP resource so that hosts that prefer the resource model can access it.
 *
 * URI format:  kodela://file/<repo-relative-file-path>
 * Example:     kodela://file/src/auth/login.ts
 *
 * Returns up to 10 entries for the file (no line-range filtering) as JSON.
 */

import { getContext } from "../tools/get-context.js";
import type { EntryCache } from "../cache.js";

export type FileContextResourceOptions = {
  repoRoot: string;
  cache?: EntryCache;
};

export async function resolveFileContextResource(
  uriPath: string,
  opts: FileContextResourceOptions,
): Promise<string> {
  const { repoRoot, cache } = opts;

  const filePath = decodeURIComponent(uriPath.replace(/^\//, ""));

  const results = await getContext(
    repoRoot,
    {
      file_path: filePath,
      max_results: 10,
      include_reasoning: true,
    },
    cache,
  );

  return JSON.stringify({ filePath, entries: results }, null, 2);
}
