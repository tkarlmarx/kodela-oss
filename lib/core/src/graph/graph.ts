// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 40 — Context Graph Engine
 *
 * Builds a lightweight in-memory graph over a repository's `.kodela/` context
 * entries. Nodes represent files, annotated functions, and context annotations;
 * edges represent containment, AST references, and import-level dependencies.
 *
 * All construction and query functions are pure or operate only on local files —
 * no network I/O, no database access.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { readIndex, readContextEntry } from "../storage/index.js";
import type { AstAnchor, ContextEntry, LineRange } from "../schema/context-entry.schema.js";

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

export type FileNode = {
  kind: "file";
  id: string;
  /** Repo-relative path, e.g. "src/auth/login.ts" */
  path: string;
};

export type FunctionNode = {
  kind: "function";
  id: string;
  filePath: string;
  name: string;
  astAnchor: AstAnchor & { kind: "function" | "method" | "class" | "block" };
};

export type ContextNode = {
  kind: "context";
  id: string;
  /** The backing ContextEntry UUID */
  entryId: string;
  filePath: string;
  lineRange: LineRange;
  source: ContextEntry["source"];
  severity: ContextEntry["severity"];
  status: ContextEntry["status"];
  /** Gap 48 — content drift level (absent on pre-Gap-48 entries). */
  contentDrift?: ContextEntry["contentDrift"];
  /** ISO-8601 timestamp */
  createdAt: string;
  /** ISO-8601 timestamp */
  updatedAt: string;
};

export type GraphNode = FileNode | FunctionNode | ContextNode;

// ---------------------------------------------------------------------------
// Edge types
// ---------------------------------------------------------------------------

export type ContainsEdge = { kind: "contains"; from: string; to: string };
export type ReferenceEdge = { kind: "reference"; from: string; to: string };
export type DependencyEdge = { kind: "dependency"; from: string; to: string };

export type GraphEdge = ContainsEdge | ReferenceEdge | DependencyEdge;

// ---------------------------------------------------------------------------
// Graph container
// ---------------------------------------------------------------------------

export type ContextGraph = {
  /** All nodes keyed by their unique `id`. */
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
};

// ---------------------------------------------------------------------------
// Import-analysis helpers (regex-based, no AST parser required)
// ---------------------------------------------------------------------------

