// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Fused-graph traversal (internal design note).
 *
 * The decision/session graph and the code-structure graph share one edge store
 * (`graph_edges`). Once a FILE_CHANGE entry is linked to the CODE_FUNCTION nodes
 * it touched (via `edgesForCodeFunctions`), a single query can start at a
 * function and traverse the *why* behind it:
 *
 *   CODE_FUNCTION ←CONTAINS_FUNCTION— FILE_CHANGE
 *                                       ├─ ←PRODUCED— AI_SESSION
 *                                       ├─ —IMPLEMENTS→ DECISION ─┐
 *                                       └─ direct → PR / INCIDENT  │
 *                                          DECISION → PR / ← INCIDENT
 *
 * This answers "what decision (and which session, PR, incident) is behind this
 * risky function?" — the traversal no competitor can backfill after the fact.
 * Open-core (Apache-2.0): pure reads over the shared edge store.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  codeFunctionNodeId,
  incomingEdges,
  outgoingEdges,
} from "./graph-store.js";

export interface FunctionContextEntry {
  entryId: string;
  sessions: string[];
  decisions: string[];
  pullRequests: string[];
  incidents: string[];
}

export interface FunctionContext {
  functionNodeId: string;
  filePath: string;
  astAnchor: string;
  /** Per FILE_CHANGE entry that touched this function. */
  entries: FunctionContextEntry[];
  /** De-duplicated rollups across all entries. */
  sessions: string[];
  decisions: string[];
  pullRequests: string[];
  incidents: string[];
}

/**
 * Resolve the fused context behind a single function. `astAnchor` is the
 * stable `<kind>:<name>` id (matching CodeGraphFunction.ast_anchor); together
 * with `filePath` it forms the CODE_FUNCTION node id.
 */
export function fuseFunctionContext(
  db: DatabaseSync,
  input: { filePath: string; astAnchor: string; minConfidence?: number },
): FunctionContext {
  const functionNodeId = codeFunctionNodeId(input.filePath, input.astAnchor);
  const minConfidence = input.minConfidence ?? 0;

  const sessions = new Set<string>();
  const decisions = new Set<string>();
  const pullRequests = new Set<string>();
  const incidents = new Set<string>();
  const entries: FunctionContextEntry[] = [];

  // Hop 1: the FILE_CHANGE entries that touched this function.
  const containing = incomingEdges(db, "CODE_FUNCTION", functionNodeId, {
    edgeTypes: ["CONTAINS_FUNCTION"],
    minConfidence,
  });

  for (const c of containing) {
    const entryId = c.source_node_id;

    // Hop 2a: the session that produced the entry.
    const entrySessions = incomingEdges(db, "FILE_CHANGE", entryId, {
      edgeTypes: ["PRODUCED"],
      minConfidence,
    }).map((e) => e.source_node_id);

    // Hop 2b: the decision(s) the entry implements.
    const entryDecisions = outgoingEdges(db, "FILE_CHANGE", entryId, {
      edgeTypes: ["IMPLEMENTS"],
      minConfidence,
    }).map((e) => e.target_node_id);

    // Hop 3: PRs / incidents — directly off the entry, and via its decisions.
    const entryPrs = new Set<string>();
    const entryIncidents = new Set<string>();
    for (const e of outgoingEdges(db, "FILE_CHANGE", entryId, { minConfidence })) {
      if (e.target_node_type === "PULL_REQUEST") entryPrs.add(e.target_node_id);
      if (e.target_node_type === "INCIDENT") entryIncidents.add(e.target_node_id);
    }
    for (const decId of entryDecisions) {
      for (const e of outgoingEdges(db, "DECISION", decId, { minConfidence })) {
        if (e.target_node_type === "PULL_REQUEST") entryPrs.add(e.target_node_id);
        if (e.target_node_type === "INCIDENT") entryIncidents.add(e.target_node_id);
      }
      for (const e of incomingEdges(db, "DECISION", decId, { minConfidence })) {
        if (e.source_node_type === "PULL_REQUEST") entryPrs.add(e.source_node_id);
        if (e.source_node_type === "INCIDENT") entryIncidents.add(e.source_node_id);
      }
    }

    entrySessions.forEach((s) => sessions.add(s));
    entryDecisions.forEach((d) => decisions.add(d));
    entryPrs.forEach((p) => pullRequests.add(p));
    entryIncidents.forEach((i) => incidents.add(i));

    entries.push({
      entryId,
      sessions: entrySessions,
      decisions: entryDecisions,
      pullRequests: [...entryPrs],
      incidents: [...entryIncidents],
    });
  }

  return {
    functionNodeId,
    filePath: input.filePath,
    astAnchor: input.astAnchor,
    entries,
    sessions: [...sessions],
    decisions: [...decisions],
    pullRequests: [...pullRequests],
    incidents: [...incidents],
  };
}
