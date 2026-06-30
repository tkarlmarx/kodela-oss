// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `@kodela/embed` — the pluggable embedding layer behind Kodela's semantic
 * retrieval (E.5). Open-core (AGPL): ships with the CLI and MCP server.
 *
 * Default is real-semantic AND offline (local ONNX), so quality is the
 * out-of-box experience and sensitive reasoning text stays on-device. The cloud
 * provider is an explicit opt-in; the dependency-free hash embedder is the
 * always-available fallback.
 */

export type {
  Embedder,
  EmbedderKind,
  EmbedderSelector,
  ResolveEmbedderOptions,
  ResolvedEmbedder,
} from "./types.js";
export { EmbedderUnavailableError } from "./types.js";

export { resolveEmbedder, resolveSelector } from "./registry.js";
export { createHashEmbedder, HASH_DIM } from "./hash.js";
export { createOnnxEmbedder, probeOnnx, DEFAULT_ONNX_MODEL, ONNX_DIM } from "./onnx.js";
export {
  createProviderEmbedder,
  DEFAULT_PROVIDER_MODEL,
  DEFAULT_PROVIDER_BASE_URL,
} from "./provider.js";