const TS_JS_IMPORT_RE =
  /(?:import\s+(?:[^'"]+from\s+)?|require\s*\(\s*)['"](\.[^'"]+)['"]/g;

const PYTHON_IMPORT_RE =
  /^\s*(?:from\s+(\.+\S+)\s+import|import\s+(\.+\S+))/gm;

/**
 * Extract all relative import paths from a source file's text.
 * Returns repo-relative paths; non-relative imports are ignored.
 */
function extractImports(filePath: string, source: string): string[] {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const results: string[] = [];

  const re = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)
    ? TS_JS_IMPORT_RE
    : PYTHON_IMPORT_RE;

  re.lastIndex = 0;
  for (const m of source.matchAll(re)) {
    const raw = m[1] ?? m[2];
    if (!raw) continue;

    const resolved = path.normalize(path.join(dir, raw));
    results.push(resolved);
  }

  return results;
}

/**
 * Attempt to find the actual file on disk for a resolved import path,
 * trying common TypeScript/JS extensions when the path has none.
 */
async function resolveImportPath(
  repoRoot: string,
  importedPath: string,
): Promise<string | null> {
  const candidates =
    path.extname(importedPath) !== ""
      ? [importedPath]
      : [
          importedPath,
          `${importedPath}.ts`,
          `${importedPath}.tsx`,
          `${importedPath}.js`,
          `${importedPath}.jsx`,
          `${importedPath}/index.ts`,
          `${importedPath}/index.js`,
        ];

  for (const candidate of candidates) {
    const abs = path.isAbsolute(candidate)
      ? candidate
      : path.join(repoRoot, candidate);
    try {
      await fs.access(abs);
      return path.relative(repoRoot, abs);
    } catch {
      // not found — try next candidate
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/**
 * Build a `ContextGraph` from all `.kodela/` context entries in `repoRoot`.
 *
 * Steps:
 *  1. Read every `ContextEntry` from `.kodela/entries/`.
 *  2. Create a `FileNode` for every distinct `filePath`.
 *  3. Create a `FunctionNode` for every entry with a non-null `astAnchor`.
 *  4. Create a `ContextNode` for every entry.
 *  5. Add `contains` edges: file→function, file→context.
 *  6. Add `reference` edges: context→function (when they share astAnchor).
 *  7. Parse `import` statements in each source file, add `dependency` edges.
 */
export async function buildGraph(repoRoot: string): Promise<ContextGraph> {
  const graph: ContextGraph = {
    nodes: new Map(),
    edges: [],
  };

  const index = await readIndex(repoRoot);
  const allEntries = await Promise.all(
    index.entries.map((id) =>
      readContextEntry(repoRoot, id).catch(() => null),
    ),
  );
  const entries = allEntries.filter((e): e is ContextEntry => e !== null);

  const fileNodes = new Map<string, FileNode>();
  const functionNodes = new Map<string, FunctionNode>();

  for (const entry of entries) {
    // --- File node ---
    if (!fileNodes.has(entry.filePath)) {
      const fn: FileNode = {
        kind: "file",
        id: `file:${entry.filePath}`,
        path: entry.filePath,
      };
      fileNodes.set(entry.filePath, fn);
      graph.nodes.set(fn.id, fn);
    }

    // --- Function node (when astAnchor present) ---
    if (entry.astAnchor !== null) {
      const anchor = entry.astAnchor;
      const fnId = `fn:${entry.filePath}:${anchor.name}:${anchor.blockHash}`;
      if (!functionNodes.has(fnId)) {
        const fn: FunctionNode = {
          kind: "function",
          id: fnId,
          filePath: entry.filePath,
          name: anchor.name,
          astAnchor: anchor,
        };
        functionNodes.set(fnId, fn);
        graph.nodes.set(fnId, fn);
      }
    }

    // --- Context node ---
    const ctxId = `ctx:${entry.id}`;
    const ctxNode: ContextNode = {
      kind: "context",
      id: ctxId,
      entryId: entry.id,
      filePath: entry.filePath,
      lineRange: entry.lineRange,
      source: entry.source,
      severity: entry.severity,
      status: entry.status,
      ...(entry.contentDrift ? { contentDrift: entry.contentDrift } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    graph.nodes.set(ctxId, ctxNode);
  }

  // --- Containment and reference edges ---
  for (const entry of entries) {
    const fileId = `file:${entry.filePath}`;
    const ctxId = `ctx:${entry.id}`;

    // file → context
    graph.edges.push({ kind: "contains", from: fileId, to: ctxId });

    if (entry.astAnchor !== null) {
      const anchor = entry.astAnchor;
      const fnId = `fn:${entry.filePath}:${anchor.name}:${anchor.blockHash}`;

      // file → function
      if (!graph.edges.some((e) => e.kind === "contains" && e.from === fileId && e.to === fnId)) {
        graph.edges.push({ kind: "contains", from: fileId, to: fnId });
      }

      // context → function
      graph.edges.push({ kind: "reference", from: ctxId, to: fnId });
    }
  }

  // --- Import dependency edges ---
  const uniqueFilePaths = [...fileNodes.keys()];

  await Promise.allSettled(
    uniqueFilePaths.map(async (relPath) => {
      const absPath = path.join(repoRoot, relPath);
      let src: string;
      try {
        src = await fs.readFile(absPath, "utf-8");
      } catch {
        return;
      }

      const importedPaths = extractImports(relPath, src);

      await Promise.allSettled(
        importedPaths.map(async (importedRel) => {
          const resolved = await resolveImportPath(repoRoot, importedRel);
          if (!resolved) return;

          const fromId = `file:${relPath}`;
          const toId = `file:${resolved}`;

          if (
            graph.nodes.has(toId) &&
            !graph.edges.some(
              (e) => e.kind === "dependency" && e.from === fromId && e.to === toId,
            )
          ) {
            graph.edges.push({ kind: "dependency", from: fromId, to: toId });
          }
        }),
      );
    }),
  );

  return graph;
}

// ---------------------------------------------------------------------------
// Query functions (pure — no I/O)
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Return all file nodes that have at least one connected context node whose
 * severity is >= `threshold`. A file "has" a context node when a `contains`
 * edge runs from the file to a context node.
 *
 * Typical use: find files in auth/, payments/, or crypto/ that have unreviewed
 * high/critical annotations.
 */
export function findRiskyModules(
  graph: ContextGraph,
  threshold: "critical" | "high" | "medium" | "low" = "high",
): FileNode[] {
  const thresholdRank = SEVERITY_RANK[threshold] ?? 3;
  const riskyFileIds = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.kind !== "contains") continue;
    const target = graph.nodes.get(edge.to);
    if (target?.kind !== "context") continue;
    if ((SEVERITY_RANK[target.severity] ?? 0) >= thresholdRank) {
      riskyFileIds.add(edge.from);
    }
  }

  return [...riskyFileIds]
    .map((id) => graph.nodes.get(id))
    .filter((n): n is FileNode => n?.kind === "file");
}

/**
 * Return all context nodes that are either:
 *  - `status === "orphaned"` (their code has changed since annotation), or
 *  - older than `maxAgeDays` days without being updated.
 *
 * Sorted oldest-first (most urgent to resolve).
 */
export function findOutdatedContext(
  graph: ContextGraph,
  maxAgeDays: number = 90,
): ContextNode[] {
  const cutoffMs = Date.now() - maxAgeDays * 86_400_000;
  const results: ContextNode[] = [];

  for (const node of graph.nodes.values()) {
    if (node.kind !== "context") continue;
    const isOrphaned = node.status === "orphaned";
    const isStale = new Date(node.updatedAt).getTime() < cutoffMs;
    // Gap 48 — also include entries with high content drift.
    const hasHighDrift = node.contentDrift === "high";
    if (isOrphaned || isStale || hasHighDrift) {
      results.push(node);
    }
  }

  return results.sort(
    (a, b) =>
      new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
  );
}

/**
 * Return file nodes sorted by the number of inbound `dependency` edges
 * (i.e. how many other files in the repo import them). High-impact files
 * are the ones most likely to cause ripple effects when changed.
 */
export function findHighImpactFiles(graph: ContextGraph): FileNode[] {
  const inboundCount = new Map<string, number>();

  for (const edge of graph.edges) {
    if (edge.kind !== "dependency") continue;
    inboundCount.set(edge.to, (inboundCount.get(edge.to) ?? 0) + 1);
  }

  return [...graph.nodes.values()]
    .filter((n): n is FileNode => n.kind === "file")
    .filter((n) => (inboundCount.get(n.id) ?? 0) > 0)
    .sort(
      (a, b) =>
        (inboundCount.get(b.id) ?? 0) - (inboundCount.get(a.id) ?? 0),
    );
}

// ---------------------------------------------------------------------------
// Serialisation helpers (for REST / CLI JSON output)
// ---------------------------------------------------------------------------

export type SerializedGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  summary: {
    fileCount: number;
    functionCount: number;
    contextCount: number;
    dependencyEdgeCount: number;
    containsEdgeCount: number;
    referenceEdgeCount: number;
  };
};

/**
 * Convert a `ContextGraph` to a plain JSON-serialisable object.
 * Suitable for REST responses and `kodela graph --output json`.
 */
export function serializeGraph(graph: ContextGraph): SerializedGraph {
  const nodes = [...graph.nodes.values()];
  return {
    nodes,
    edges: graph.edges,
    summary: {
      fileCount: nodes.filter((n) => n.kind === "file").length,
      functionCount: nodes.filter((n) => n.kind === "function").length,
      contextCount: nodes.filter((n) => n.kind === "context").length,
      dependencyEdgeCount: graph.edges.filter((e) => e.kind === "dependency").length,
      containsEdgeCount: graph.edges.filter((e) => e.kind === "contains").length,
      referenceEdgeCount: graph.edges.filter((e) => e.kind === "reference").length,
    },
  };
}
