// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * `local-onnx` embedder — real semantic vectors, fully on-device.
 *
 * This is the product differentiator: paraphrase-aware retrieval ("auth bug"
 * finds "login token failure") that runs locally with ZERO data egress. It uses
 * transformers.js (`@huggingface/transformers`) to run a quantised
 * sentence-transformer (all-MiniLM-L6-v2, 384-dim) on the CPU via ONNX Runtime.
 *
 * Why it is an OPTIONAL, lazily-imported dependency:
 *   - `@kodela/embed` must typecheck and CI must stay green without pulling a
 *     ~200 MB ML runtime. The dep lives in `optionalDependencies` and is loaded
 *     through a dynamic `import()` only when an ONNX embedder is actually built.
 *   - On a host where the runtime/model is absent, `probeOnnx()` reports
 *     unavailable and the `auto` selector falls back to the hash embedder. No
 *     crash, no silent wrong-answers (the dim guard in the query layer rejects a
 *     mismatched index).
 *
 * Model delivery (per the founder decision): download-on-first-use. The model is
 * fetched from the HF hub into a local cache the first time, then served fully
 * offline. Air-gapped installs set `KODELA_MODEL_PATH` to a pre-fetched model
 * directory and/or run `kodela embed --download-model` ahead of time.
 */

import type { Embedder } from "./types.js";

/** The default sentence-transformer: small, fast on CPU, 384-dim, widely vetted. */
export const DEFAULT_ONNX_MODEL = "Xenova/all-MiniLM-L6-v2";
export const ONNX_DIM = 384;

/**
 * transformers.js is an optional dep with no bundled types here (we don't want a
 * hard devDependency on its typings just to typecheck). We model the slice of
 * its surface we use and load it through a typed dynamic import.
 */
type FeatureExtractionPipeline = (
  text: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

interface TransformersModule {
  pipeline: (
    task: "feature-extraction",
    model: string,
    opts?: Record<string, unknown>,
  ) => Promise<FeatureExtractionPipeline>;
  env: {
    allowRemoteModels: boolean;
    localModelPath?: string;
    cacheDir?: string;
  };
}

/** Cache the dynamic import so the runtime is resolved at most once per process. */
let modulePromise: Promise<TransformersModule | null> | null = null;

async function loadTransformers(): Promise<TransformersModule | null> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    try {
      // Computed specifier: keeps TypeScript from statically resolving an
      // OPTIONAL dependency that may not be installed (and keeps bundlers from
      // trying to inline a ~200 MB runtime). Resolved at runtime only.
      const spec = ["@huggingface", "transformers"].join("/");
      const mod = (await import(/* @vite-ignore */ spec)) as unknown as TransformersModule;
      return mod;
    } catch {
      return null;
    }
  })();
  return modulePromise;
}

/**
 * Configure transformers.js env for our delivery model.
 *   - If `KODELA_MODEL_PATH` is set, serve the model from there and forbid
 *     remote fetches (air-gapped / enterprise locked-down).
 *   - Otherwise allow a one-time remote download into the local cache.
 */
function applyEnv(mod: TransformersModule, modelPath: string | undefined): void {
  const localPath = modelPath ?? process.env["KODELA_MODEL_PATH"];
  const cacheDir = process.env["KODELA_MODEL_CACHE"];
  if (localPath) {
    mod.env.localModelPath = localPath;
    mod.env.allowRemoteModels = false;
  } else {
    mod.env.allowRemoteModels = true;
  }
  if (cacheDir) mod.env.cacheDir = cacheDir;
}

/** Pipelines are keyed by model id so multiple models can coexist (rare, but cheap). */
const pipelineCache = new Map<string, Promise<FeatureExtractionPipeline>>();

function getPipeline(
  mod: TransformersModule,
  model: string,
): Promise<FeatureExtractionPipeline> {
  let p = pipelineCache.get(model);
  if (!p) {
    p = mod.pipeline("feature-extraction", model, { quantized: true });
    pipelineCache.set(model, p);
  }
  return p;
}

/**
 * Report whether the ONNX runtime can be loaded at all. Used by the `auto`
 * selector to decide between ONNX and the hash fallback WITHOUT paying the cost
 * of loading the model (it only checks the runtime import, not a full inference).
 */
export async function probeOnnx(): Promise<boolean> {
  const mod = await loadTransformers();
  return mod !== null;
}

function toNumberArray(data: Float32Array | number[]): number[] {
  return Array.isArray(data) ? data : Array.from(data);
}

/**
 * Build an ONNX-backed embedder. Returns `null` when the runtime is unavailable,
 * so the registry can fall back without throwing (the `local-onnx` selector
 * turns that null into an explicit error; `auto` turns it into a hash fallback).
 */
export async function createOnnxEmbedder(
  model: string = process.env["KODELA_ONNX_MODEL"] ?? DEFAULT_ONNX_MODEL,
  modelPath?: string,
): Promise<Embedder | null> {
  const mod = await loadTransformers();
  if (!mod) return null;
  applyEnv(mod, modelPath);

  const embedOne = async (text: string): Promise<number[]> => {
    const pipe = await getPipeline(mod, model);
    const out = await pipe(text, { pooling: "mean", normalize: true });
    return toNumberArray(out.data);
  };

  return {
    id: `local-onnx:${model.split("/").pop() ?? model}`,
    kind: "local-onnx",
    dim: ONNX_DIM,
    offline: true,
    embed: embedOne,
    async embedBatch(texts: string[]): Promise<number[][]> {
      // transformers.js returns a flat [n*dim] tensor for an array input;
      // slice it back into per-text rows using the reported dims.
      const pipe = await getPipeline(mod, model);
      const out = await pipe(texts, { pooling: "mean", normalize: true });
      const flat = toNumberArray(out.data);
      const dim = out.dims[out.dims.length - 1] ?? ONNX_DIM;
      const rows: number[][] = [];
      for (let i = 0; i < texts.length; i++) {
        rows.push(flat.slice(i * dim, (i + 1) * dim));
      }
      return rows;
    },
  };
}
