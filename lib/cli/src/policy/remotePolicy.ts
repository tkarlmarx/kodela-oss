// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import path from "node:path";
import type { ContextEntry, CodeScope } from "@kodela/core";
import type { KodelaConfig } from "../config/schema.js";

export interface RemotePolicyRule {
  id: string;
  pathGlob: string;
  minConfidence: number | null;
  requireContext: boolean;
  allowedAiTools: string[] | null;
  minSeverity: string | null;
  requireReview: boolean;
  /**
   * Gap 45 — When true, the rule blocks CI for any AI-sourced entry that has
   * `reviewRequired: true` but no sign-off record on disk.
   * The caller must supply `signedOffEntryIds` (the set of entry IDs that have
   * been signed off) for this check to work.
   */
  unsignedAiChanges?: boolean;
  /**
   * Gap 57 — Scope filter.
   * When set, this rule only evaluates entries whose `scope` is in this list.
   * Entries without a `scope` field are always matched (backward compatibility).
   */
  scope?: CodeScope[];
}

export interface RemotePolicy {
  policyId: string;
  name: string;
  rules: RemotePolicyRule[];
}

export interface PolicyViolation {
  ruleId: string;
  pathGlob: string;
  field: string;
  message: string;
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Fetch the active remote policy from the Kodela API server.
 * Sends X-Kodela-Org-Id from the CLI's license for server-side validation.
 * When the license includes an apiSecret, also sends an Authorization: Bearer
 * header so the server can verify request authenticity.
 * Returns null if the server is unreachable or returns an error.
 */
export async function fetchRemotePolicy(
  apiUrl: string,
  orgId: string,
  apiSecret?: string,
): Promise<RemotePolicy | null> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Kodela-Org-Id": orgId,
    };
    if (apiSecret) {
      headers["Authorization"] = `Bearer ${apiSecret}`;
    }
    const res = await fetch(`${apiUrl}/api/dashboard/policy/remote`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as RemotePolicy;
  } catch {
    return null;
  }
}

/**
 * Derive CI thresholds from a remote policy by taking the most restrictive
 * minConfidence across all rules. Falls back to local config if no rule
 * specifies minConfidence.
 */
export function applyRemotePolicyToConfig(
  policy: RemotePolicy,
  localConfig: KodelaConfig,
): KodelaConfig {
  const confidenceValues = policy.rules
    .map((r) => r.minConfidence)
    .filter((v): v is number => v !== null && v !== undefined);

  if (confidenceValues.length === 0) return localConfig;

  const remoteMinConfidence = Math.max(...confidenceValues);

  return {
    ...localConfig,
    ci: {
      ...localConfig.ci,
      thresholds: {
        ...localConfig.ci.thresholds,
        min_confidence_score: Math.max(
          localConfig.ci.thresholds.min_confidence_score,
          remoteMinConfidence,
        ),
      },
    },
  };
}

/**
 * Check individual context entries against each policy rule's per-path
 * constraints: minConfidence, minSeverity, allowedAiTools, requireReview,
 * and unsignedAiChanges.
 *
 * Each rule's `pathGlob` is matched against entry `filePath` values using
 * Node.js built-in `path.matchesGlob`. Rules that match entries but have
 * violated constraints produce a `PolicyViolation` entry.
 *
 * `requireContext` is enforced at the rule level: when true and no entries
 * match the rule's pathGlob, a violation is raised indicating the path
 * pattern lacks any context annotations.
 *
 * `requireReview` flags any AI-authored entry that still has `reviewRequired`
 * set to true, indicating the change has not yet been reviewed.
 *
 * `unsignedAiChanges` (Gap 45) blocks when an AI entry has `reviewRequired`
 * true AND no sign-off record was found on disk.  The caller supplies the
 * pre-loaded set of signed-off entry IDs via `signedOffEntryIds`.
 */
