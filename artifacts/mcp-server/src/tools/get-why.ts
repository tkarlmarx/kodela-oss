// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_get_why` MCP tool (07 §3.7, algorithm doc 04 §6.4) — the headline
 * "why is this code here?" lookup.
 *
 * Algorithm:
 *   1. Find FILE_CHANGE nodes for the file (entries.id via queryEntries).
 *   2. BFS outward over edges IMPLEMENTS|BELONGS_TO|RELEASED_IN|CAUSED_BY|
 *      MOTIVATES, up to max_depth (default 3), min_edge_confidence (default 0.6).
 *   3. Collect DECISION nodes reached, keeping the highest confidence-product path.
 *   4. Rank by (edge-confidence-product × recency), recency decaying on the
 *      decision's decided_at.
 *
 * MVP scope: file-level. line_range is accepted but not yet applied — line
 * ranges live in the object JSON, not the SQLite index, so line filtering would
 * cost a disk read per entry; deferred. The traversal uses a bounded iterative
 * BFS (not a recursive CTE): far easier to verify at our edge scale, and the
 * CTE's payoff only appears at Postgres/10M-edge scale.
 *
 * Honest limitation: today the only edge reaching a DECISION from a FILE_CHANGE
 * is FILE_CHANGE—IMPLEMENTS→DECISION, created when annotate_file is called with
 * linked_decision_ids (or a decision is recorded with an `entry` link). So
 * get_why returns decisions only for files that have been linked; deeper chains
 * (via COMMIT/RELEASE/INCIDENT) light up as Phase-3 webhook ingestion lands.
 */

import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { queryEntries } from "@kodela/core";
import {
  outgoingEdges,
  type GraphEdgeType,
  type GraphNodeType,
} from "../lib/graph-store.js";
import { getDecision } from "../lib/decisions-store.js";
import { resolveDecisionDb, DECISION_DB_UNAVAILABLE } from "../lib/lazy-index.js";

/** Edge allow-list for the get_why traversal (internal design note). */
const WHY_EDGE_TYPES: GraphEdgeType[] = [
  "IMPLEMENTS",
  "BELONGS_TO",
  "RELEASED_IN",
  "CAUSED_BY",
  "MOTIVATES",
];

// ── Input schema ─────────────────────────────────────────────────────────────

export const GetWhyInputSchema = z.object({
  file_path: z.string().min(1),
  line_range: z
    .object({ start: z.number().int().min(1), end: z.number().int().min(1) })
    .optional()
    .describe("Accepted but not yet applied — MVP is file-level"),
  scope: z
    .object({ org_id: z.string().optional(), repo_id: z.string().optional() })
    .optional(),
  include_intermediate_evidence: z.boolean().default(true),
  max_depth: z.number().int().positive().max(6).default(3),
  min_edge_confidence: z.number().min(0).max(1).default(0.6),
  as_of: z
    .string()
    .optional()
    .describe(
      "ISO timestamp — bi-temporal filter (internal design note): return only decisions that were valid as of this point (decided by then and not yet superseded).",
    ),
});

export type GetWhyToolInput = z.infer<typeof GetWhyInputSchema>;

// ── Output ───────────────────────────────────────────────────────────────────

interface EvidenceStep {
  step: number;
  node_type: string;
  node_id: string;
  edge_type: string;
  confidence: number;
}

interface WhyItem {
  decision_id: string;
  title: string;
  reason_excerpt: string;
  confidence: number;
  evidence_chain?: EvidenceStep[];
}

export interface GetWhyResult {
  ok: boolean;
  file_path?: string;
  why?: WhyItem[];
  meta?: { edges_traversed: number; query_ms: number; entries_found: number; notes: string[] };
  error?: string;
}

/** Recency weight in [0,1], decaying on age in days (half-ish over a year). */
function recencyWeight(decidedAt: string, nowMs: number): number {
  const t = Date.parse(decidedAt);
  if (Number.isNaN(t)) return 0.5;
  const ageDays = Math.max(0, (nowMs - t) / 86_400_000);
  return 1 / (1 + ageDays / 365);
}

interface Frontier {
  nodeType: GraphNodeType;
  nodeId: string;
  conf: number;
  chain: EvidenceStep[];
}

