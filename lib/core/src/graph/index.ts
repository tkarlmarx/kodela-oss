// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
export {
  buildGraph,
  findRiskyModules,
  findOutdatedContext,
  findHighImpactFiles,
  serializeGraph,
} from "./graph.js";

export type {
  FileNode,
  FunctionNode,
  ContextNode,
  GraphNode,
  ContainsEdge,
  ReferenceEdge,
  DependencyEdge,
  GraphEdge,
  ContextGraph,
  SerializedGraph,
} from "./graph.js";

export { detectCommunities } from "./communities.js";
export type { GraphCommunity, CommunityDetectionResult } from "./communities.js";