export function checkPolicyViolations(
  entries: ContextEntry[],
  policy: RemotePolicy,
  signedOffEntryIds?: Set<string>,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  for (const rule of policy.rules) {
    const pathMatched = entries.filter((e) => {
      try {
        return path.matchesGlob(e.filePath, rule.pathGlob);
      } catch {
        return false;
      }
    });

    const matched =
      rule.scope && rule.scope.length > 0
        ? pathMatched.filter(
            (e) => e.scope === undefined || rule.scope!.includes(e.scope),
          )
        : pathMatched;

    if (rule.requireContext && matched.length === 0) {
      violations.push({
        ruleId: rule.id,
        pathGlob: rule.pathGlob,
        field: "requireContext",
        message: `Policy rule requires context annotations for "${rule.pathGlob}" but none exist`,
      });
      continue;
    }

    for (const entry of matched) {
      if (rule.minConfidence !== null && entry.confidence < rule.minConfidence) {
        violations.push({
          ruleId: rule.id,
          pathGlob: rule.pathGlob,
          field: "minConfidence",
          message:
            `Entry ${entry.id} (${entry.filePath}) confidence ` +
            `${(entry.confidence * 100).toFixed(1)}% is below rule minimum ` +
            `${(rule.minConfidence * 100).toFixed(1)}% for path "${rule.pathGlob}"`,
        });
      }

      if (rule.minSeverity !== null) {
        const entrySeverityRank = SEVERITY_ORDER[entry.severity] ?? 0;
        const ruleSeverityRank = SEVERITY_ORDER[rule.minSeverity] ?? 0;
        if (entrySeverityRank < ruleSeverityRank) {
          violations.push({
            ruleId: rule.id,
            pathGlob: rule.pathGlob,
            field: "minSeverity",
            message:
              `Entry ${entry.id} (${entry.filePath}) severity "${entry.severity}" ` +
              `is below rule minimum "${rule.minSeverity}" for path "${rule.pathGlob}"`,
          });
        }
      }

      if (rule.allowedAiTools !== null && entry.source === "ai") {
        if (rule.allowedAiTools.length === 0) {
          violations.push({
            ruleId: rule.id,
            pathGlob: rule.pathGlob,
            field: "allowedAiTools",
            message:
              `Entry ${entry.id} (${entry.filePath}) has source "ai" but policy ` +
              `disallows all AI-authored context for path "${rule.pathGlob}"`,
          });
        } else if (!entry.aiTool || !rule.allowedAiTools.includes(entry.aiTool)) {
          violations.push({
            ruleId: rule.id,
            pathGlob: rule.pathGlob,
            field: "allowedAiTools",
            message:
              `Entry ${entry.id} (${entry.filePath}) aiTool "${entry.aiTool ?? "unknown"}" ` +
              `is not in the allowed list [${rule.allowedAiTools.join(", ")}] ` +
              `for path "${rule.pathGlob}"`,
          });
        }
      }

      if (rule.requireReview && entry.source === "ai" && entry.reviewRequired) {
        violations.push({
          ruleId: rule.id,
          pathGlob: rule.pathGlob,
          field: "requireReview",
          message:
            `Entry ${entry.id} (${entry.filePath}) is AI-authored and has not been reviewed ` +
            `but policy requires review for path "${rule.pathGlob}"`,
        });
      }

      if (
        rule.unsignedAiChanges &&
        entry.source === "ai" &&
        entry.reviewRequired &&
        !signedOffEntryIds?.has(entry.id)
      ) {
        violations.push({
          ruleId: rule.id,
          pathGlob: rule.pathGlob,
          field: "unsignedAiChanges",
          message:
            `Entry ${entry.id} (${entry.filePath}) is AI-authored, has reviewRequired: true, ` +
            `and has no sign-off record — policy "unsigned-ai-changes" requires a sign-off ` +
            `for path "${rule.pathGlob}"`,
        });
      }
    }
  }

  return violations;
}
