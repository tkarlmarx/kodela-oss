// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `provider` embedder — OpenAI-compatible cloud embeddings.
 *
 * The opt-in power-up for teams already on a provider who want top-tier vectors.
 * It is NOT the default: choosing it means embedding text leaves the machine, so
 * it is only used when the user explicitly sets `KODELA_EMBEDDING_PROVIDER=openai`
 * (or passes `selector: "openai"`) and supplies a key.
 *
 * This lives in `@kodela/embed` (not just the CLI) so the MCP query path can
 * embed the *query* with the same provider the index was built with — previously
 * the query side only had the local hash embedder, so provider-built indexes
 * silently fell back to keyword. Implemented with built-in `fetch`; no SDK.
 */

import type { Embedder } from "./types.js";

export const DEFAULT_PROVIDER_MODEL = "text-embedding-3-small";
export const DEFAULT_PROVIDER_BASE_URL = "https://api.openai.com";

export interface ProviderEmbedderConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/**
 * Build a provider-backed embedder. The `dim` is not known until the first call
 * (it depends on the model), so we expose the model's documented dimension when
 * known and otherwise 0 — callers rely on the stored vector length, and the
 * query layer's dim guard handles any mismatch.
 */
export function createProviderEmbedder(cfg: ProviderEmbedderConfig): Embedder {
  const model = cfg.model ?? process.env["KODELA_AI_MODEL"] ?? DEFAULT_PROVIDER_MODEL;
  const baseUrl =
    cfg.baseUrl ?? process.env["KODELA_AI_BASE_URL"] ?? DEFAULT_PROVIDER_BASE_URL;

  // Documented dims for the common OpenAI models; 0 means "discover from the vector".
  const KNOWN_DIMS: Record<string, number> = {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
  };

  async function callEmbeddings(input: string | string[]): Promise<number[][]> {
    const resp = await fetch(`${baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Embedding API returned ${resp.status}: ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    const rows = data.data.map((d) => d.embedding);
    if (rows.length === 0 || !Array.isArray(rows[0])) {
      throw new Error("Embedding API returned no vectors.");
    }
    return rows;
  }

  return {
    id: `provider:${model}`,
    kind: "provider",
    dim: KNOWN_DIMS[model] ?? 0,
    offline: false,
    async embed(text: string): Promise<number[]> {
      const [row] = await callEmbeddings(text);
      return row ?? [];
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return callEmbeddings(texts);
    },
  };
}
