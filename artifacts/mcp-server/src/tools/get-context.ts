// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 54 Phase B — `kodela_get_context` MCP tool (Phase 4 upgrade: Gap 116)
 *
 * Queries Kodela's local `.kodela/` store and returns ranked context
 * annotations for a file or code region in a compact MCP-friendly payload.
 *
 * Gap 116: When a SQLite index is available (`.kodela/index.db`), the tool
 * calls `buildProjectContext()` to return cluster-first, scored, token-bounded
 * context in the canonical MCP envelope format. Falls back to the legacy
 * file-based path when no index is present.
 */

import { z } from "zod";
import {
  readMappingFile,
  readContextEntry,
  hashFilePath,
  buildProjectContext,
  queryEntries,
} from "@kodela/core";
import type {
  ContextEntry,
  ProjectContext,
  QueryContext,
} from "@kodela/core";
import type { DatabaseSync } from "node:sqlite";
import type { EntryCache } from "../cache.js";
import { getWhyForMcp } from "./get-why.js";

export const GetContextInputSchema = z.object({
  file_path: z.string().describe("Repo-relative file path"),
  line_start: z.number().int().positive().optional().describe("Start line (1-indexed)"),
  line_end: z.number().int().positive().optional().describe("End line (1-indexed)"),
  max_results: z.number().int().positive().default(5).describe("Maximum entries to return"),
  include_reasoning: z.boolean().default(true).describe("Include reasoning.intent in response"),
});

export type GetContextInput = z.infer<typeof GetContextInputSchema>;

export type ContextResult = {
  note: string;
  severity: string;
  status: string;
  confidence: number;
  lines: string;
  author: string;
  source: string;
  stale?: boolean;
  reasoning?: {
    intent: string;
    confidence: string;
  };
};

type ScoredEntry = {
  entry: ContextEntry;
  relevance: number;
};

/**
 * Compute overlap relevance score for an entry against a query region.
 *
 * 1.0  — entry line range overlaps [queryStart, queryEnd]
 * 0..1 — proximity-based score for non-overlapping entries on the same file
 * Entries with critical or high severity receive a small boost.
 */
function scoreRelevance(
  entry: ContextEntry,
  queryStart: number | undefined,
  queryEnd: number | undefined,
): number {
  const { start: entStart, end: entEnd } = entry.lineRange;

  let score = 0;

  if (queryStart !== undefined && queryEnd !== undefined) {
    const overlapStart = Math.max(entStart, queryStart);
    const overlapEnd = Math.min(entEnd, queryEnd);
    if (overlapStart <= overlapEnd) {
      score = 1.0;
    } else {
      const queryMid = (queryStart + queryEnd) / 2;
      const entryMid = (entStart + entEnd) / 2;
      const distance = Math.abs(queryMid - entryMid);
      score = Math.max(0, 0.5 - distance / 1000);
    }
  } else {
    score = 0.5;
  }

  if (entry.severity === "critical") score += 0.15;
  else if (entry.severity === "high") score += 0.1;

  return Math.min(score, 1.0);
}

function isStale(entry: ContextEntry): boolean {
  return (
    entry.status === "orphaned" ||
    ("contentDrift" in entry && (entry as { contentDrift?: string }).contentDrift === "high")
  );
}

function formatLines(entry: ContextEntry): string {
  const { start, end } = entry.lineRange;
  return start === end ? `${start}` : `${start}–${end}`;
}

function toContextResult(
  entry: ContextEntry,
  includeReasoning: boolean,
): ContextResult {
  const result: ContextResult = {
    note: entry.note,
    severity: entry.severity,
    status: entry.status,
    confidence: entry.confidence,
    lines: formatLines(entry),
    author: entry.author,
    source: entry.source,
  };

  if (isStale(entry)) {
    result.stale = true;
  }

  if (includeReasoning && entry.reasoning) {
    result.reasoning = {
      intent: entry.reasoning.intent,
      confidence: entry.reasoning.confidence,
    };
  }

  return result;
}

