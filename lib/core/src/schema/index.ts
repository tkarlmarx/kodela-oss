// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export {
  SCHEMA_VERSION,
  AstAnchorSchema,
  LineRangeSchema,
  SeveritySchema,
  SourceSchema,
  MappingStatusSchema,
  OriginSchema,
  ExternalRefSchema,
  ContextEntrySchema,
  IndexFileSchema,
  MappingFileSchema,
  BaselineFileSchema,
  SignOffRecordSchema,
  ContextCommentSchema,
} from "./context-entry.schema.js";

export type {
  AstAnchor,
  LineRange,
  Severity,
  Source,
  MappingStatus,
  Origin,
  ExternalRef,
  ContextEntry,
  IndexFile,
  MappingFile,
  BaselineFile,
  SignOffRecord,
  ContextComment,
} from "./context-entry.schema.js";

export {
  IntentClusterTriggerSchema,
  IntentClusterSchema,
  SessionRecordSchema,
  AggregatedRiskSchema,
} from "./intent-cluster.schema.js";

export type {
  IntentClusterTrigger,
  IntentCluster,
  SessionRecord,
  AggregatedRisk,
} from "./intent-cluster.schema.js";

export { KodelaSessionSchema } from "./session.schema.js";
export type { KodelaSession } from "./session.schema.js";
