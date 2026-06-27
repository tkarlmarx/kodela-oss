// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import type { KodelaConfig } from "../config/schema.js";
import { fetchRemotePolicy } from "./remotePolicy.js";
import type { RemotePolicy, RemotePolicyRule } from "./remotePolicy.js";
import { loadLocalPolicy } from "./localPolicy.js";
import type { PolicyRule } from "@kodela/core";
import type { CodeScope } from "@kodela/core";
import { loadLicense, licenseHasFeature } from "@kodela/core";
import path from "node:path";

/**
 * Convert a core `PolicyRule` (from the local policy schema) to a
 * `RemotePolicyRule` that the existing `checkPolicyViolations` function
 * can consume. Null-coalesces optional fields to the sentinel values
 * that `checkPolicyViolations` expects.
 */
function localRuleToRemoteRule(rule: PolicyRule): RemotePolicyRule {
  return {
    id: rule.id,
    pathGlob: rule.pathGlob,
    minConfidence: rule.minConfidence ?? null,
    requireContext: rule.requireContext ?? false,
    allowedAiTools: rule.allowedAiTools ?? null,
    minSeverity: rule.minSeverity ?? null,
    requireReview: rule.requireReview ?? false,
    scope: rule.scope as CodeScope[] | undefined,
  };
}

export type EffectivePolicySource = "local" | "remote" | "merged" | "none";

export interface EffectivePolicyResult {
  policy: RemotePolicy | null;
  source: EffectivePolicySource;
}

/**
 * Gap 56 — Load the effective policy for the repository.
 *
 * Merging strategy (remote wins on same pathGlob):
 *   1. Load the local policy from `.kodela/policy.json` (if present).
 *   2. Fetch the remote policy from the Kodela API server (if the license
 *      includes `policy_engine` and `KODELA_API_URL` is set).
 *   3. Merge: for each `pathGlob` that appears in both local and remote,
 *      the remote rule is used and the local rule is discarded.
 *      Rules unique to local are kept as-is.
 *
 * Returns `{ policy: null, source: "none" }` when neither local nor remote
 * policy is available.
 */
export async function loadEffectivePolicy(
  repoRoot: string,
  config: KodelaConfig,
): Promise<EffectivePolicyResult> {
  const explicitLicensePath = config.license
    ? path.isAbsolute(config.license)
      ? config.license
      : path.resolve(repoRoot, config.license)
    : undefined;

  const [localPolicy, license] = await Promise.all([
    loadLocalPolicy(repoRoot).catch(() => null),
    loadLicense(repoRoot, explicitLicensePath).catch(() => null),
  ]);

  let remotePolicy: RemotePolicy | null = null;
  if (license && licenseHasFeature(license, "policy_engine")) {
    const apiUrl = process.env["KODELA_API_URL"];
    if (apiUrl && license.orgId) {
      remotePolicy = await fetchRemotePolicy(apiUrl, license.orgId, license.apiSecret).catch(
        () => null,
      );
    }
  }

  if (!localPolicy && !remotePolicy) {
    return { policy: null, source: "none" };
  }

  if (!localPolicy && remotePolicy) {
    return { policy: remotePolicy, source: "remote" };
  }

  if (localPolicy && !remotePolicy) {
    const policy: RemotePolicy = {
      policyId: "local",
      name: "Local Policy",
      rules: localPolicy.rules.map(localRuleToRemoteRule),
    };
    return { policy, source: "local" };
  }

  const remote = remotePolicy!;
  const remoteGlobs = new Set(remote.rules.map((r) => r.pathGlob));

  const localRulesNotInRemote = localPolicy!.rules
    .filter((r) => !remoteGlobs.has(r.pathGlob))
    .map(localRuleToRemoteRule);

  const mergedRules: RemotePolicyRule[] = [...remote.rules, ...localRulesNotInRemote];

  const mergedPolicy: RemotePolicy = {
    policyId: remote.policyId,
    name: remote.name,
    rules: mergedRules,
  };

  return { policy: mergedPolicy, source: "merged" };
}
