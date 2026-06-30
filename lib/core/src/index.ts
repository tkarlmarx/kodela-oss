// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export * from "./schema/index.js";
export {
  ReasoningObjectSchema,
  ReasoningConfidenceSchema,
  ExtractionMethodSchema,
  buildExtractionPrompt,
  buildRetryPrompt,
  buildFallbackReasoning,
  validateReasoningResponse,
  extractReasoning,
} from "./reasoning/index.js";
export type {
  ReasoningObject,
  ReasoningConfidence,
  ExtractionMethod,
  ExtractReasoningOptions,
} from "./reasoning/index.js";
export * from "./engine/index.js";
export * from "./storage/index.js";
export * from "./baseline/index.js";
export * from "./errors.js";
export * from "./env/index.js";
export * from "./aggregation/index.js";
export * from "./license/index.js";
export * from "./ai-tool-resolver/index.js";
export * from "./scope/index.js";
export * from "./policy/index.js";
export * from "./capture/index.js";
export {
  ATTRIBUTION_CONFIDENCE,
  isMeaningfulChange,
  readOriginSidecar,
  detectFromGitTrailer,
  runAttributionPipeline,
  SessionTracker,
  AnnotationDeduplicator,
} from "./attribution/index.js";
export type {
  AttributionResult,
  AttributionSource,
  AttributionPipelineOptions,
  AgentSession,
  SidecarData,
} from "./attribution/index.js";
export { ubaScore } from "./attribution/uba-scorer.js";
export type { UbaSignals, UbaResult } from "./attribution/uba-scorer.js";

export * from "./telemetry/index.js";
export {
  buildMCPEnvelope,
  readMCPEnvelope,
  MCPContextEnvelopeSchema,
  MCPFileChangeSchema,
} from "./mcp/index.js";
export type { MCPContextEnvelope, MCPFileChange, BuildMCPEnvelopeOptions } from "./mcp/index.js";
export * from "./graph/index.js";

export {
  cosineSimilarity,
  hashNote,
  readEmbeddingStore,
  upsertEmbeddingRecord,
  deleteEmbeddingRecord,
  semanticSearch,
  embedTextLocal,
  buildEmbeddingIndex,
  EMBEDDINGS_FILE,
} from "./semantic-search/index.js";
export type {
  EmbeddingRecord,
  SemanticHit,
} from "./semantic-search/index.js";

export {
  extractFingerprint,
  computeJaccard,
  computeContentDrift,
} from "./staleness/index.js";

export {
  processEvent,
  onNewPrompt,
  closeSession,
  getActiveCluster,
  linkEntryToCluster,
  shouldStartNewCluster,
} from "./clustering/engine.js";
export type {
  HookEvent,
  ClusteringConfig,
  ProcessEventResult,
} from "./clustering/engine.js";

export {
  parsePatchHunks,
  findAnnotationsInDiff,
} from "./pr-diff/index.js";
export type {
  DiffHunk,
  ParsedDiff,
  AnnotationInDiff,
} from "./pr-diff/index.js";

export {
  confidenceToTrustLevel,
  normalizeContext,
  createObjectEntry,
} from "./context-event/index.js";
export type {
  TrustLevel,
  ContextEvent,
  NormalizedContextEvent,
  CreateObjectEntryOptions,
} from "./context-event/index.js";

export { summarize, detectChangeType, classifyRisk, extractIntent, generateSummary } from "./annotation/summarize.js";
export type { SummarizeInput, AnnotationSummary as SummaryResult } from "./annotation/summarize.js";

export { enrichEntry } from "./annotation/enrich.js";
export type { EnrichOptions } from "./annotation/enrich.js";

export { ingestAIContext } from "./ingest/ingestAIContext.js";
export type { AIContextInput } from "./ingest/ingestAIContext.js";

export { buildProjectContext } from "./context/index.js";
export { scoreEntry, scoreEntries } from "./context/index.js";
export { resolveClusterLineage, clusterRowToIntentCluster } from "./context/index.js";
export { expandCluster, estimateTokens } from "./context/index.js";
export { loadContextConfig } from "./context/index.js";
export type {
  QueryContext,
  ExpansionConfig,
  ScoringWeights,
  EntryScoreBreakdown,
  ScoredEntryRow,
  ClusterEntrySummary,
  TimingBreakdown,
  DebugCandidate,
  DebugClusterSelection,
  DebugContext,
  ProjectContextMeta,
  ProjectContext,
  LineageResult,
  ExpandedCluster,
  BudgetState,
  ContextConfig,
} from "./context/index.js";
export { DEFAULT_EXPANSION_CONFIG, DEFAULT_WEIGHTS } from "./context/index.js";

export { buildHandoff } from "./handoff/index.js";
export type {
  KodelaHandoff,
  HandoffFileChange,
  HandoffConversationExchange,
  HandoffBuildOptions,
  HandoffEntry,
  HandoffSessionMeta,
} from "./handoff/index.js";
export * from "./rbac/index.js";
