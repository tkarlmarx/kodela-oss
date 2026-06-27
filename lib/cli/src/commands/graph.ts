// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 40 — `kodela graph` command
 *
 * Builds the context graph for the current repository and answers one of three
 * structural queries:
 *
 *   risky-modules     — files with high/critical AI annotations
 *   outdated-context  — orphaned or stale annotations (> N days)
 *   high-impact       — files with the most inbound import dependencies
 *
 * Exits non-zero when the query returns results (usable as a CI gate).
 */

import {
  buildGraph,
  findRiskyModules,
  findOutdatedContext,
  findHighImpactFiles,
  serializeGraph,
} from "@kodela/core";
import type { GraphNode, SerializedGraph, CommunityDetectionResult } from "@kodela/core";
import { detectCommunities } from "@kodela/core";

export type GraphQuery =
  | "risky-modules"
  | "outdated-context"
  | "high-impact"
  | "communities"
  | "all";

export type GraphOptions = {
  repoRoot: string;
  query: GraphQuery;
  /** For risky-modules: minimum severity (default "high"). */
  threshold?: "critical" | "high" | "medium" | "low";
  /** For outdated-context: max age in days (default 90). */
  maxAgeDays?: number;
  output?: "text" | "json";
};

export type GraphResult = {
  query: GraphQuery;
  nodes: GraphNode[];
  /** Full serialised graph (only present when query === "all"). */
  full?: SerializedGraph;
  /** Community-detection result (only present when query === "communities"). */
  communities?: CommunityDetectionResult;
  /** Non-zero when the query found results (useful as a CI gate exit code). */
  exitCode: number;
};

export async function runGraph(opts: GraphOptions): Promise<GraphResult> {
  const { repoRoot, query, threshold = "high", maxAgeDays = 90 } = opts;

  const graph = await buildGraph(repoRoot);

  if (query === "all") {
    const full = serializeGraph(graph);
    return { query, nodes: full.nodes, full, exitCode: 0 };
  }

  if (query === "communities") {
    // Sprint 3 / [E.13] — Louvain community detection over the fused
    // contains + dependency + reference edges. Auto-labeling and the
    // MemoryGraphSigma rendering are owed in a follow-up.
    const communities = detectCommunities(graph);
    // Return the sample-node IDs as the `nodes` slice so the existing
    // text/json formatter has something to print without a new path.
    const sampleNodeIds = new Set(
      communities.communities.flatMap((c) => c.sampleNodes.map((s) => s.id)),
    );
    const nodes = [...graph.nodes.values()].filter((n) => sampleNodeIds.has(n.id));
    return { query, nodes, communities, exitCode: communities.communityCount > 0 ? 0 : 0 };
  }

  let nodes: GraphNode[];

  switch (query) {
    case "risky-modules":
      nodes = findRiskyModules(graph, threshold);
      break;
    case "outdated-context":
      nodes = findOutdatedContext(graph, maxAgeDays);
      break;
    case "high-impact":
      nodes = findHighImpactFiles(graph);
      break;
    default:
      nodes = [];
  }

  return {
    query,
    nodes,
    exitCode: nodes.length > 0 ? 1 : 0,
  };
}

export function formatGraphResult(result: GraphResult, output: "text" | "json"): string {
  if (output === "json") {
    const payload = result.full
      ? result.full
      : result.communities
        ? { query: result.query, ...result.communities }
        : { query: result.query, nodes: result.nodes, count: result.nodes.length };
    return JSON.stringify(payload, null, 2);
  }

  if (result.communities) {
    const lines: string[] = [];
    const c = result.communities;
    lines.push(
      `Communities (${c.communityCount}) — algorithm: ${c.algorithm}, modularity: ${c.modularity.toFixed(3)}`,
    );
    for (const com of c.communities) {
      lines.push(`  · #${com.id} — ${com.nodeIds.length} nodes`);
      for (const s of com.sampleNodes) {
        lines.push(`      ${s.kind.padEnd(8)} ${s.label}`);
      }
    }
    return lines.join("\n");
  }

  const lines: string[] = [];

  if (result.full) {
    const s = result.full.summary;
    lines.push("Context Graph Summary");
    lines.push(`  Files:             ${s.fileCount}`);
    lines.push(`  Functions:         ${s.functionCount}`);
    lines.push(`  Context nodes:     ${s.contextCount}`);
    lines.push(`  Contains edges:    ${s.containsEdgeCount}`);
    lines.push(`  Reference edges:   ${s.referenceEdgeCount}`);
    lines.push(`  Dependency edges:  ${s.dependencyEdgeCount}`);
    return lines.join("\n");
  }

  const QUERY_LABELS: Record<GraphQuery, string> = {
    "risky-modules": "Risky modules",
    "outdated-context": "Outdated / orphaned context",
    "high-impact": "High-impact files",
    communities: "Communities (Louvain)",
    all: "Full graph",
  };

  lines.push(`${QUERY_LABELS[result.query]} (${result.nodes.length})`);

  if (result.nodes.length === 0) {
    lines.push("  (none found)");
    return lines.join("\n");
  }

  for (const node of result.nodes) {
    switch (node.kind) {
      case "file":
        lines.push(`  ${node.path}`);
        break;
      case "function":
        lines.push(`  ${node.filePath} → ${node.name}()`);
        break;
      case "context":
        lines.push(
          `  ${node.filePath}:${node.lineRange.start}-${node.lineRange.end}` +
            ` [${node.status}] [${node.severity}] updated ${node.updatedAt.split("T")[0]}`,
        );
        break;
    }
  }

  return lines.join("\n");
}
