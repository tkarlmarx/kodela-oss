// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
export {
  PolicyRuleSchema,
  SessionRuleSchema,
  LocalPolicySchema,
  LOCAL_POLICY_SCHEMA_VERSION,
} from "./local-policy.schema.js";
export type { PolicyRule, SessionRule, LocalPolicy } from "./local-policy.schema.js";

// Phase 5 — capture policy + secrets scan.
export {
  CapturePolicySchema,
  RedactRuleSchema,
  OPEN_POLICY,
  capturePolicyPathFor,
  loadCapturePolicy,
  globMatches,
  isPathExcluded,
  isAgentAllowed,
  isModelAllowed,
  applyRedactRules,
  evaluateCapture,
} from "./capture-policy.js";
export type { CapturePolicy, RedactRule, CaptureDecision } from "./capture-policy.js";
export {
  scanString,
  scanForSecrets,
  containsSecrets,
} from "./secrets-scan.js";
export type { SecretMatch, SecretMatchKind } from "./secrets-scan.js";