/**
 * Core query function — finds and ranks context entries for a file/region.
 * Uses the cache when available; falls back to disk reads.
 */
export async function getContext(
  repoRoot: string,
  input: GetContextInput,
  cache?: EntryCache,
): Promise<ContextResult[]> {
  const {
    file_path,
    line_start,
    line_end,
    max_results,
    include_reasoning,
  } = input;

  let entryIds: string[] = [];

  if (cache) {
    entryIds = cache.getEntryIdsForFile(file_path);
  } else {
    const mapping = await readMappingFile(repoRoot, file_path).catch(() => null);
    if (!mapping) return [];
    entryIds = mapping.mappings.map((m) => m.entryId);
  }

  if (entryIds.length === 0) return [];

  const scored: ScoredEntry[] = [];
  for (const id of entryIds) {
    let entry: ContextEntry;
    try {
      entry = cache
        ? (cache.getEntry(id) ?? (await readContextEntry(repoRoot, id)))
        : await readContextEntry(repoRoot, id);
    } catch {
      continue;
    }
    const relevance = scoreRelevance(entry, line_start, line_end);
    scored.push({ entry, relevance });
  }

  scored.sort((a, b) => b.relevance - a.relevance);
  const top = scored.slice(0, max_results);

  return top.map(({ entry }) => toContextResult(entry, include_reasoning));
}

export { hashFilePath };

// ── Gap 116 — Phase 4 cluster-aware retrieval ─────────────────────────────────

export const GetContextV4InputSchema = z.object({
  file_path: z.string().optional().describe("Repo-relative file path (e.g. src/auth/login.ts)"),
  intent: z.string().optional().describe("Intent hint — e.g. bugfix, refactor, new-file"),
  token_budget: z.number().int().positive().default(4000).describe("Maximum tokens to return (default 4000)"),
  as_of: z
    .string()
    .optional()
    .describe("ISO timestamp — fuse only decisions valid as of this point in time (internal design note)"),
});

export type GetContextV4Input = z.infer<typeof GetContextV4InputSchema>;

export type McpCluster = {
  id: string;
  label: string | null;
  version: number;
  files: string[];
  eventCount: number;
};

export type McpEntry = {
  id: string;
  file: string;
  scope: string | null;
  confidence: number;
  clusterId: string | null;
  sessionId: string | null;
  createdAt: string;
  /** Mapping status (mapped | uncertain | orphaned) — surfaced so the agent sees drift. */
  status?: string;
  /** True when the annotation no longer reliably matches the code (orphaned/uncertain). */
  stale?: boolean;
};

/**
 * A decision that shaped the queried file, fused in from the memory graph
 * (internal design note). Lets an agent get code context AND the "why" in one call.
 */
export type WhyDecision = {
  decision_id: string;
  title: string;
  reason_excerpt: string;
  confidence: number;
};

export type McpContextEnvelope = {
  type: "kodela.context";
  version: "1.0";
  context: {
    clusters: McpCluster[];
    entries: McpEntry[];
    /** Decisions that shaped the queried file (graph fusion). Omitted if none. */
    decisions?: WhyDecision[];
  };
  constraints: {
    tokenBudget: number;
    usedTokens: number;
  };
  meta: {
    totalCandidates: number;
    selectedClusters: number;
    selectedEntries: number;
    droppedEntries?: number;
    timingMs?: number;
  };
  warnings?: string[];
};

