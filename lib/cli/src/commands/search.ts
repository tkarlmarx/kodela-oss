// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import {
  readIndex,
  readContextEntry,
  loadLicense,
  licenseHasFeature,
  readEmbeddingStore,
  semanticSearch as coreSemanticSearch,
  hashNote,
} from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import type { OutputMode } from "../output/formatters.js";
import { formatEntries } from "../output/formatters.js";
import type { EmbeddingOptions } from "./ai-layer.js";
import { resolveEmbedder } from "@kodela/embed";

export type SearchOptions = {
  repoRoot: string;
  query: string;
  output?: OutputMode;
  filterTags?: string[];
  filterFile?: string;
  filterSource?: ContextEntry["source"];
  filterStatus?: ContextEntry["status"];
  limit?: number;
  /**
   * Gap 47 — When true, use cosine-similarity over stored embeddings instead
   * of keyword token overlap.  Falls back to keyword search with a warning
   * when no embeddings are stored or no API key is available.
   */
  semantic?: boolean;
  /**
   * Gap 47 — AI provider config used to generate the query embedding.
   * Only consulted when `semantic: true`.
   */
  embeddingConfig?: EmbeddingOptions;
};

export type SearchHit = {
  entry: ContextEntry;
  score: number;
  matchedIn: string[];
  /**
   * Gap 47 — Cosine similarity (0–1) populated only in semantic mode.
   * Absent in keyword mode.
   */
  similarityScore?: number;
};

export type SearchResult = {
  query: string;
  hits: SearchHit[];
  total: number;
  licenseWarning?: string;
  /**
   * Gap 47 — Set to true when semantic mode was requested but fell back to
   * keyword search (no embeddings stored or no API key available).
   */
  semanticFallback?: boolean;
  /** Gap 47 — Set to true when results are ranked by semantic similarity. */
  semanticMode?: boolean;
};

// ---------------------------------------------------------------------------
// Keyword helpers (unchanged from pre-Gap-47 implementation)
// ---------------------------------------------------------------------------

function buildTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function scoreEntry(entry: ContextEntry, tokens: string[]): SearchHit | null {
  const matchedIn: string[] = [];
  let score = 0;

  const noteLower = entry.note.toLowerCase();
  const filePathLower = entry.filePath.toLowerCase();
  const tagsLower = entry.tags.map((t) => t.toLowerCase());
  const authorLower = entry.author.toLowerCase();

  for (const token of tokens) {
    let tokenMatched = false;

    if (noteLower.includes(token)) {
      score += 3;
      if (!matchedIn.includes("note")) matchedIn.push("note");
      tokenMatched = true;
    }

    if (filePathLower.includes(token)) {
      score += 2;
      if (!matchedIn.includes("filePath")) matchedIn.push("filePath");
      tokenMatched = true;
    }

    if (tagsLower.some((tag) => tag.includes(token))) {
      score += 2;
      if (!matchedIn.includes("tags")) matchedIn.push("tags");
      tokenMatched = true;
    }

    if (authorLower.includes(token)) {
      score += 1;
      if (!matchedIn.includes("author")) matchedIn.push("author");
      tokenMatched = true;
    }

    if (!tokenMatched) {
      return null;
    }
  }

  if (score === 0) return null;

  return { entry, score, matchedIn };
}

// ---------------------------------------------------------------------------
// Gap 47 — Semantic search helpers
// ---------------------------------------------------------------------------

/**
 * Run semantic (cosine similarity) search over `candidates`.
 *
 * Returns null when no embeddings are stored for the repo — the caller should
 * fall back to keyword search and set `semanticFallback: true`.
 */
