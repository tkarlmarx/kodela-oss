// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_query` MCP tool (07 §3.1) — unified retrieval over entries +
 * decisions (+ optionally sessions).
 *
 * MVP is keyword-only. The entry text (`note`, `origin.summary`,
 * `origin.reasoning`, `summary.intent/shortSummary`, `tags`) lives in
 * `.kodela/objects/<id>.json`, NOT in the SQLite index — so free-text entry
 * search is a bounded disk-walk, not a SQL query:
 *
 *   getEntryIds (or queryEntries when scope narrows) → load up to ENTRY_SCAN_CAP
 *   objects → weighted substring score → merge with searchDecisions → sort →
 *   truncate to limit.
 *
 * The scan is capped and any truncation (scan cap, result limit, or token
 * budget) is reported in `meta` — never silent. `mode_used` is always
 * "keyword"; semantic/hybrid are accepted but downgraded with a meta note.
 */

import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  getEntryIds,
  queryEntries,
  readContextEntry,
  listSessions,
  readEmbeddingStore,
  semanticSearch,
  type ContextEntry,
} from "@kodela/core";
import { resolveEmbedder } from "@kodela/embed";
import { searchDecisions } from "../lib/decisions-store.js";
import { resolveDecisionDb, DECISION_DB_UNAVAILABLE } from "../lib/lazy-index.js";
import { resolveOrgId } from "../lib/org-id.js";

/** Max entry objects loaded from disk per query — bounds the disk-walk. */
const ENTRY_SCAN_CAP = 500;
/** Concurrency for object reads. */
const READ_CHUNK = 64;

// ── Input schema ─────────────────────────────────────────────────────────────

export const QueryInputSchema = z.object({
  query: z.string().min(1).describe("Free-text query"),
  mode: z
    .enum(["semantic", "keyword", "hybrid"])
    .default("hybrid")
    .describe("MVP runs keyword regardless; semantic/hybrid noted in meta"),
  scope: z
    .object({
      org_id: z.string().optional(),
      repo_id: z.string().optional(),
      file_path: z.string().optional(),
      session_id: z.string().optional(),
    })
    .optional(),
  filters: z
    .object({
      severity: z.array(z.enum(["low", "medium", "high", "critical"])).optional(),
      source: z.array(z.string()).optional(),
      ai_tool: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      date_after: z.string().optional().describe("ISO 8601 lower bound on createdAt"),
      date_before: z.string().optional().describe("ISO 8601 upper bound on createdAt"),
    })
    .optional(),
  include: z
    .object({
      entries: z.boolean().default(true),
      decisions: z.boolean().default(true),
      sessions: z.boolean().default(false),
    })
    .optional(),
  limit: z.number().int().positive().max(100).default(20),
  token_budget: z.number().int().positive().default(8000),
});

export type QueryToolInput = z.infer<typeof QueryInputSchema>;

// ── Output ───────────────────────────────────────────────────────────────────

interface QueryResultItem {
  kind: "entry" | "decision" | "session";
  id: string;
  score: number;
  snippet: string;
  metadata: Record<string, unknown>;
}

export interface QueryResult {
  ok: boolean;
  results?: QueryResultItem[];
  facets?: {
    by_severity: Record<string, number>;
    by_source: Record<string, number>;
    by_ai_tool: Record<string, number>;
  };
  meta?: {
    mode_used: "keyword" | "semantic" | "hybrid";
    tokens_estimated: number;
    truncated: boolean;
    entries_scanned: number;
    scan_capped: boolean;
    notes: string[];
  };
  error?: string;
}

// ── Keyword scoring ──────────────────────────────────────────────────────────

