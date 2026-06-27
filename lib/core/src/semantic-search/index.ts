// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 47 — Semantic (natural language) search over annotations.
 *
 * This module provides:
 *   1. A `.kodela/embeddings.jsonl` store — one JSON line per entry, containing
 *      a float32 embedding vector and a note-hash for freshness checks.
 *   2. `cosineSimilarity` — dot-product similarity over L2-normalised vectors.
 *   3. `semanticSearch` — rank all stored embeddings against a query vector and
 *      return the top-K matches.
 *
 * Embedding GENERATION (calling the AI provider) lives in the CLI layer
 * (`ai-layer.ts`) so that `@kodela/core` has no network dependencies.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EMBEDDINGS_FILE = ".kodela/embeddings.jsonl";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One record in `.kodela/embeddings.jsonl`.
 *
 * `noteHash` is a 16-char hex truncation of SHA-256 over the note text.
 * It lets callers skip re-embedding when the note has not changed since the
 * last embedding was written.
 */
export type EmbeddingRecord = {
  entryId: string;
  noteHash: string;
  embedding: number[];
};

export type SemanticHit = {
  entryId: string;
  similarity: number;
};

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Compute the cosine similarity of two equal-length numeric vectors.
 * Returns a value in [–1, 1] (or 0 for zero-length inputs / mismatched dims).
 *
 * The OpenAI `text-embedding-3-small` vectors are L2-normalised, so the dot
 * product and cosine similarity are numerically equivalent.  We still compute
 * the magnitudes explicitly so the function works correctly with any provider.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Return a 16-character hex string that identifies the note text.
 * Used to detect whether a stored embedding is stale (note has changed).
 */
export function hashNote(note: string): string {
  return crypto
    .createHash("sha256")
    .update(note, "utf-8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Deterministic, dependency-free LOCAL embedder (feature-hashing / "hashing
 * trick"). Tokenises the text, hashes each token into a fixed-dim bucket with a
 * sign, and L2-normalises — so cosine similarity is meaningful and texts that
 * share vocabulary score higher. No network, no model download: the offline
 * default so semantic search works out of the box.
 *
 * For higher-quality *semantic* vectors (paraphrase matching), configure a
 * provider (KODELA_AI_API_KEY) and use the CLI's generateEmbedding instead;
 * both write the same EmbeddingRecord shape, so they're interchangeable.
 */
export function embedTextLocal(text: string, dim = 256): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  for (const tok of tokens) {
    if (tok.length < 2) continue;
    const h = crypto.createHash("sha1").update(tok).digest();
    const bucket = (((h[0] ?? 0) << 8) | (h[1] ?? 0)) % dim;
    const sign = ((h[2] ?? 0) & 1) === 0 ? 1 : -1;
    vec[bucket] = (vec[bucket] ?? 0) + sign;
  }
  let mag = 0;
  for (const v of vec) mag += v * v;
  mag = Math.sqrt(mag);
  if (mag === 0) return vec;
  for (let i = 0; i < dim; i++) vec[i] = (vec[i] ?? 0) / mag;
  return vec;
}

// ---------------------------------------------------------------------------
// Embedding store I/O
// ---------------------------------------------------------------------------

/**
 * Read all embedding records from `.kodela/embeddings.jsonl`.
 * Returns an empty array when the file does not exist or is empty.
 */
export async function readEmbeddingStore(
  repoRoot: string,
): Promise<EmbeddingRecord[]> {
  try {
    const raw = await fs.readFile(
      path.join(repoRoot, EMBEDDINGS_FILE),
      "utf-8",
    );
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EmbeddingRecord);
  } catch {
    return [];
  }
}

/**
 * Insert or replace a single embedding record in the store.
 * Rewrites the entire file (JSONL is small; each entry is ≈ 6 KB for 1536-d).
 */
export async function upsertEmbeddingRecord(
  repoRoot: string,
  record: EmbeddingRecord,
): Promise<void> {
  const existing = await readEmbeddingStore(repoRoot);
  const updated = [
    ...existing.filter((r) => r.entryId !== record.entryId),
    record,
  ];
  const filePath = path.join(repoRoot, EMBEDDINGS_FILE);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    updated.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8",
  );
}

/**
 * Remove an entry's embedding from the store.
 * No-op if the entry is not present.
 */
export async function deleteEmbeddingRecord(
  repoRoot: string,
  entryId: string,
): Promise<void> {
  const existing = await readEmbeddingStore(repoRoot);
  const updated = existing.filter((r) => r.entryId !== entryId);
  if (updated.length === existing.length) return;

  const filePath = path.join(repoRoot, EMBEDDINGS_FILE);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    updated.length > 0
      ? updated.map((r) => JSON.stringify(r)).join("\n") + "\n"
      : "",
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Similarity search
// ---------------------------------------------------------------------------

/**
 * Rank all records in `store` against `queryEmbedding` by cosine similarity
 * and return the top-`topK` results, highest similarity first.
 *
 * Returns an empty array when the store is empty or the query embedding has
 * zero length.
 */
export function semanticSearch(
  queryEmbedding: number[],
  store: EmbeddingRecord[],
  topK: number,
): SemanticHit[] {
  if (store.length === 0 || queryEmbedding.length === 0) return [];

  const scored: SemanticHit[] = store.map((record) => ({
    entryId: record.entryId,
    similarity: cosineSimilarity(queryEmbedding, record.embedding),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, Math.max(1, topK));
}

// ---------------------------------------------------------------------------
// Bulk generation
// ---------------------------------------------------------------------------

/**
 * Build (or incrementally refresh) the embedding index for a set of entries.
 *
 * For each item, re-embeds only when the note changed (noteHash mismatch),
 * then writes `.kodela/embeddings.jsonl` ONCE (not per-record, so bulk builds
 * are O(n) not O(n²)). The `embed` function is injected — pass `embedTextLocal`
 * for offline generation, or the CLI's provider-backed generateEmbedding.
 */
export async function buildEmbeddingIndex(
  repoRoot: string,
  items: { entryId: string; note: string }[],
  embed: (text: string) => Promise<number[]> | number[],
): Promise<{ total: number; embedded: number; skipped: number }> {
  const existing = await readEmbeddingStore(repoRoot);
  const byId = new Map<string, EmbeddingRecord>(existing.map((r) => [r.entryId, r]));

  let embedded = 0;
  let skipped = 0;
  for (const { entryId, note } of items) {
    const noteHash = hashNote(note);
    const prev = byId.get(entryId);
    if (prev && prev.noteHash === noteHash) {
      skipped++;
      continue;
    }
    byId.set(entryId, { entryId, noteHash, embedding: await embed(note) });
    embedded++;
  }

  const filePath = path.join(repoRoot, EMBEDDINGS_FILE);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    [...byId.values()].map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8",
  );

  return { total: items.length, embedded, skipped };
}
