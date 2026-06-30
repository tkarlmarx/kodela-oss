// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Embedder registry — resolves a single `KODELA_EMBEDDING_PROVIDER` selector
 * (or explicit options) into a concrete `Embedder`, with the privacy-first
 * default and graceful degradation baked in.
 *
 * Resolution policy:
 *   auto (default) → local ONNX if its runtime is available, else local hash.
 *                    NEVER a cloud provider implicitly — `auto` keeps data on-
 *                    device. Choosing the cloud is always an explicit act.
 *   local-onnx     → local ONNX, or a hard error if the runtime/model is missing.
 *   local-hash     → the dependency-free feature-hash engine.
 *   openai         → OpenAI-compatible provider, or a hard error if no key.
 *
 * Both the index builder (`kodela embed`) and the query path call this with the
 * same environment, so the query vector is produced by the same engine as the
 * stored index — which is what lets the retrieval layer's vector similarity
 * actually fire instead of falling back to keyword.
 */

import { createHashEmbedder, HASH_DIM } from "./hash.js";
import { createOnnxEmbedder } from "./onnx.js";
import { createProviderEmbedder } from "./provider.js";
import {
  EmbedderUnavailableError,
  type EmbedderSelector,
  type ResolveEmbedderOptions,
  type ResolvedEmbedder,
} from "./types.js";

const VALID: ReadonlySet<string> = new Set([
  "auto",
  "local-onnx",
  "local-hash",
  "openai",
]);

/** Read the selector from options → env → default, validating the value. */
export function resolveSelector(opts: ResolveEmbedderOptions = {}): EmbedderSelector {
  const raw = (opts.selector ?? process.env["KODELA_EMBEDDING_PROVIDER"] ?? "auto")
    .trim()
    .toLowerCase();
  // Friendly aliases.
  const normalised = raw === "provider" || raw === "cloud" ? "openai" : raw;
  if (!VALID.has(normalised)) {
    throw new Error(
      `Unknown KODELA_EMBEDDING_PROVIDER "${raw}". Valid: auto, local-onnx, local-hash, openai.`,
    );
  }
  return normalised as EmbedderSelector;
}

function resolveApiKey(opts: ResolveEmbedderOptions): string {
  return opts.apiKey ?? process.env["KODELA_AI_API_KEY"] ?? "";
}

/**
 * Resolve a concrete embedder plus diagnostics. This is the single entry point
 * callers should use; it encapsulates the fallback logic so no caller has to
 * reimplement "try ONNX, else hash".
 */
export async function resolveEmbedder(
  opts: ResolveEmbedderOptions = {},
): Promise<ResolvedEmbedder> {
  const selector = resolveSelector(opts);
  const hashDim = opts.hashDim ?? HASH_DIM;

  switch (selector) {
    case "local-hash":
      return {
        embedder: createHashEmbedder(hashDim),
        selector,
        degraded: false,
        note: "Using the local feature-hash embedder (lexical, offline, no semantics).",
      };

    case "local-onnx": {
      const onnx = await createOnnxEmbedder(opts.onnxModel, opts.onnxModel);
      if (!onnx) {
        throw new EmbedderUnavailableError(
          "local-onnx requested but the transformers.js runtime is not installed. " +
            "Run `pnpm add @huggingface/transformers` (or use KODELA_EMBEDDING_PROVIDER=auto).",
          selector,
        );
      }
      return {
        embedder: onnx,
        selector,
        degraded: false,
        note: `Using the local ONNX embedder (${onnx.id}) — real semantics, fully offline.`,
      };
    }

    case "openai": {
      const apiKey = resolveApiKey(opts);
      if (!apiKey) {
        throw new EmbedderUnavailableError(
          "openai embeddings requested but no API key is set (KODELA_AI_API_KEY).",
          selector,
        );
      }
      return {
        embedder: createProviderEmbedder({
          apiKey,
          model: opts.providerModel,
          baseUrl: opts.baseUrl,
        }),
        selector,
        degraded: false,
        note: "Using OpenAI-compatible cloud embeddings — text leaves the machine.",
      };
    }

    case "auto":
    default: {
      const onnx = await createOnnxEmbedder(opts.onnxModel, opts.onnxModel);
      if (onnx) {
        return {
          embedder: onnx,
          selector,
          degraded: false,
          note: `auto → local ONNX embedder (${onnx.id}) — real semantics, fully offline.`,
        };
      }
      return {
        embedder: createHashEmbedder(hashDim),
        selector,
        degraded: true,
        note:
          "auto → local feature-hash embedder (ONNX runtime not installed; lexical only). " +
          "Install @huggingface/transformers for real semantic search.",
      };
    }
  }
}