function countSubstr(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/** Weighted keyword score for an entry: intent/summary ×3, note ×2, reasoning/tags ×1. */
function scoreEntryText(entry: ContextEntry, q: string): number {
  const needle = q.toLowerCase();
  const intent =
    (entry.summary?.intent ?? "") +
    " " +
    (entry.summary?.shortSummary ?? "") +
    " " +
    (entry.origin?.summary ?? "");
  const reasoning = (entry.origin?.reasoning ?? []).join(" ");
  const tags = entry.tags.join(" ");
  const raw =
    countSubstr(intent.toLowerCase(), needle) * 3 +
    countSubstr(entry.note.toLowerCase(), needle) * 2 +
    countSubstr(reasoning.toLowerCase(), needle) +
    countSubstr(tags.toLowerCase(), needle);
  return Math.min(1, raw / 10);
}

function entrySnippet(entry: ContextEntry): string {
  const text = entry.summary?.shortSummary || entry.origin?.summary || entry.note;
  return text.length > 200 ? text.slice(0, 200) + "…" : text;
}

function passesFilters(
  entry: ContextEntry,
  f: NonNullable<QueryToolInput["filters"]>,
): boolean {
  if (f.severity && f.severity.length > 0 && !f.severity.includes(entry.severity)) {
    return false;
  }
  if (f.source && f.source.length > 0 && !f.source.includes(entry.source)) return false;
  if (f.ai_tool && f.ai_tool.length > 0 && (!entry.aiTool || !f.ai_tool.includes(entry.aiTool))) {
    return false;
  }
  if (f.tags && f.tags.length > 0 && !f.tags.some((t) => entry.tags.includes(t))) {
    return false;
  }
  if (f.date_after && entry.createdAt < f.date_after) return false;
  if (f.date_before && entry.createdAt > f.date_before) return false;
  return true;
}

async function readInChunks(
  repoRoot: string,
  ids: string[],
): Promise<ContextEntry[]> {
  const out: ContextEntry[] = [];
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const chunk = ids.slice(i, i + READ_CHUNK);
    const loaded = await Promise.all(
      chunk.map((id) => readContextEntry(repoRoot, id).catch(() => null)),
    );
    for (const e of loaded) if (e) out.push(e);
  }
  return out;
}

// ── Core ─────────────────────────────────────────────────────────────────────

