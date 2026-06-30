// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { z } from "zod";
import { CodeScopeSchema } from "../scope/classifier.js";

/**
 * Gap 56 — Local-First Policy File Support.
 *
 * A `PolicyRule` controls which annotations must exist in which paths,
 * what minimum quality thresholds they must satisfy, and which AI tools
 * are permitted. All fields are optional; an empty rule matches everything
 * but enforces nothing.
 *
 * `scope` (Gap 57 extension) — when set, this rule only applies to entries
 * whose `scope` is in the provided list.  Entries without a scope field
 * are always matched (backward compatibility).
 */
export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  /**
   * Glob pattern matched against entry `filePath` values.
   * Example: `"src/payments/**"`, `"lib/auth/*.ts"`.
   */
  pathGlob: z.string().min(1),
  /**
   * Minimum acceptable confidence score (0–1) for entries matching this rule.
   * Violations are raised for entries below this value.
   * Absent = no minimum enforced.
   */
  minConfidence: z.number().min(0).max(1).optional(),
  /**
   * When true, at least one annotation must exist for paths matching `pathGlob`.
   * No annotation = violation.
   */
  requireContext: z.boolean().optional(),
  /**
   * Allowlist of AI tool names (e.g. `["copilot", "claude"]`).
   * When set to an empty array, no AI-authored entry is permitted.
   * Absent = any tool is allowed.
   */
  allowedAiTools: z.array(z.string()).optional(),
  /**
   * Minimum severity for entries matching this rule.
   * Entries with a lower severity produce a violation.
   */
  minSeverity: z.enum(["low", "medium", "high", "critical"]).optional(),
  /**
   * When true, all AI-authored entries matching this rule must have
   * `reviewRequired: false` (i.e. they have been reviewed).
   */
  requireReview: z.boolean().optional(),
  /**
   * Gap 57 — Scope filter.
   * When set, this rule only evaluates entries whose `scope` is in this list.
   * Entries without a `scope` field are always matched (backward compatibility).
   */
  scope: z.array(CodeScopeSchema).optional(),
});

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

/**
 * Session-level rule — applies to aggregate statistics across an entire
 * agent session (e.g. the ratio of AI-authored changes).
 *
 * Evaluated by the session analytics engine, not per-entry.
 */
export const SessionRuleSchema = z.object({
  id: z.string().min(1),
  /**
   * Maximum percentage of AI-authored entries allowed within a session.
   * Example: `80` means at most 80% of entries may have `source === "ai"`.
   */
  maxAiPct: z.number().min(0).max(100).optional(),
  /**
   * When true, every AI-authored entry in the session must have a sign-off
   * record before the session is considered compliant.
   */
  requireSignoff: z.boolean().optional(),
  /**
   * Maximum number of orphaned entries allowed across the repo before a
   * merge is blocked.  An orphaned entry is one whose annotated code no
   * longer maps to any line in the current file.
   * Example: `0` means zero orphaned entries permitted (strictest gate).
   * Absent = defaults to 0 (any orphan blocks merge).
   */
  maxOrphanedCount: z.number().min(0).int().optional(),
});

export type SessionRule = z.infer<typeof SessionRuleSchema>;

/**
 * Root schema for `.kodela/policy.json` — the local policy file.
 *
 * File location: `<repoRoot>/.kodela/policy.json`
 * Created by:    `kodela policy init`
 * Validated by:  `kodela policy validate`
 *
 * Rules are evaluated in array order. When multiple rules match the same
 * entry, all matching rules are checked and all violations are reported.
 * When a remote policy is also active, remote rules take precedence over
 * local rules with the same `pathGlob` (the remote rule replaces the local
 * one for that glob).
 */
export const LocalPolicySchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  rules: z.array(PolicyRuleSchema).default(() => []),
  sessionRules: z.array(SessionRuleSchema).default(() => []),
});

export type LocalPolicy = z.infer<typeof LocalPolicySchema>;

export const LOCAL_POLICY_SCHEMA_VERSION = "1.0.0" as const;
