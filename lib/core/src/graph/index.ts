// SPDX-License-Identifier: Apache-2.0
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

export { importEdges, extractRelativeImports } from "./importEdges.js";
export type { ImportEdge, ImportEdgeFile } from "./importEdges.js";
