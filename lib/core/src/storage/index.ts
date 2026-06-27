// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
export { guardPath, normalizeRepoPath, hashFilePath } from "./path-guard.js";

export {
  KODELA_DIR,
  ensureKodelaDir,
  readIndex,
  writeIndex,
  readContextEntry,
  writeContextEntry,
  deleteContextEntry,
  readMappingFile,
  writeMappingFile,
  readBaseline,
  writeBaseline,
  formatIndexForMerge,
  ensureGitAttributesUnion,
  readSignOff,
  writeSignOff,
  readComments,
  writeComment,
  resolveComment,
  deleteAllComments,
  writeSession,
  readSession,
  appendEntryToSession,
  closeSession,
  listSessions,
} from "./storage.js";
export type { StorageConfig } from "./storage.js";

export type {
  StorageBackend,
  WriteResult,
  FlushSessionResult,
  BackendMetrics,
} from "./backend.js";

export { LocalStorageBackend } from "./local-backend.js";
export { CentralStorageBackend } from "./central-backend.js";
export type { CentralBackendConfig } from "./central-backend.js";
export {
  createStorageBackend,
  getStorageBackend,
  resetStorageBackend,
} from "./factory.js";
export type { StorageMode, StorageFactoryOptions } from "./factory.js";

export {
  openIndex,
  initSchema,
  closeIndex,
  upsertEntry,
  deleteEntry as deleteEntryFromIndex,
  getEntryIds,
  queryEntries,
  upsertCluster,
  upsertSession,
  linkSessionEntry,
  upsertEmbedding,
  getEmbedding,
  enqueueClusterExtraction,
  getPendingExtractionQueue,
  findEntryByClusterAndFile,
  getCluster,
  queryClusters,
  getSession,
} from "./sqlite-index.js";
export type {
  EntryRow,
  ClusterRow,
  SessionRow,
  EmbeddingRow,
  ExtractionQueueRow,
} from "./sqlite-index.js";
