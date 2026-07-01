// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `@kodela/core/comprehension` (Phase 2 — P2.1).
 *
 * The comprehension graph: a file/class/function node graph with plain-English
 * descriptions, fused with the captured why + decision layer. Offline-first —
 * descriptions come from a deterministic heuristic so the CE needs no API key.
 */
export type {
  ComprehensionGraph,
  ComprehensionNode,
  ComprehensionNodeKind,
  ComprehensionEdge,
  ComprehensionEdgeKind,
  WhyLink,
  DecisionLink,
} from "./types.js";

export {
  buildComprehension,
  type ComprehensionFileInput,
  type BuildComprehensionOptions,
} from "./build.js";

export {
  humanizeIdentifier,
  heuristicFunctionDescription,
  heuristicFileDescription,
  bestDescription,
} from "./describe.js";
