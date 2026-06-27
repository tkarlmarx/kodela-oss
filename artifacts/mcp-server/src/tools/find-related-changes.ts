// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_find_related_changes` MCP tool (07 §3.8).
 *
 * Given any anchor node, find related nodes across the memory graph.
 *
 *   - all          → direct neighbors (incoming + outgoing edges).
 *   - caused-by    → what caused this (outgoing CAUSED_BY).
 *   - caused       → what this caused (incoming CAUSED_BY).
 *   - co-changed   → for a file_change anchor, other FILE_CHANGEs produced by
 *                    the same AI_SESSION (2-hop via PRODUCED).
 *   - co-authored  → for a file_change anchor, other FILE_CHANGEs annotated by
 *                    the same USER (2-hop via ANNOTATED_BY).
 *
 * Results are scored by edge confidence (min along the path for 2-hop),
 * deduped keeping the highest score, and capped at `limit`.
 */

import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  outgoingEdges,
  incomingEdges,
  type GraphNodeType,
} from "../lib/graph-store.js";
import { getDecision } from "../lib/decisions-store.js";
import { resolveDecisionDb, DECISION_DB_UNAVAILABLE } from "../lib/lazy-index.js";

// ── Input schema ─────────────────────────────────────────────────────────────

const ANCHOR_NODE: Record<string, GraphNodeType> = {
  file_change: "FILE_CHANGE",
  decision: "DECISION",
  ticket: "TICKET",
  incident: "INCIDENT",
  commit: "COMMIT",
  pr: "PULL_REQUEST",
};

export const FindRelatedChangesInputSchema = z.object({
  anchor: z.object({
    type: z.enum(["file_change", "decision", "ticket", "incident", "commit", "pr"]),
    id: z.string().min(1),
  }),
  relation: z
    .enum(["co-authored", "co-changed", "caused-by", "caused", "all"])
    .default("all"),
  limit: z.number().int().positive().max(100).default(20),
});

export type FindRelatedChangesToolInput = z.infer<typeof FindRelatedChangesInputSchema>;

// ── Output ───────────────────────────────────────────────────────────────────

interface RelatedItem {
  kind: string;
  id: string;
  relation: string;
  score: number;
  summary: string;
}

export interface FindRelatedChangesResult {
  ok: boolean;
  related?: RelatedItem[];
  meta?: { anchor_type: string; relation: string; notes: string[] };
  error?: string;
}

function summarize(db: DatabaseSync, nodeType: GraphNodeType, nodeId: string): string {
  if (nodeType === "DECISION") {
    const d = getDecision(db, nodeId);
    return d ? d.decision.title : nodeId;
  }
  if (nodeType === "FILE_CHANGE") {
    const row = db
      .prepare("SELECT file_path FROM entries WHERE id = ?")
      .get(nodeId) as { file_path?: string } | undefined;
    return row?.file_path ?? nodeId;
  }
  return nodeId;
}

export function findRelatedChangesForMcp(
  repoRoot: string,
  input: FindRelatedChangesToolInput,
  db: DatabaseSync | null,
): FindRelatedChangesResult {
  const handle = resolveDecisionDb(repoRoot, db, "find-related-changes");
  if (handle === null) {
    return { ok: false, error: DECISION_DB_UNAVAILABLE };
  }

  const anchorType = ANCHOR_NODE[input.anchor.type];
  const anchorId = input.anchor.id;
  const notes: string[] = [];
  // Dedup keeping highest score.
  const found = new Map<string, RelatedItem>();

  const add = (
    nodeType: GraphNodeType,
    nodeId: string,
    relation: string,
    score: number,
  ) => {
    if (nodeType === anchorType && nodeId === anchorId) return; // skip self
    const key = `${nodeType}:${nodeId}`;
    const prev = found.get(key);
    if (prev && prev.score >= score) return;
    found.set(key, {
      kind: nodeType.toLowerCase(),
      id: nodeId,
      relation,
      score: Number(score.toFixed(4)),
      summary: summarize(handle, nodeType, nodeId),
    });
  };

  try {
    if (input.relation === "all") {
      for (const e of outgoingEdges(handle, anchorType, anchorId)) {
        add(e.target_node_type, e.target_node_id, e.edge_type.toLowerCase(), e.confidence);
      }
      for (const e of incomingEdges(handle, anchorType, anchorId)) {
        add(e.source_node_type, e.source_node_id, e.edge_type.toLowerCase(), e.confidence);
      }
    } else if (input.relation === "caused-by") {
      for (const e of outgoingEdges(handle, anchorType, anchorId, { edgeTypes: ["CAUSED_BY"] })) {
        add(e.target_node_type, e.target_node_id, "caused-by", e.confidence);
      }
    } else if (input.relation === "caused") {
      for (const e of incomingEdges(handle, anchorType, anchorId, { edgeTypes: ["CAUSED_BY"] })) {
        add(e.source_node_type, e.source_node_id, "caused", e.confidence);
      }
    } else if (input.relation === "co-changed" || input.relation === "co-authored") {
      if (anchorType !== "FILE_CHANGE") {
        notes.push(`${input.relation} only applies to a file_change anchor.`);
      } else {
        // Hop 1: anchor FILE_CHANGE → hub (AI_SESSION via PRODUCED, or USER via ANNOTATED_BY).
        const hubs =
          input.relation === "co-changed"
            ? incomingEdges(handle, "FILE_CHANGE", anchorId, { edgeTypes: ["PRODUCED"] }).map(
                (e) => ({ type: e.source_node_type, id: e.source_node_id, conf: e.confidence }),
              )
            : outgoingEdges(handle, "FILE_CHANGE", anchorId, { edgeTypes: ["ANNOTATED_BY"] }).map(
                (e) => ({ type: e.target_node_type, id: e.target_node_id, conf: e.confidence }),
              );
        for (const hub of hubs) {
          // Hop 2: hub → other FILE_CHANGEs.
          const siblings =
            input.relation === "co-changed"
              ? outgoingEdges(handle, hub.type, hub.id, { edgeTypes: ["PRODUCED"] }).map((e) => ({
                  type: e.target_node_type,
                  id: e.target_node_id,
                  conf: e.confidence,
                }))
              : incomingEdges(handle, hub.type, hub.id, { edgeTypes: ["ANNOTATED_BY"] }).map(
                  (e) => ({ type: e.source_node_type, id: e.source_node_id, conf: e.confidence }),
                );
          for (const sib of siblings) {
            if (sib.type !== "FILE_CHANGE") continue;
            add(sib.type, sib.id, input.relation, Math.min(hub.conf, sib.conf));
          }
        }
      }
    }

    const related = [...found.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit);

    return {
      ok: true,
      related,
      meta: { anchor_type: input.anchor.type, relation: input.relation, notes },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Response formatter ───────────────────────────────────────────────────────

export function formatFindRelatedChangesResponse(result: FindRelatedChangesResult): string {
  if (!result.ok) {
    return JSON.stringify({ ok: false, error: result.error }, null, 2);
  }
  return JSON.stringify(
    {
      ok: true,
      type: "kodela.related_changes",
      version: "1.0",
      related: result.related,
      meta: result.meta,
    },
    null,
    2,
  );
}
