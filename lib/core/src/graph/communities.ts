// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Sprint 3 / [E.13] — Community detection over the in-memory context graph.
 *
 * Honest scope:
 *   - Algorithm: Louvain (modularity-maximising greedy). Doc 17 / E.13 calls
 *     out "Leiden" specifically, but `graphology-leiden` is NOT on npm
 *     (verified 2026-06-26).  We ship the closest mature library —
 *     graphology-communities-louvain — and label the deliverable as Louvain.
 *     A Leiden swap requires a different library or a hand-rolled algorithm
 *     and is left as a follow-up so this ticket can ship truthfully.
 *   - Auto-labeling (LLM-driven naming of each community) and the
 *     MemoryGraphSigma rendering are both out of scope for this iteration;
 *     they belong to the dashboard layer and need an AI key respectively.
 *
 * Output shape is designed so the dashboard / CLI consumer can render
 * neighborhoods without knowing the algorithm:
 *   { communityCount, communities: [{ id, nodeIds, sampleNodes, modularity? }] }
 *
 * Edge weighting: all edges contribute weight 1.0 regardless of kind
 * (contains / dependency / reference).  Down-weighting `contains` would be
 * a tuning decision once we see how communities look on a real corpus.
 */

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { ContextGraph, GraphNode } from "./graph.js";

export type GraphCommunity = {
  /** Community ID assigned by Louvain (small integer). */
  id: number;
  /** All node IDs belonging to this community. */
  nodeIds: string[];
  /** Up to 5 representative node IDs (file / function names if available). */
  sampleNodes: { id: string; kind: GraphNode["kind"]; label: string }[];
};

export type CommunityDetectionResult = {
  communityCount: number;
  communities: GraphCommunity[];
  /** Whole-graph modularity score, higher = better-separated communities. */
  modularity: number;
  /** Algorithm used — distinct field so callers know it's Louvain, not Leiden. */
  algorithm: "louvain";
};

const SAMPLE_NODES_PER_COMMUNITY = 5;

/**
 * Run Louvain community detection over the ContextGraph.
 *
 * Empty graph → `{ communityCount: 0, communities: [], modularity: 0 }`.
 * A graph with zero edges → every node lands in its own singleton community.
 */
export function detectCommunities(graph: ContextGraph): CommunityDetectionResult {
  if (graph.nodes.size === 0) {
    return { communityCount: 0, communities: [], modularity: 0, algorithm: "louvain" };
  }

  const g = new Graph({ type: "undirected", multi: false, allowSelfLoops: false });

  for (const node of graph.nodes.values()) {
    g.addNode(node.id);
  }

  // Multi-edges between the same pair are collapsed; we just bump the weight.
  // (graphology requires multi: true to allow parallel edges, but Louvain reads
  // a single weight per pair anyway, so collapsing is the cheap correct thing.)
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue; // skip self-loops (allowSelfLoops: false would throw)
    if (!g.hasNode(edge.from) || !g.hasNode(edge.to)) continue;
    if (g.hasEdge(edge.from, edge.to)) {
      const w = (g.getEdgeAttribute(edge.from, edge.to, "weight") ?? 1) + 1;
      g.setEdgeAttribute(edge.from, edge.to, "weight", w);
    } else {
      g.addEdge(edge.from, edge.to, { weight: 1 });
    }
  }

  const assignment = louvain(g, { getEdgeWeight: "weight" });
  const detail = louvain.detailed(g, { getEdgeWeight: "weight" });

  const byCommunity = new Map<number, string[]>();
  for (const [nodeId, communityId] of Object.entries(assignment)) {
    const list = byCommunity.get(communityId) ?? [];
    list.push(nodeId);
    byCommunity.set(communityId, list);
  }

  const communities: GraphCommunity[] = [...byCommunity.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([id, nodeIds]) => ({
      id,
      nodeIds,
      sampleNodes: nodeIds
        .slice(0, SAMPLE_NODES_PER_COMMUNITY)
        .map((nid) => {
          const n = graph.nodes.get(nid);
          return {
            id: nid,
            kind: n?.kind ?? "file",
            label: nodeLabel(n),
          };
        }),
    }));

  return {
    communityCount: communities.length,
    communities,
    modularity: detail.modularity,
    algorithm: "louvain",
  };
}

function nodeLabel(node: GraphNode | undefined): string {
  if (!node) return "<unknown>";
  if (node.kind === "file") return node.path;
  if (node.kind === "function") return `${node.name}() — ${node.filePath}`;
  return `note L${node.lineRange.start} — ${node.filePath}`;
}
