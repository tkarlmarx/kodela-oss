// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
//
// Community Edition: local SQLite only. The multi-tenant Postgres adapter and
// the Drizzle `db` handle live in the upstream (commercial) repository.
import { SqliteStorage } from "./adapters/sqlite.js";
import type { KodelaStorage } from "./storage.js";

export type {
  KodelaStorage,
  AuditEventRow,
  AuditQueryFilters,
  AuditExportFilters,
  InsertAuditEventData,
  PolicyRow,
  PolicyRuleRow,
  InsertPolicyRuleData,
  UpdatePolicyRuleData,
  RepoLinkRow,
  InsertRepoLinkData,
  SnapshotRow,
  InsertSnapshotData,
  SignOffRecordRow,
  InsertSignOffData,
  SignOffQueryFilters,
  StorageError,
} from "./storage.js";

export * from "./schema/index.js";

let _storage: KodelaStorage | undefined;

/** Community Edition is always local: there is no remote database. */
export function hasDatabaseUrl(): boolean {
  return false;
}

export function getStorage(): KodelaStorage {
  if (!_storage) {
    _storage = new SqliteStorage();
  }
  return _storage;
}
