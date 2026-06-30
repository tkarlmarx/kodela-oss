// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export {
  CONFIDENCE_THRESHOLD,
  classifyConfidence,
} from "./confidence.js";
export type { MappingResult } from "./confidence.js";

export {
  isAstLayerApplicable,
  buildAstFingerprint,
  buildAstAnchor,
  buildAstAnchorAsync,
  computeBodyHash,
  mapWithAstLayer,
  mapWithAstLayerAsync,
  searchForMovedEntry,
} from "./ast-layer.js";
export type { MovedEntryMatch } from "./ast-layer.js";

export {
  hashTokenStream,
  mapWithTokenHashLayer,
} from "./token-hash-layer.js";

export { mapWithGitDiffLayer } from "./git-diff-layer.js";

export {
  selectMappingLayer,
  mapContextEntry,
} from "./mapping-engine.js";
export type {
  MappingLayerName,
  DetailedMappingResult,
} from "./mapping-engine.js";

export { mapContexts } from "./mapper.js";
export type {
  ContextItem,
  MapContextsOptions,
  MappingResult as MapperMappingResult,
} from "./mapper.js";