export function getWhyForMcp(
  repoRoot: string,
  input: GetWhyToolInput,
  db: DatabaseSync | null,
): GetWhyResult {
  const startMs = Date.now();
  const handle = resolveDecisionDb(repoRoot, db, "get-why");
  if (handle === null) {
    return { ok: false, error: DECISION_DB_UNAVAILABLE };
  }

  const notes: string[] = [];
  if (input.line_range) {
    notes.push("line_range ignored — MVP is file-level.");
  }

  // Bi-temporal cutoff (internal design note): NaN means "no temporal filter".
  let asOfMs = NaN;
  if (input.as_of) {
    asOfMs = Date.parse(input.as_of);
    if (Number.isNaN(asOfMs)) {
      notes.push(`as_of "${input.as_of}" not parseable — temporal filter ignored.`);
    } else {
      notes.push(`temporal: decisions valid as of ${input.as_of}.`);
    }
  }

  try {
    // 1. FILE_CHANGE start nodes for the file.
    const entryIds = queryEntries(handle, { filePath: input.file_path }).map((r) => r.id);

    // 2. BFS outward.
    const visited = new Set<string>();
    let frontier: Frontier[] = entryIds.map((id) => {
      visited.add(`FILE_CHANGE:${id}`);
      return { nodeType: "FILE_CHANGE" as GraphNodeType, nodeId: id, conf: 1, chain: [] };
    });

    const best = new Map<string, { conf: number; chain: EvidenceStep[] }>();
    let edgesTraversed = 0;

    for (let depth = 1; depth <= input.max_depth && frontier.length > 0; depth++) {
      const next: Frontier[] = [];
      for (const node of frontier) {
        const edges = outgoingEdges(handle, node.nodeType, node.nodeId, {
          edgeTypes: WHY_EDGE_TYPES,
          minConfidence: input.min_edge_confidence,
        });
        for (const edge of edges) {
          edgesTraversed++;
          const conf = node.conf * edge.confidence;
          const chain: EvidenceStep[] = [
            ...node.chain,
            {
              step: depth,
              node_type: edge.target_node_type,
              node_id: edge.target_node_id,
              edge_type: edge.edge_type,
              confidence: edge.confidence,
            },
          ];
          if (edge.target_node_type === "DECISION") {
            const prev = best.get(edge.target_node_id);
            if (!prev || conf > prev.conf) {
              best.set(edge.target_node_id, { conf, chain });
            }
          }
          const key = `${edge.target_node_type}:${edge.target_node_id}`;
          if (!visited.has(key)) {
            visited.add(key);
            next.push({
              nodeType: edge.target_node_type,
              nodeId: edge.target_node_id,
              conf,
              chain,
            });
          }
        }
      }
      frontier = next;
    }

    // 3. Hydrate + rank by confidence-product × recency(decided_at).
    const nowMs = Date.now();
    const why: WhyItem[] = [];
    for (const [decisionId, { conf, chain }] of best) {
      const dec = getDecision(handle, decisionId);
      if (!dec) continue; // dangling edge — decision deleted

      // Bi-temporal validity: the decision must have existed by `as_of` AND not
      // yet been superseded by then (the superseding decision's decided_at is
      // when the old one stopped being current).
      if (!Number.isNaN(asOfMs)) {
        if (Date.parse(dec.decision.decided_at) > asOfMs) continue;
        const supId = dec.decision.superseded_by;
        if (supId) {
          const sup = getDecision(handle, supId);
          if (sup && Date.parse(sup.decision.decided_at) <= asOfMs) continue;
        }
      }

      const recency = recencyWeight(dec.decision.decided_at, nowMs);
      const reason = dec.decision.reason;
      why.push({
        decision_id: decisionId,
        title: dec.decision.title,
        reason_excerpt: reason.length > 200 ? reason.slice(0, 200) + "…" : reason,
        confidence: Number((conf * recency).toFixed(4)),
        evidence_chain: input.include_intermediate_evidence ? chain : undefined,
      });
    }
    why.sort((a, b) => b.confidence - a.confidence);

    if (entryIds.length === 0) {
      notes.push("no FILE_CHANGE entries indexed for this file.");
    } else if (why.length === 0) {
      notes.push(
        "file has annotations but no decision links — annotate_file with " +
        "linked_decision_ids to connect it.",
      );
    }

    return {
      ok: true,
      file_path: input.file_path,
      why,
      meta: {
        edges_traversed: edgesTraversed,
        query_ms: Date.now() - startMs,
        entries_found: entryIds.length,
        notes,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Response formatter ───────────────────────────────────────────────────────

export function formatGetWhyResponse(result: GetWhyResult): string {
  if (!result.ok) {
    return JSON.stringify({ ok: false, error: result.error }, null, 2);
  }
  return JSON.stringify(
    {
      ok: true,
      type: "kodela.why",
      version: "1.0",
      file_path: result.file_path,
      why: result.why,
      meta: result.meta,
    },
    null,
    2,
  );
}