export async function queryForMcp(
  repoRoot: string,
  input: QueryToolInput,
  db: DatabaseSync | null,
): Promise<QueryResult> {
  const handle = resolveDecisionDb(repoRoot, db, "query");
  if (handle === null) {
    return { ok: false, error: DECISION_DB_UNAVAILABLE };
  }

  const notes: string[] = [];
  const include = input.include ?? { entries: true, decisions: true, sessions: false };
  const filters = input.filters ?? {};
  const scope = input.scope ?? {};
  const orgId = resolveOrgId(scope.org_id);

  // ── Semantic prep (doc 22 P2): blend vector similarity when embeddings exist ──
  // Uses the local embedder so it works offline; only activates when the stored
  // vectors share its dimensionality (provider-generated vectors need the same
  // provider for the query, so we fall back to keyword and say so).
  const semByEntry = new Map<string, number>();
  let semanticActive = false;
  let modeUsed: "keyword" | "semantic" | "hybrid" = "keyword";
  if (input.mode !== "keyword") {
    const store = await readEmbeddingStore(repoRoot).catch(() => []);
    if (store.length === 0) {
      notes.push("no embeddings found (run 'kodela embed'); using keyword.");
    } else {
      // Embed the QUERY with the same engine family the index was built with
      // (driven by KODELA_EMBEDDING_PROVIDER). The dim guard below is the safety
      // net: if the resolved engine doesn't match the stored vectors (e.g. the
      // index was built with ONNX but this host lacks the runtime, or it was
      // provider-built and no key is set here), we fall back to keyword rather
      // than compare incompatible vectors.
      const dim = store[0]?.embedding.length ?? 0;
      let qEmb: number[] = [];
      let engineNote = "";
      try {
        const resolved = await resolveEmbedder();
        qEmb = await resolved.embedder.embed(input.query);
        engineNote = resolved.embedder.id;
      } catch (e) {
        notes.push(
          `semantic query embedding unavailable (${e instanceof Error ? e.message : String(e)}); using keyword.`,
        );
      }
      if (qEmb.length > 0 && dim === qEmb.length) {
        for (const hit of semanticSearch(qEmb, store, store.length)) {
          semByEntry.set(hit.entryId, hit.similarity);
        }
        semanticActive = true;
        modeUsed = input.mode;
        notes.push(`semantic active (${engineNote}) over ${store.length} embeddings.`);
      } else if (qEmb.length > 0) {
        notes.push(
          `query engine (${engineNote}, dim ${qEmb.length}) does not match the stored index (dim ${dim}); ` +
            `rebuild with 'kodela embed' or set KODELA_EMBEDDING_PROVIDER to match. using keyword.`,
        );
      }
    }
  }

  const results: QueryResultItem[] = [];
  let entriesScanned = 0;
  let scanCapped = false;

  try {
    // ── Entries (capped disk-walk) ───────────────────────────────────────────
    if (include.entries !== false) {
      // Narrow candidate ids via the SQLite index when scope allows.
      let candidateIds: string[];
      if (scope.file_path || scope.session_id) {
        candidateIds = queryEntries(handle, {
          filePath: scope.file_path,
          sessionId: scope.session_id,
        }).map((r) => r.id);
      } else {
        candidateIds = getEntryIds(handle);
      }

      if (candidateIds.length > ENTRY_SCAN_CAP) {
        scanCapped = true;
        candidateIds = candidateIds.slice(0, ENTRY_SCAN_CAP);
      }
      entriesScanned = candidateIds.length;

      const entries = await readInChunks(repoRoot, candidateIds);

      // Pass 1: collect each surviving entry's keyword + semantic signals.
      const cands = entries
        .filter((entry) => passesFilters(entry, filters))
        .map((entry) => ({
          entry,
          kw: scoreEntryText(entry, input.query),
          sem: Math.max(0, semByEntry.get(entry.id) ?? 0), // cosine → [0,1]
        }));

      // Hybrid uses Reciprocal Rank Fusion (rank-based, scale-free) rather than a
      // weighted score sum — robust when keyword and vector scores aren't on the
      // same distribution. Normalised to [0,1] so entries stay comparable to the
      // decision/session scores in the merged result list.
      const RRF_K = 60;
      const rankBy = (key: (c: (typeof cands)[number]) => number): Map<string, number> => {
        const m = new Map<string, number>();
        [...cands]
          .filter((c) => key(c) > 0)
          .sort((a, b) => key(b) - key(a))
          .forEach((c, i) => m.set(c.entry.id, i + 1));
        return m;
      };
      const useRrf = semanticActive && modeUsed === "hybrid";
      const kwRank = useRrf ? rankBy((c) => c.kw) : null;
      const semRank = useRrf ? rankBy((c) => c.sem) : null;
      const MAX_RRF = 2 / (RRF_K + 1); // both rank-1 → 1.0 after normalisation

      for (const { entry, kw, sem } of cands) {
        let score: number;
        if (useRrf) {
          const kr = kwRank!.get(entry.id);
          const sr = semRank!.get(entry.id);
          const rrf = (kr ? 1 / (RRF_K + kr) : 0) + (sr ? 1 / (RRF_K + sr) : 0);
          score = rrf / MAX_RRF;
        } else if (semanticActive && modeUsed === "semantic") {
          score = sem;
        } else {
          score = kw;
        }
        if (score <= 0) continue;
        results.push({
          kind: "entry",
          id: entry.id,
          score,
          snippet: entrySnippet(entry),
          metadata: {
            file_path: entry.filePath,
            severity: entry.severity,
            source: entry.source,
            ai_tool: entry.aiTool ?? null,
            tags: entry.tags,
            created_at: entry.createdAt,
            line_range: entry.lineRange,
          },
        });
      }
    }

    // ── Decisions (SQLite keyword search) ────────────────────────────────────
    if (include.decisions !== false) {
      const dec = searchDecisions(handle, {
        org_id: orgId,
        repo_id: scope.repo_id,
        query: input.query,
        tags: filters.tags,
        decided_after: filters.date_after,
        decided_before: filters.date_before,
        limit: input.limit,
      });
      for (const d of dec.results) {
        results.push({
          kind: "decision",
          id: d.decision_id,
          score: d.score,
          snippet: d.snippet,
          metadata: {
            title: d.title,
            category: d.category,
            status: d.status,
            decided_at: d.decided_at,
          },
        });
      }
    }

    // ── Sessions (optional) ──────────────────────────────────────────────────
    if (include.sessions === true) {
      const needle = input.query.toLowerCase();
      const sessions = await listSessions(repoRoot);
      for (const s of sessions) {
        const hay = `${s.goal ?? ""} ${s.handoffSummary ?? ""}`.toLowerCase();
        const hits = countSubstr(hay, needle);
        if (hits <= 0) continue;
        results.push({
          kind: "session",
          id: s.id,
          score: Math.min(1, hits / 5),
          snippet: (s.handoffSummary ?? s.goal ?? "").slice(0, 200),
          metadata: {
            started_at: s.startedAt,
            ended_at: s.endedAt ?? null,
            actor_tool: s.actor?.tool ?? "unknown",
            risk: s.aggregatedRisk,
          },
        });
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // ── Facets over entry results (before limit truncation) ─────────────────────
  const facets = {
    by_severity: {} as Record<string, number>,
    by_source: {} as Record<string, number>,
    by_ai_tool: {} as Record<string, number>,
  };
  for (const r of results) {
    if (r.kind !== "entry") continue;
    const m = r.metadata;
    const sev = String(m.severity ?? "unknown");
    const src = String(m.source ?? "unknown");
    const tool = String(m.ai_tool ?? "none");
    facets.by_severity[sev] = (facets.by_severity[sev] ?? 0) + 1;
    facets.by_source[src] = (facets.by_source[src] ?? 0) + 1;
    facets.by_ai_tool[tool] = (facets.by_ai_tool[tool] ?? 0) + 1;
  }

  // ── Sort, limit, token-budget ────────────────────────────────────────────
  results.sort((a, b) => b.score - a.score);
  const totalMatched = results.length;
  let limited = results.slice(0, input.limit);

  const estTokens = (items: QueryResultItem[]) =>
    Math.ceil(JSON.stringify(items).length / 4);
  let budgetTruncated = false;
  while (limited.length > 1 && estTokens(limited) > input.token_budget) {
    limited = limited.slice(0, Math.ceil(limited.length / 2));
    budgetTruncated = true;
  }

  const truncated = totalMatched > limited.length || scanCapped;
  if (scanCapped) {
    notes.push(
      `entry scan capped at ${ENTRY_SCAN_CAP}; more entries exist but were not searched.`,
    );
  }
  if (budgetTruncated) notes.push("results trimmed to fit token_budget.");

  return {
    ok: true,
    results: limited,
    facets,
    meta: {
      mode_used: modeUsed,
      tokens_estimated: estTokens(limited),
      truncated,
      entries_scanned: entriesScanned,
      scan_capped: scanCapped,
      notes,
    },
  };
}

// ── Response formatter ───────────────────────────────────────────────────────

export function formatQueryResponse(result: QueryResult): string {
  if (!result.ok) {
    return JSON.stringify({ ok: false, error: result.error }, null, 2);
  }
  return JSON.stringify(
    {
      ok: true,
      type: "kodela.query.results",
      version: "1.0",
      results: result.results,
      facets: result.facets,
      meta: result.meta,
    },
    null,
    2,
  );
}
