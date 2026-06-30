// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `local-hash` embedder — the dependency-free feature-hashing engine.
 *
 * This wraps `embedTextLocal` from `@kodela/core` (the deterministic
 * "hashing trick" embedder) behind the `Embedder` contract. It carries NO real
 * semantic meaning — texts only score high when they literally share tokens —
 * but it has zero dependencies, zero network, and zero warm-up, so it is the
 * always-available safety net: the `auto` selector falls back to it when the
 * ONNX runtime or model is missing, and CI uses it directly.
 */

import { embedTextLocal } from "@kodela/core";
import type { Embedder } from "./types.js";

/** Default hash dimensionality. Kept distinct from the ONNX dim (384) so a stored
 *  index built by one engine is never mistaken for the other on a bare dim check. */
export const HASH_DIM = 256;

export function createHashEmbedder(dim: number = HASH_DIM): Embedder {
  return {
    id: `local-hash:fh-${dim}`,
    kind: "local-hash",
    dim,
    offline: true,
    embed(text: string): Promise<number[]> {
      return Promise.resolve(embedTextLocal(text, dim));
    },
    embedBatch(texts: string[]): Promise<number[][]> {
      return Promise.resolve(texts.map((t) => embedTextLocal(t, dim)));
    },
  };
}
