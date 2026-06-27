// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import path from "node:path";
import { readIndex, readContextEntry, loadLicense, licenseHasFeature } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { loadConfig } from "../config/loader.js";
import { buildStatusResult, type StatusResult } from "../status/metrics.js";
import { formatStatus, type OutputMode } from "../output/formatters.js";
import { applyRemotePolicyToConfig, checkPolicyViolations } from "../policy/remotePolicy.js";
import { loadEffectivePolicy } from "../policy/policyLoader.js";
import { pushSnapshotToServer } from "../snapshot/pushSnapshot.js";

export type StatusOptions = {
  ci?: boolean;
  output?: OutputMode;
  repoRoot: string;
};

export async function readAllEntries(repoRoot: string): Promise<ContextEntry[]> {
  const index = await readIndex(repoRoot);
  const entries = await Promise.all(
    index.entries.map((id) => readContextEntry(repoRoot, id)),
  );
  return entries;
}

export async function runStatus(opts: StatusOptions): Promise<{
  result: StatusResult;
  output: string;
  exitCode: number;
}> {
  const { repoRoot, ci = false, output = "text" } = opts;

  const [entries, localConfig] = await Promise.all([
    readAllEntries(repoRoot),
    loadConfig(repoRoot),
  ]);

  const explicitLicensePath = localConfig.license
    ? path.isAbsolute(localConfig.license)
      ? localConfig.license
      : path.resolve(repoRoot, localConfig.license)
    : undefined;

  const license = await loadLicense(repoRoot, explicitLicensePath);

  let config = localConfig;
  const { policy: effectivePolicy } = await loadEffectivePolicy(repoRoot, localConfig);

  if (effectivePolicy) {
    config = applyRemotePolicyToConfig(effectivePolicy, localConfig);
  }

  const result = buildStatusResult(entries, config, ci);

  if (ci && effectivePolicy) {
    const policyViolations = checkPolicyViolations(entries, effectivePolicy);
    if (policyViolations.length > 0) {
      result.ci_pass = false;
      result._breachedThresholds = [
        ...(result._breachedThresholds ?? []),
        ...policyViolations.map((v) => ({ field: v.field, message: v.message })),
      ];
    }
  }

  const ciEnforcementLicensed = licenseHasFeature(license, "ci_enforcement");

  // Gap 69 — set license_enforcement on the result BEFORE calling formatStatus
  // so the field appears in JSON output consumed by CI pipelines.
  let exitCode = 0;
  if (ci) {
    if (ciEnforcementLicensed) {
      result.license_enforcement = "enforcement";
      if (result.ci_pass === false) {
        exitCode = 1;
      }
    } else if (config.ci.enforcement === "enforcement") {
      // Enforcement configured but not licensed — degrade to advisory.
      result.license_enforcement = "advisory";
      result.license_enforcement_reason =
        "ci_enforcement feature requires a Team or Enterprise license";
    }
  }

  let text = formatStatus(result, output);

  // Append human-readable advisory in text mode so terminal output remains
  // informative.  JSON consumers use the license_enforcement field instead.
  if (
    ci &&
    !ciEnforcementLicensed &&
    config.ci.enforcement === "enforcement" &&
    output === "text"
  ) {
    text +=
      "\n[Kodela] CI enforcement is configured but requires a Team or Enterprise license.\n" +
      "         Running in advisory mode — thresholds are reported but the commit is not blocked.\n" +
      "         See https://kodela.dev/pricing to upgrade.\n";
  }

  // Push snapshot to the API server when KODELA_API_URL is configured and the
  // license includes the dashboard feature. This is non-fatal — failures are
  // silently swallowed so they never affect the status output or exit code.
  const apiUrl = process.env["KODELA_API_URL"];
  if (apiUrl && license?.orgId && licenseHasFeature(license, "dashboard")) {
    void pushSnapshotToServer(
      apiUrl,
      license.orgId,
      license.apiSecret,
      repoRoot,
      result,
      entries,
    ).catch(() => {
      // non-fatal — snapshot push failure never blocks status output
    });
  }

  return { result, output: text, exitCode };
}
