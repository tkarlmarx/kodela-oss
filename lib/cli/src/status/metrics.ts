// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import type { ContextEntry } from "@kodela/core";
import type { KodelaConfig } from "../config/schema.js";

export type ThresholdBreach = { field: string; message: string };

export type StatusResult = {
  total: number;
  mapped: number;
  uncertain: number;
  orphaned: number;
  confidence_score: number;
  orphaned_pct: number;
  unresolved_critical_pct: number;
  /** Gap 48 — count of entries with contentDrift === "high". */
  highContentDrift: number;
  /**
   * Gap 57 — Breakdown of entry counts by code scope.
   * Only includes scopes that have at least one entry.
   * Absent when no entries have a scope field set.
   */
  scopeBreakdown?: Record<string, number>;
  /**
   * Gap 76 — Number of auto-annotated entries flagged with
   * `canUpgradeAttribution: true`, indicating their notes could be enriched
   * with better attribution data via `kodela enrich`.
   */
  enrichableCount?: number;
  ci_pass?: boolean;
  /**
   * Gap 69 — present only when running in CI mode (`--ci`).
   * `"enforcement"` means the license covers `ci_enforcement` and thresholds
   * are enforced (exit code 1 on breach).
   * `"advisory"` means `ci.enforcement` is set to `"enforcement"` in config
   * but the license does not include the `ci_enforcement` feature, so the gate
   * is silently downgraded — thresholds are reported but the commit is never
   * blocked.  CI tooling consuming JSON output should check this field to
   * detect the silent downgrade.
   */
  license_enforcement?: "advisory" | "enforcement";
  /**
   * Gap 69 — human-readable explanation for why `license_enforcement` is
   * `"advisory"` rather than `"enforcement"`.  Absent when not in advisory
   * mode.
   */
  license_enforcement_reason?: string;
  _breachedThresholds?: ThresholdBreach[];
};

export function computeMetrics(entries: ContextEntry[]): Omit<StatusResult, "ci_pass" | "license_enforcement" | "license_enforcement_reason" | "_breachedThresholds"> {
  const total = entries.length;
  if (total === 0) {
    return {
      total: 0,
      mapped: 0,
      uncertain: 0,
      orphaned: 0,
      confidence_score: 1.0,
      orphaned_pct: 0,
      unresolved_critical_pct: 0,
      highContentDrift: 0,
      enrichableCount: 0,
    };
  }

  const mapped = entries.filter((e) => e.status === "mapped").length;
  const uncertain = entries.filter((e) => e.status === "uncertain").length;
  const orphaned = entries.filter((e) => e.status === "orphaned").length;

  const confidence_score =
    entries.reduce((sum, e) => sum + e.confidence, 0) / total;

  const orphaned_pct = (orphaned / total) * 100;

  const criticalEntries = entries.filter(
    (e) => e.severity === "critical" || e.severity === "high",
  );
  const unresolvedCritical = criticalEntries.filter(
    (e) => e.status !== "mapped" || e.reviewRequired,
  );
  const unresolved_critical_pct =
    criticalEntries.length > 0
      ? (unresolvedCritical.length / criticalEntries.length) * 100
      : 0;

  // Gap 48 — count entries where content may have drifted from the annotation.
  const highContentDrift = entries.filter((e) => e.contentDrift === "high").length;

  // Gap 57 — scope breakdown.
  const scopeMap: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.scope) {
      scopeMap[entry.scope] = (scopeMap[entry.scope] ?? 0) + 1;
    }
  }
  const scopeBreakdown = Object.keys(scopeMap).length > 0 ? scopeMap : undefined;

  // Gap 76 — count entries that could benefit from note enrichment.
  const enrichableCount = entries.filter((e) => e.canUpgradeAttribution === true).length;

  return {
    total,
    mapped,
    uncertain,
    orphaned,
    confidence_score,
    orphaned_pct,
    unresolved_critical_pct,
    highContentDrift,
    scopeBreakdown,
    enrichableCount,
  };
}

export function checkCiThresholds(
  metrics: Omit<StatusResult, "ci_pass" | "license_enforcement" | "license_enforcement_reason" | "_breachedThresholds">,
  config: KodelaConfig,
): { pass: boolean; breached: ThresholdBreach[] } {
  const { thresholds } = config.ci;
  const breached: ThresholdBreach[] = [];

  if (metrics.confidence_score < thresholds.min_confidence_score) {
    breached.push({
      field: "confidence_score",
      message: `Confidence score ${(metrics.confidence_score * 100).toFixed(1)}% is below threshold ${(thresholds.min_confidence_score * 100).toFixed(1)}%`,
    });
  }

  if (metrics.orphaned_pct > thresholds.max_orphaned_pct) {
    breached.push({
      field: "orphaned_pct",
      message: `Orphaned % ${metrics.orphaned_pct.toFixed(1)}% exceeds threshold ${thresholds.max_orphaned_pct.toFixed(1)}%`,
    });
  }

  if (metrics.unresolved_critical_pct > thresholds.max_unresolved_critical_pct) {
    breached.push({
      field: "unresolved_critical_pct",
      message: `Unresolved critical % ${metrics.unresolved_critical_pct.toFixed(1)}% exceeds threshold ${thresholds.max_unresolved_critical_pct.toFixed(1)}%`,
    });
  }

  return { pass: breached.length === 0, breached };
}

export function buildStatusResult(
  entries: ContextEntry[],
  config: KodelaConfig,
  ciMode: boolean,
): StatusResult {
  const metrics = computeMetrics(entries);

  if (!ciMode) {
    return metrics;
  }

  const { pass, breached } = checkCiThresholds(metrics, config);
  const enforcement = config.ci.enforcement;

  return {
    ...metrics,
    ci_pass: enforcement === "enforcement" ? pass : true,
    _breachedThresholds: breached,
  };
}
