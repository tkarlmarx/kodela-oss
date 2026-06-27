// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela embed` — generate semantic embeddings for all context annotations.
 *
 * Walks every entry in the index, embeds its note, and writes the vectors to
 * `.kodela/embeddings.jsonl` (re-embedding only changed notes). This is what
 * makes semantic / hybrid retrieval light up in `kodela search --semantic` and
 * the MCP `kodela_query` tool (doc 22 P2).
 *
 * Engine selection (E.5) is delegated to `@kodela/embed`'s registry, driven by
 * `KODELA_EMBEDDING_PROVIDER` (auto | local-onnx | local-hash | openai). The
 * DEFAULT is `auto` → a local ONNX transformer when its runtime is present
 * (real semantics, fully offline), gracefully degrading to the dependency-free
 * feature-hash embedder otherwise. `--ai` forces the OpenAI-compatible provider.
 */

import { readIndex, readContextEntry, buildEmbeddingIndex } from "@kodela/core";
import { resolveEmbedder, createOnnxEmbedder, DEFAULT_ONNX_MODEL, type EmbedderSelector } from "@kodela/embed";
import type { EmbeddingOptions } from "./ai-layer.js";

export type EmbedOptions = {
  repoRoot: string;
  /**
   * Legacy `--ai` path: when set with an apiKey, forces the cloud provider.
   * Prefer `selector` for new callers.
   */
  embeddingConfig?: EmbeddingOptions;
  /** Explicit engine selector; falls back to KODELA_EMBEDDING_PROVIDER, then `auto`. */
  selector?: EmbedderSelector;
};

export type EmbedResult = {
  total: number;
  embedded: number;
  skipped: number;
  /** Coarse family, kept for backward-compatible output ("ai" == cloud provider). */
  provider: "local" | "ai";
  /** Precise engine id stamped into the store, e.g. `local-onnx:all-MiniLM-L6-v2`. */
  embedderId: string;
  /** Vector dimensionality the index was built at. */
  dim: number;
  /** True when `auto` fell back to the lexical hash embedder (no real semantics). */
  degraded: boolean;
  /** One-line, user-facing explanation of which engine ran and why. */
  note: string;
};

/**
 * `kodela embed --download-model` — pre-fetch the local ONNX model so the first
 * real embed (and air-gapped boxes) don't pay a download mid-run. Embeds a tiny
 * probe string to force transformers.js to resolve + cache the model.
 */
export async function prefetchEmbeddingModel(
  model: string = DEFAULT_ONNX_MODEL,
): Promise<{ ok: boolean; model: string; note: string }> {
  const onnx = await createOnnxEmbedder(model);
  if (!onnx) {
    return {
      ok: false,
      model,
      note:
        "Local ONNX runtime not installed. Run `pnpm add @huggingface/transformers` " +
        "(or set KODELA_EMBEDDING_PROVIDER=local-hash to stay dependency-free).",
    };
  }
  try {
    await onnx.embed("kodela model warm-up probe");
    return { ok: true, model: onnx.id, note: `Model ready and cached (${onnx.id}).` };
  } catch (err) {
    return { ok: false, model, note: `Download failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function runEmbed(opts: EmbedOptions): Promise<EmbedResult> {
  const { repoRoot, embeddingConfig } = opts;

  // Map the legacy `--ai` flag onto the registry: an explicit apiKey means the
  // user asked for the cloud provider. Otherwise honour `selector` / env / auto.
  const useAiFlag = Boolean(embeddingConfig?.apiKey);
  const resolved = await resolveEmbedder(
    useAiFlag
      ? {
          selector: "openai",
          apiKey: embeddingConfig?.apiKey,
          baseUrl: embeddingConfig?.baseUrl,
          providerModel: embeddingConfig?.model,
        }
      : { selector: opts.selector },
  );

  const index = await readIndex(repoRoot);
  const items: { entryId: string; note: string }[] = [];
  for (const id of index.entries) {
    const entry = await readContextEntry(repoRoot, id).catch(() => null);
    const note = entry?.note?.trim();
    if (!note) continue;
    items.push({ entryId: id, note });
  }

  const res = await buildEmbeddingIndex(repoRoot, items, (text) =>
    resolved.embedder.embed(text),
  );

  return {
    ...res,
    provider: resolved.embedder.kind === "provider" ? "ai" : "local",
    embedderId: resolved.embedder.id,
    dim: resolved.embedder.dim,
    degraded: resolved.degraded,
    note: resolved.note,
  };
}
