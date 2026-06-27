// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/** Phase 5 audit barrel. */

export type {
  AuditEventKind,
  AuditPayload,
  AuditEntry,
  CreateEntryOptions,
  VerifyChainResult,
} from "./hash-chain.js";
export {
  appendEntry,
  readChain,
  createEntry,
  verifyChain,
  verifyChainAt,
  hashPayload,
  hashEntry,
} from "./hash-chain.js";

export type { RtbfInventory, RtbfProof, PerformRtbfOptions } from "./rtbf.js";
export { buildInventory, performRtbf, verifyProofFile } from "./rtbf.js";

export type { LogCaptureDenialArgs } from "./capture-denied.js";
export { logCaptureDenial } from "./capture-denied.js";

export {
  encryptField,
  decryptField,
  encryptFieldsInPlace,
  decryptFieldsInPlace,
  isEncrypted,
  isEncryptionEnabled,
  getCurrentKey,
  _setKeyringForTests,
  _clearKeyringForTests,
} from "./encryption.js";
