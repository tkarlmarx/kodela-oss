// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export {
  startSession,
  linkEntryToSession,
  computeAggregatedRisk,
  closeSession,
  getSessionEntries,
  synthesiseAndWriteSessionSummary,
  updateSessionGoal,
  updateSessionIntent,
  updateSessionActor,
  updateSessionAnnotation,
  updateSessionGitSnapshot,
  appendSessionTurn,
  appendUserTurn,
  appendAssistantTurn,
  readSessionTurns,
  readAssistantTurns,
  appendSessionTimelineEvent,
  readSessionTimeline,
  appendSessionCaptureSource,
  updateSessionCopilotMemory,
} from "./manager.js";
export type {
  StartSessionOptions,
  CloseSessionOptions,
  SessionWithEntries,
  SessionTurnRole,
  SessionTurn,
  UserTurn,
  AssistantTurn,
  SessionTurnInput,
  SessionIntentPatch,
  SessionActorPatch,
  SessionAnnotationPatch,
  SessionGitSnapshot,
  SessionTimelineEvent,
  SessionTimelineEventInput,
} from "./manager.js";

export { synthesiseSessionIntent } from "./synthesizer.js";
export type { ClusterSummary } from "./synthesizer.js";

export {
  buildMCPEnvelope,
  readMCPEnvelope,
  MCPContextEnvelopeSchema,
  MCPFileChangeSchema,
} from "../mcp/builder.js";
export type {
  MCPContextEnvelope,
  MCPFileChange,
  BuildMCPEnvelopeOptions,
} from "../mcp/builder.js";

export { getFilesChangedSince } from "./git-diff-enforcement.js";
export type { GitChangedFile } from "./git-diff-enforcement.js";

export { partitionFiles } from "./auto-exclude.js";
export type { PartitionResult } from "./auto-exclude.js";
