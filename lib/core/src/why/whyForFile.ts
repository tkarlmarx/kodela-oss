// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * "Why is this file here?" — a pure BFS from a file's FILE_CHANGE nodes through
 * the memory graph to the DECISIONs that motivated it. Lives in core so the
 * server (shared-memory `/api/context/why`) and the local MCP path share ONE
 * traversal — no logic drift between "why local" and "why remote".
 *
 * Operates on plain arrays (entries + edges + decisions) so it works over an
 * in-memory materialisation of the org's Postgres graph exactly as it does over
 * the local index.
 */

/** Edge allow-list for the traversal (internal design note) — mirrors the MCP tool. */
export const WHY_EDGE_TYPES = [
  "IMPLEMENTS",
  "BELONGS_TO",
  "RELEASED_IN",
  "CAUSED_BY",
  "MOTIVATES",
] as const;

export interface WhyEntry {
  id: string;
  filePath: string;
}

export interface WhyEdge {
  edgeType: string;
  sourceNodeType: string;
  sourceNodeId: string;
  targetNodeType: string;
  targetNodeId: string;
  confidence: number;
}

export interface WhyDecision {
  id: string;
  title: string;
  reason: string;
  /** ISO timestamp the decision was decided. */
  decidedAt: string;
  /** Id of the decision that supersedes this one, if any. */
  supersededBy?: string | null;
}

export interface WhyEvidenceStep {
  step: number;
  nodeType: string;
  nodeId: string;
  edgeType: string;
  confidence: number;
}

export interface WhyItem {
  decisionId: string;
  title: string;
  reasonExcerpt: string;
  /** Blended confidence in (0,1] — product of the edge confidences on the path. */
  confidence: number;
  evidenceChain?: WhyEvidenceStep[];
}

export interface WhyForFileOptions {
  maxDepth?: number;
  minEdgeConfidence?: number;
  /** ISO timestamp — bi-temporal filter: only decisions decided by then and not superseded. */
  asOf?: string;
  includeEvidence?: boolean;
}

interface Frontier {
  nodeType: string;
  nodeId: string;
  conf: number;
  chain: WhyEvidenceStep[];
}

const nodeKey = (t: string, id: string) => `${t}:${id}`;

/**
 * Rank the DECISIONs reachable from `filePath`'s FILE_CHANGE nodes. Returns them
 * highest-confidence first. Pure + deterministic (confidence ties break by
 * decision id).
 */
export function whyForFile(
  filePath: string,
  entries: readonly WhyEntry[],
  edges: readonly WhyEdge[],
  decisions: readonly WhyDecision[],
  opts: WhyForFileOptions = {},
): WhyItem[] {
  const maxDepth = opts.maxDepth ?? 3;
  const minConf = opts.minEdgeConfidence ?? 0.6;
  const asOfMs = opts.asOf ? Date.parse(opts.asOf) : NaN;
  const allow = new Set<string>(WHY_EDGE_TYPES);

  // Adjacency: source node key → outgoing allowed edges above the confidence floor.
  const outgoing = new Map<string, WhyEdge[]>();
  for (const e of edges) {
    if (!allow.has(e.edgeType)) continue;
    if (e.confidence < minConf) continue;
    const k = nodeKey(e.sourceNodeType, e.sourceNodeId);
    const list = outgoing.get(k);
    if (list) list.push(e);
    else outgoing.set(k, [e]);
  }

  const decisionById = new Map(decisions.map((d) => [d.id, d]));

  // Start frontier: the file's FILE_CHANGE nodes (one per matching entry).
  const visited = new Set<string>();
  let frontier: Frontier[] = [];
  for (const entry of entries) {
    if (entry.filePath !== filePath) continue;
    const key = nodeKey("FILE_CHANGE", entry.id);
    if (visited.has(key)) continue;
    visited.add(key);
    frontier.push({ nodeType: "FILE_CHANGE", nodeId: entry.id, conf: 1, chain: [] });
  }

  const best = new Map<string, { conf: number; chain: WhyEvidenceStep[] }>();

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: Frontier[] = [];
    for (const node of frontier) {
      const edgesOut = outgoing.get(nodeKey(node.nodeType, node.nodeId)) ?? [];
      for (const edge of edgesOut) {
        const conf = node.conf * edge.confidence;
        const chain: WhyEvidenceStep[] = [
          ...node.chain,
          {
            step: depth,
            nodeType: edge.targetNodeType,
            nodeId: edge.targetNodeId,
            edgeType: edge.edgeType,
            confidence: edge.confidence,
          },
        ];
        if (edge.targetNodeType === "DECISION") {
          const prev = best.get(edge.targetNodeId);
          if (!prev || conf > prev.conf) best.set(edge.targetNodeId, { conf, chain });
        } else {
          const key = nodeKey(edge.targetNodeType, edge.targetNodeId);
          if (!visited.has(key)) {
            visited.add(key);
            next.push({ nodeType: edge.targetNodeType, nodeId: edge.targetNodeId, conf, chain });
          }
        }
      }
    }
    frontier = next;
  }

  const items: WhyItem[] = [];
  for (const [decisionId, { conf, chain }] of best) {
    const dec = decisionById.get(decisionId);
    if (!dec) continue;
    // Bi-temporal filter: skip decisions not yet decided as of `asOf`, or superseded.
    if (!Number.isNaN(asOfMs)) {
      const decidedMs = Date.parse(dec.decidedAt);
      if (!Number.isNaN(decidedMs) && decidedMs > asOfMs) continue;
      if (dec.supersededBy) continue;
    }
    const reason = dec.reason ?? "";
    const item: WhyItem = {
      decisionId,
      title: dec.title,
      reasonExcerpt: reason.length > 200 ? reason.slice(0, 200) + "…" : reason,
      confidence: conf,
    };
    if (opts.includeEvidence) item.evidenceChain = chain;
    items.push(item);
  }

  items.sort((a, b) => b.confidence - a.confidence || a.decisionId.localeCompare(b.decisionId));
  return items;
}