async function runSemanticSearch(
  candidates: ContextEntry[],
  query: string,
  repoRoot: string,
  embeddingConfig: EmbeddingOptions | undefined,
  limit: number,
): Promise<SearchHit[] | null> {
  const store = await readEmbeddingStore(repoRoot);
  if (store.length === 0) return null;

  // Embed the query with the SAME engine family the index was built with
  // (registry reads KODELA_EMBEDDING_PROVIDER; an explicit apiKey forces the
  // cloud provider). Works offline via the local engines — no key required.
  const resolved = await resolveEmbedder(
    embeddingConfig?.apiKey
      ? {
          selector: "openai",
          apiKey: embeddingConfig.apiKey,
          baseUrl: embeddingConfig.baseUrl,
          providerModel: embeddingConfig.model,
        }
      : {},
  );
  const queryEmbedding = await resolved.embedder.embed(query);

  // Dim guard: if the resolved engine doesn't match the stored vectors, fall
  // back to keyword (the caller handles null) rather than compare incompatible
  // dimensions. Happens when the index + query engines differ.
  const storedDim = store[0]?.embedding.length ?? 0;
  if (queryEmbedding.length !== storedDim) return null;

  const hits = coreSemanticSearch(queryEmbedding, store, limit * 2);

  const entryById = new Map<string, ContextEntry>(
    candidates.map((e) => [e.id, e]),
  );

  const results: SearchHit[] = [];
  for (const hit of hits) {
    const entry = entryById.get(hit.entryId);
    if (!entry) continue;
    results.push({
      entry,
      score: Math.round(hit.similarity * 100),
      matchedIn: ["semantic"],
      similarityScore: hit.similarity,
    });
    if (results.length >= limit) break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runSearch(
  opts: SearchOptions,
): Promise<SearchResult> {
  const {
    repoRoot,
    query,
    output: _output = "text",
    filterTags,
    filterFile,
    filterSource,
    filterStatus,
    limit = 50,
    semantic = false,
    embeddingConfig,
  } = opts;

  let licenseWarning: string | undefined;
  const license = await loadLicense(repoRoot);
  if (!licenseHasFeature(license, "search")) {
    licenseWarning =
      "Full-text search across large repositories works best with a Team license. " +
      "Results shown from local .kodela/ only. " +
      "Upgrade at https://kodela.dev/pricing";
  }

  const index = await readIndex(repoRoot);
  const allEntries = await Promise.all(
    index.entries.map((id) =>
      readContextEntry(repoRoot, id).catch(() => null),
    ),
  );
  const validEntries = allEntries.filter(Boolean) as ContextEntry[];

  let candidates = validEntries;

  if (filterFile) {
    const lower = filterFile.toLowerCase();
    candidates = candidates.filter((e) =>
      e.filePath.toLowerCase().includes(lower),
    );
  }

  if (filterSource) {
    candidates = candidates.filter((e) => e.source === filterSource);
  }

  if (filterStatus) {
    candidates = candidates.filter((e) => e.status === filterStatus);
  }

  if (filterTags && filterTags.length > 0) {
    candidates = candidates.filter((e) =>
      filterTags.every((ft) =>
        e.tags.some((tag) => tag.toLowerCase() === ft.toLowerCase()),
      ),
    );
  }

  // ── Gap 47 — Semantic branch ─────────────────────────────────────────────
  if (semantic) {
    try {
      const semanticHits = await runSemanticSearch(
        candidates,
        query,
        repoRoot,
        embeddingConfig,
        limit,
      );

      if (semanticHits !== null) {
        return {
          query,
          hits: semanticHits,
          total: semanticHits.length,
          licenseWarning,
          semanticMode: true,
        };
      }
      // No embeddings stored — fall through to keyword with a fallback note.
    } catch {
      // API error (bad key, network failure) — fall through to keyword.
    }

    // Semantic unavailable — run keyword and flag the fallback.
    const keywordResult = await runKeywordSearch(candidates, query, limit);
    return {
      ...keywordResult,
      query,
      licenseWarning,
      semanticFallback: true,
    };
  }

  // ── Keyword branch (default) ─────────────────────────────────────────────
  const keywordResult = await runKeywordSearch(candidates, query, limit);
  return { ...keywordResult, query, licenseWarning };
}

async function runKeywordSearch(
  candidates: ContextEntry[],
  query: string,
  limit: number,
): Promise<Pick<SearchResult, "hits" | "total">> {
  const tokens = buildTokens(query);
  let hits: SearchHit[];

  if (tokens.length === 0) {
    hits = candidates.map((entry) => ({
      entry,
      score: 0,
      matchedIn: [],
    }));
  } else {
    hits = candidates
      .map((entry) => scoreEntry(entry, tokens))
      .filter(Boolean) as SearchHit[];
  }

  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, limit), total: hits.length };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatSearchResult(
  result: SearchResult,
  output: OutputMode,
): string {
  const lines: string[] = [];

  if (result.licenseWarning) {
    lines.push(`⚠  ${result.licenseWarning}`);
    lines.push("");
  }

  if (result.semanticFallback) {
    lines.push(
      "⚠  Semantic search unavailable (no embeddings stored or no API key). " +
        "Showing keyword results instead.",
    );
    lines.push("");
  }

  if (output === "json") {
    return JSON.stringify(
      {
        query: result.query,
        total: result.total,
        semanticMode: result.semanticMode ?? false,
        semanticFallback: result.semanticFallback ?? false,
        hits: result.hits.map((h) => ({
          score: h.score,
          similarityScore: h.similarityScore,
          matchedIn: h.matchedIn,
          entry: h.entry,
        })),
      },
      null,
      2,
    );
  }

  if (result.total === 0) {
    lines.push(`No context entries matched "${result.query}".`);
    return lines.join("\n");
  }

  const mode = result.semanticMode ? "semantic" : "keyword";
  lines.push(
    `Found ${result.total} match${result.total !== 1 ? "es" : ""} for "${result.query}" (${mode}):`,
  );
  lines.push("");

  for (const hit of result.hits) {
    const e = hit.entry;
    const simLabel =
      hit.similarityScore !== undefined
        ? `  similarity=${hit.similarityScore.toFixed(3)}`
        : "";
    lines.push(
      `  ${e.filePath}:${e.lineRange.start}-${e.lineRange.end}  [${hit.matchedIn.join(", ")}]${simLabel}`,
    );
    lines.push(`  Note: ${e.note.slice(0, 120)}${e.note.length > 120 ? "…" : ""}`);
    lines.push(
      `  source=${e.source}  severity=${e.severity}  status=${e.status}  tags=${e.tags.join(",") || "(none)"}`,
    );
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export { formatEntries };

// Re-export for callers that generate embeddings on write
export { hashNote };