export function formatMcpResponse(
  context: ProjectContext,
  tokenBudget: number,
): McpContextEnvelope {
  const clusters: McpCluster[] = context.clusters.map((c) => ({
    id: c.id,
    label: c.goal ?? c.scope ?? null,
    version: c.version,
    files: c.filesChanged,
    eventCount: c.eventCount,
  }));

  const entries: McpEntry[] = [...context.entries].sort(
    (a, b) => b.confidence - a.confidence,
  ).map((e) => ({
    id: e.id,
    file: e.filePath,
    scope: e.scope,
    confidence: e.confidence,
    clusterId: e.clusterId,
    sessionId: e.sessionId,
    createdAt: e.createdAt,
  }));

  const envelope: McpContextEnvelope = {
    type: "kodela.context",
    version: "1.0",
    context: { clusters, entries },
    constraints: {
      tokenBudget,
      usedTokens: context.meta.tokenUsage,
    },
    meta: {
      totalCandidates: context.meta.totalCandidates,
      selectedClusters: context.meta.selectedClusters,
      selectedEntries: context.meta.selectedEntries,
    },
  };

  if (context.meta.droppedEntries !== undefined) {
    envelope.meta.droppedEntries = context.meta.droppedEntries;
  }
  if (context.meta.timing) {
    envelope.meta.timingMs = context.meta.timing.totalMs;
  }
  if (context.warnings && context.warnings.length > 0) {
    envelope.warnings = context.warnings;
  }

  return envelope;
}

/**
 * Fuse the decisions that shaped a file into a context envelope (internal design note).
 * Reuses the get_why graph traversal so one get_context call returns code +
 * why. No-op when there's no file or no decision links.
 */
function fuseDecisions(
  repoRoot: string,
  filePath: string | undefined,
  db: DatabaseSync,
  envelope: McpContextEnvelope,
  asOf?: string,
): void {
  if (!filePath) return;
  const why = getWhyForMcp(
    repoRoot,
    {
      file_path: filePath,
      include_intermediate_evidence: false,
      max_depth: 3,
      min_edge_confidence: 0.6,
      ...(asOf ? { as_of: asOf } : {}),
    },
    db,
  );
  if (why.ok && why.why && why.why.length > 0) {
    envelope.context.decisions = why.why.slice(0, 5).map((w) => ({
      decision_id: w.decision_id,
      title: w.title,
      reason_excerpt: w.reason_excerpt,
      confidence: w.confidence,
    }));
  }
}

/**
 * Surface mapping staleness on the V4 envelope entries (internal design note). ClusterEntrySummary drops status, so we look it up from
 * the index (cheap: a few file-scoped queries) and tag orphaned/uncertain
 * entries so the agent never silently trusts stale context.
 */
function surfaceStaleness(db: DatabaseSync, envelope: McpContextEnvelope): void {
  const files = [...new Set(envelope.context.entries.map((e) => e.file))];
  if (files.length === 0) return;
  const statusById = new Map<string, string>();
  for (const f of files) {
    for (const row of queryEntries(db, { filePath: f })) {
      statusById.set(row.id, row.status);
    }
  }
  for (const e of envelope.context.entries) {
    const st = statusById.get(e.id);
    if (!st) continue;
    e.status = st;
    if (st === "orphaned" || st === "uncertain") e.stale = true;
  }
}

export function getContextV4(
  repoRoot: string,
  input: GetContextV4Input,
  db: DatabaseSync,
): McpContextEnvelope {
  const query: QueryContext = {
    filePath: input.file_path,
    intent: input.intent,
    tokenBudget: input.token_budget,
    debug: false,
  };

  const context = buildProjectContext(db, query, repoRoot, {
    tokenBudget: input.token_budget,
  });

  const envelope = formatMcpResponse(context, input.token_budget);
  surfaceStaleness(db, envelope);
  fuseDecisions(repoRoot, input.file_path, db, envelope, input.as_of);
  return envelope;
}

export function getContextV4Debug(
  repoRoot: string,
  input: GetContextV4Input,
  db: DatabaseSync,
): { envelope: McpContextEnvelope; debug: ProjectContext["debug"] } {
  const query: QueryContext = {
    filePath: input.file_path,
    intent: input.intent,
    tokenBudget: input.token_budget,
    debug: true,
  };

  const context = buildProjectContext(db, query, repoRoot, {
    tokenBudget: input.token_budget,
  });

  const envelope = formatMcpResponse(context, input.token_budget);
  surfaceStaleness(db, envelope);
  fuseDecisions(repoRoot, input.file_path, db, envelope, input.as_of);
  return {
    envelope,
    debug: context.debug,
  };
}
