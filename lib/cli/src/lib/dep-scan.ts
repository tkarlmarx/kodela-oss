// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Lightweight dependency-edge scanner shared by `kodela impact` and
 * `kodela architecture`.
 *
 * Walks the tracked JS/TS source, extracts relative import/require/dynamic-
 * import specifiers, and resolves them to tracked files — ESM-aware, so a
 * `./x.js` specifier resolves to `x.ts` when that is what exists. Returns forward
 * edges (importer → imported); callers derive whatever adjacency they need.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface DepEdge {
  from: string;
  to: string;
}

const JS_TS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IMPORT_RE =
  /(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]|(?:require|import)\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/** Resolve a relative specifier from `fromFile` to a tracked repo file. */
export function resolveImport(fromFile: string, spec: string, tracked: Set<string>): string | null {
  const baseDir = path.posix.dirname(fromFile);
  const joined = path.posix.normalize(path.posix.join(baseDir, spec));
  const candidates: string[] = [];
  const withoutJs = joined.replace(/\.(js|jsx|mjs|cjs)$/, "");
  if (JS_TS_EXT.test(joined)) candidates.push(joined);
  for (const ext of ["ts", "tsx", "js", "jsx", "mjs", "cjs"]) {
    candidates.push(`${withoutJs}.${ext}`);
    candidates.push(`${withoutJs}/index.${ext}`);
  }
  for (const c of candidates) if (tracked.has(c)) return c;
  return null;
}

/** Forward dependency edges (importer → imported) across tracked JS/TS source. */
export async function scanDependencyEdges(repoRoot: string): Promise<DepEdge[]> {
  let files: string[];
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
    files = stdout.split("\n").filter((f) => JS_TS_EXT.test(f));
  } catch {
    return [];
  }
  const tracked = new Set(files);
  const edges: DepEdge[] = [];
  for (const from of files) {
    let content: string;
    try {
      content = await fs.readFile(path.join(repoRoot, from), "utf8");
    } catch {
      continue;
    }
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(content)) !== null) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      const to = resolveImport(from, spec, tracked);
      if (to && to !== from) edges.push({ from, to });
    }
  }
  return edges;
}
