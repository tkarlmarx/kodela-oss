// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Sprint 3 / [E.13] — Community detection tests.
 *
 * Strategy: build small synthetic ContextGraph instances with known
 * structure and assert the detector recovers it.  Doesn't go through
 * buildGraph (which is import-detection-driven) — passes a hand-built
 * ContextGraph directly so the test stays focused on the algorithm.
 *
 * Coverage:
 *   1. Empty graph → empty result.
 *   2. Two cleanly-separated cliques (A-B-C with all internal edges;
 *      D-E-F with all internal edges; ONE bridge edge C-D) → exactly two
 *      communities, with positive modularity.
 *   3. Disconnected nodes (no edges) → every node lands in its own
 *      singleton community.
 *   4. Algorithm field is "louvain" (not "leiden") — load-bearing for the
 *      honest-labelling discipline.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { detectCommunities } from "./communities.js";
import type { ContextGraph, GraphNode, GraphEdge } from "./graph.js";

function fileNode(id: string, p: string): GraphNode {
  return { kind: "file", id, path: p };
}

function buildGraph(nodes: GraphNode[], edges: GraphEdge[]): ContextGraph {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  return { nodes: nodeMap, edges };
}

describe("detectCommunities — empty + degenerate inputs", () => {
  test("empty graph returns empty result with modularity 0", () => {
    const result = detectCommunities({ nodes: new Map(), edges: [] });
    assert.equal(result.communityCount, 0);
    assert.equal(result.communities.length, 0);
    assert.equal(result.modularity, 0);
    assert.equal(result.algorithm, "louvain");
  });

  test("disconnected nodes — every node lands in its own community", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => fileNode(id, `src/${id}.ts`));
    const result = detectCommunities(buildGraph(nodes, []));
    assert.equal(result.communityCount, 4);
    for (const c of result.communities) assert.equal(c.nodeIds.length, 1);
  });
});

describe("detectCommunities — two cleanly-separated cliques", () => {
  test("recovers the two communities with positive modularity", () => {
    const nodes: GraphNode[] = [
      fileNode("A", "src/auth/a.ts"),
      fileNode("B", "src/auth/b.ts"),
      fileNode("C", "src/auth/c.ts"),
      fileNode("D", "src/billing/d.ts"),
      fileNode("E", "src/billing/e.ts"),
      fileNode("F", "src/billing/f.ts"),
    ];
    const edges: GraphEdge[] = [
      // Clique 1: A-B-C fully connected
      { kind: "dependency", from: "A", to: "B" },
      { kind: "dependency", from: "B", to: "C" },
      { kind: "dependency", from: "A", to: "C" },
      // Clique 2: D-E-F fully connected
      { kind: "dependency", from: "D", to: "E" },
      { kind: "dependency", from: "E", to: "F" },
      { kind: "dependency", from: "D", to: "F" },
      // Single bridge between the two cliques
      { kind: "dependency", from: "C", to: "D" },
    ];

    const result = detectCommunities(buildGraph(nodes, edges));
    assert.equal(result.communityCount, 2, "expected exactly two communities");
    assert.ok(
      result.modularity > 0.2,
      `modularity must be clearly positive for separable structure, got ${result.modularity}`,
    );

    // A, B, C must end up in one community; D, E, F in the other.
    const idOf = (n: string) =>
      result.communities.find((c) => c.nodeIds.includes(n))?.id ?? -1;
    assert.equal(idOf("A"), idOf("B"));
    assert.equal(idOf("B"), idOf("C"));
    assert.equal(idOf("D"), idOf("E"));
    assert.equal(idOf("E"), idOf("F"));
    assert.notEqual(idOf("A"), idOf("D"));
  });
});

describe("detectCommunities — output shape contract", () => {
  test("sampleNodes carry kind + label for navigation", () => {
    const nodes: GraphNode[] = [
      fileNode("A", "src/auth/a.ts"),
      fileNode("B", "src/auth/b.ts"),
    ];
    const edges: GraphEdge[] = [
      { kind: "dependency", from: "A", to: "B" },
    ];
    const result = detectCommunities(buildGraph(nodes, edges));
    assert.ok(result.communities.length >= 1);
    const sample = result.communities[0]!.sampleNodes[0]!;
    assert.equal(sample.kind, "file");
    assert.ok(sample.label.includes("src/auth/"), `label missing path: ${sample.label}`);
  });
});

describe("detectCommunities — algorithm provenance", () => {
  test("reports algorithm: 'louvain' (NOT 'leiden') so consumers can tell", () => {
    const nodes: GraphNode[] = [fileNode("X", "x.ts")];
    const result = detectCommunities(buildGraph(nodes, []));
    assert.equal(result.algorithm, "louvain");
  });
});
