// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Embedder contract (E.5 — Semantic retrieval upgrade).
 *
 * Kodela's retrieval plumbing (the `.kodela/embeddings.jsonl` store, cosine
 * similarity, RRF fusion in the MCP query tool) is fully wired and engine-
 * agnostic. What plugs into it is an `Embedder`: a thing that turns text into a
 * vector. This module is the stable seam between the plumbing and whichever
 * engine produces the vectors (local feature-hash, local ONNX transformer, or a
 * cloud provider).
 *
 * Design rules:
 *   - The DEFAULT must be real-semantic AND offline (local ONNX) so an
 *     individual dev gets quality with no key, and an enterprise keeps its
 *     "why did this change" reasoning text on-device (zero data egress).
 *   - Heavier engines are lazy: importing this module pulls in no ML runtime.
 *     The ONNX model is only loaded when an ONNX embedder is actually used.
 *   - Engines are interchangeable because they all return the same vector
 *     shape; the `id` + `dim` let callers detect when a stored index was built
 *     with a different engine and fall back rather than compare apples to
 *     oranges.
 */

/** Which family an embedder belongs to — drives privacy + capability messaging. */
export type EmbedderKind = "local-hash" | "local-onnx" | "provider";

/**
 * A text→vector engine. All engines return L2-normalised vectors so the
 * retrieval layer's cosine similarity is a plain dot product.
 */
export interface Embedder {
  /**
   * Stable identity of the engine + model, e.g. `local-onnx:all-MiniLM-L6-v2`
   * or `provider:text-embedding-3-small`. Stamped into the embedding store so a
   * later query can confirm it is embedding with the SAME engine before
   * trusting vector similarity.
   */
  readonly id: string;
  readonly kind: EmbedderKind;
  /** Output dimensionality (e.g. 384 for MiniLM, 256 for the hash, 1536 for OpenAI small). */
  readonly dim: number;
  /** Does this engine keep all data on-device? Drives the "private by default" UX copy. */
  readonly offline: boolean;
  /** Embed a single string. */
  embed(text: string): Promise<number[]>;
  /** Optional batched embed — engines that can amortise overhead override this. */
  embedBatch?(texts: string[]): Promise<number[][]>;
}

/**
 * The user-facing selector value (env `KODELA_EMBEDDING_PROVIDER` / config).
 *   - `auto`        — prefer local ONNX (real-semantic, offline); fall back to
 *                     the hash embedder if the ONNX runtime/model is unavailable.
 *   - `local-onnx`  — force local ONNX; error if unavailable (no silent downgrade).
 *   - `local-hash`  — force the dependency-free feature-hash embedder.
 *   - `openai`      — use an OpenAI-compatible provider (needs a key).
 */
export type EmbedderSelector = "auto" | "local-onnx" | "local-hash" | "openai";

/** Thrown when a specific engine was requested but its runtime/model/key is missing. */
export class EmbedderUnavailableError extends Error {
  constructor(
    message: string,
    readonly selector: EmbedderSelector,
  ) {
    super(message);
    this.name = "EmbedderUnavailableError";
  }
}

/** Inputs that influence engine selection — all optional, env is the fallback. */
export interface ResolveEmbedderOptions {
  /** Explicit selector; falls back to `KODELA_EMBEDDING_PROVIDER`, then `auto`. */
  selector?: EmbedderSelector;
  /** Provider API key (OpenAI-compatible); falls back to `KODELA_AI_API_KEY`. */
  apiKey?: string;
  /** Provider base URL; falls back to `KODELA_AI_BASE_URL`, then OpenAI. */
  baseUrl?: string;
  /** Provider embedding model; falls back to `KODELA_AI_MODEL`, then `text-embedding-3-small`. */
  providerModel?: string;
  /** Local ONNX model id or absolute path; falls back to `KODELA_MODEL_PATH`, then the default MiniLM. */
  onnxModel?: string;
  /** Hash embedder dimensionality (default 256). */
  hashDim?: number;
}

/** A resolved embedder plus human-readable diagnostics for `kodela doctor` / meta notes. */
export interface ResolvedEmbedder {
  embedder: Embedder;
  /** What the user asked for, after env resolution. */
  selector: EmbedderSelector;
  /** True when `auto` fell back to the hash embedder (no real semantics). */
  degraded: boolean;
  /** One-line explanation suitable for surfacing to the user. */
  note: string;
}
