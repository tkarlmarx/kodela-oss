// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import type { ContextEntry } from "@kodela/core";
import type { StatusResult } from "../status/metrics.js";

export type WatchBatchResult = {
  filePaths: string[];
  healed: number;
  total: number;
  failed: number;
  dryRun: boolean;
  durationMs: number;
  updated?: number;
  orphaned?: number;
  uncertain?: number;
};

export function formatWatchBatchResult(result: WatchBatchResult): string {
  const dryPrefix = result.dryRun ? "[DRY RUN] " : "";
  const fileCount = result.filePaths.length;
  const fileSuffix = fileCount === 1 ? "file" : "files";

  if (result.updated !== undefined || result.orphaned !== undefined || result.uncertain !== undefined) {
    const updated = result.updated ?? 0;
    const orphaned = result.orphaned ?? 0;
    const uncertain = result.uncertain ?? 0;
    const orphanedNote = orphaned > 0 ? ` ✗orphaned=${orphaned}` : "";
    const uncertainNote = uncertain > 0 ? ` ⚠uncertain=${uncertain}` : "";
    return `[watch] ${dryPrefix}updated=${updated}${orphanedNote}${uncertainNote} in ${fileCount} ${fileSuffix} (${result.durationMs}ms)`;
  }

  return `[watch] ${dryPrefix}healed ${result.healed}/${result.total} entries in ${fileCount} ${fileSuffix} (${result.durationMs}ms)`;
}

export type EngineWatchBatchResult = {
  filePaths: string[];
  updated: number;
  orphaned: number;
  uncertain: number;
  dryRun: boolean;
  durationMs: number;
};

export function formatEngineWatchBatchResult(result: EngineWatchBatchResult): string {
  const dryPrefix = result.dryRun ? "[DRY RUN] " : "";
  const fileCount = result.filePaths.length;
  const fileSuffix = fileCount === 1 ? "file" : "files";
  const total = result.updated + result.orphaned + result.uncertain;
  return (
    `[watch] ${dryPrefix}healed ${result.updated}/${total} entries in ${fileCount} ${fileSuffix}` +
    ` (${result.durationMs}ms)` +
    ` updated=${result.updated} orphaned=${result.orphaned} uncertain=${result.uncertain}`
  );
}

export const OUTPUT_MODES = ["text", "json", "junit"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

export function formatStatus(result: StatusResult, mode: OutputMode): string {
  switch (mode) {
    case "json":
      return JSON.stringify(
        {
          total: result.total,
          mapped: result.mapped,
          uncertain: result.uncertain,
          orphaned: result.orphaned,
          confidence_score: result.confidence_score,
          orphaned_pct: result.orphaned_pct,
          unresolved_critical_pct: result.unresolved_critical_pct,
          ci_pass: result.ci_pass,
          // Gap 69 — license enforcement mode for CI pipelines consuming JSON.
          // Present only in CI mode (--ci). "advisory" means enforcement was
          // configured but is not licensed and was silently downgraded.
          ...(result.license_enforcement !== undefined
            ? { license_enforcement: result.license_enforcement }
            : {}),
          ...(result.license_enforcement_reason !== undefined
            ? { license_enforcement_reason: result.license_enforcement_reason }
            : {}),
          ...(result.scopeBreakdown ? { scope_breakdown: result.scopeBreakdown } : {}),
        },
        null,
        2,
      );

    case "junit":
      return formatStatusJunit(result);

    default:
      return formatStatusText(result);
  }
}

function formatStatusText(result: StatusResult): string {
  const bar = "─".repeat(40);
  const mapped_pct =
    result.total > 0
      ? ((result.mapped / result.total) * 100).toFixed(1)
      : "0.0";
  const uncertain_pct =
    result.total > 0
      ? ((result.uncertain / result.total) * 100).toFixed(1)
      : "0.0";
  const orphaned_pct =
    result.total > 0
      ? ((result.orphaned / result.total) * 100).toFixed(1)
      : "0.0";

  const ciLine =
    result.ci_pass === undefined
      ? ""
      : `\nCI gate: ${result.ci_pass ? "✓ PASS" : "✗ FAIL"}`;

  const driftLine =
    result.highContentDrift > 0
      ? `  ⚠ High content drift: ${result.highContentDrift} (annotation may be stale — run \`kodela validate\`)`
      : `  ✓ High content drift: 0`;

  const enrichLine =
    (result.enrichableCount ?? 0) > 0
      ? `  ℹ Enrichable notes:  ${result.enrichableCount} (auto-annotated notes can be improved — run \`kodela enrich --list\`)`
      : undefined;

  const scopeLines: string[] = [];
  if (result.scopeBreakdown && Object.keys(result.scopeBreakdown).length > 0) {
    scopeLines.push("");
    scopeLines.push("Scope breakdown:");
    const sorted = Object.entries(result.scopeBreakdown).sort((a, b) => b[1] - a[1]);
    for (const [scope, count] of sorted) {
      scopeLines.push(`  ${scope.padEnd(10)} ${count}`);
    }
  }

  return [
    "Kodela Context Health",
    bar,
    `Total entries:      ${result.total}`,
    `  ✓ Mapped:         ${result.mapped} (${mapped_pct}%)`,
    `  ⚠ Uncertain:      ${result.uncertain} (${uncertain_pct}%)`,
    `  ✗ Orphaned:       ${result.orphaned} (${orphaned_pct}%)`,
    driftLine,
    enrichLine,
    ...scopeLines,
    "",
    "Trust signals:",
    `  Confidence score:           ${(result.confidence_score * 100).toFixed(1)}%`,
    `  Orphaned %:                 ${result.orphaned_pct.toFixed(2)}%`,
    `  Unresolved critical %:      ${result.unresolved_critical_pct.toFixed(2)}%`,
    ciLine,
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

function formatStatusJunit(result: StatusResult): string {
  const pass = result.ci_pass !== false;
  const failures: string[] = [];

  if (!pass) {
    if (result._breachedThresholds) {
      for (const t of result._breachedThresholds) {
        failures.push(
          `    <failure message="${escapeXml(t.message)}" type="ThresholdBreach">${escapeXml(t.message)}</failure>`,
        );
      }
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="kodela-status" tests="3" failures="${failures.length}">`,
    '  <testsuite name="context-health" tests="3">',
    `    <testcase name="confidence_score" classname="kodela">`,
    pass ? "" : failures.find((f) => f.includes("confidence")) ?? "",
    "    </testcase>",
    `    <testcase name="orphaned_pct" classname="kodela">`,
    pass ? "" : failures.find((f) => f.includes("orphaned")) ?? "",
    "    </testcase>",
    `    <testcase name="unresolved_critical_pct" classname="kodela">`,
    pass
      ? ""
      : failures.find((f) => f.includes("critical")) ?? "",
    "    </testcase>",
    "  </testsuite>",
    "</testsuites>",
  ]
    .filter(Boolean)
    .join("\n");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type FormatEntryOptions = {
  /**
   * Gap 20d — author privacy.
   * When false (default) the `Author:` field is omitted from text output.
   * Framing reports as "notes to future you" rather than blame avoids trust
   * erosion. Pass `showAuthor: true` (e.g. `--show-author` CLI flag) to
   * include it. Author is always present in JSON output.
   */
  showAuthor?: boolean;
};

export function formatEntry(
  entry: ContextEntry,
  mode: OutputMode,
  opts: FormatEntryOptions = {},
): string {
  if (mode === "json") {
    return JSON.stringify(entry, null, 2);
  }
  const statusIcon =
    entry.status === "mapped"
      ? "✓"
      : entry.status === "uncertain"
        ? "⚠"
        : "✗";
  const severityTag =
    entry.severity !== "low" ? ` [${entry.severity}]` : "";
  const tagsStr = entry.tags.length > 0 ? ` | Tags: ${entry.tags.join(", ")}` : "";
  const reviewFlag = entry.reviewRequired ? " | review required" : "";

  // Gap 20d — hide author in default text output; show only when showAuthor is requested.
  const authorPrefix = opts.showAuthor ? `Author: ${entry.author} | ` : "";

  // Gap 48 — content drift banner (shown before the note so it's hard to miss).
  const driftBanner =
    entry.contentDrift === "high"
      ? "  ⚠ Content drift: HIGH — this annotation may no longer describe the current code. Run `kodela validate` to check."
      : entry.contentDrift === "medium"
        ? "  ⚠ Content drift: MEDIUM — code has changed noticeably since this annotation was written."
        : undefined;

  // Gap 57 — show structured scope label when set and not the default "general".
  const scopePart =
    entry.scope && entry.scope !== "general" ? ` | Scope: ${entry.scope}` : "";

  const lines = [
    `${statusIcon} ${entry.filePath}:${entry.lineRange.start}-${entry.lineRange.end} [${entry.status} | ${(entry.confidence * 100).toFixed(0)}%]${severityTag}`,
    ...(driftBanner ? [driftBanner] : []),
    `  Note: ${entry.note}`,
    `  ${authorPrefix}Added: ${entry.createdAt.split("T")[0] ?? entry.createdAt} | Source: ${entry.source}${scopePart}${tagsStr}${reviewFlag}`,
  ];

  // Gap 24 Phase F — render UBA classification signals when present
  if (entry.classificationSignals && Object.keys(entry.classificationSignals).length > 0) {
    const signals = entry.classificationSignals;
    const parts: string[] = [];
    if (signals["editPattern"] !== undefined) parts.push(`edit=${signals["editPattern"].toFixed(2)}`);
    if (signals["temporalSignature"] !== undefined) parts.push(`temporal=${signals["temporalSignature"].toFixed(2)}`);
    if (signals["fileScope"] !== undefined) parts.push(`fileScope=${signals["fileScope"].toFixed(2)}`);
    if (signals["structuralChange"] !== undefined) parts.push(`structural=${signals["structuralChange"].toFixed(2)}`);
    if (signals["environment"] !== undefined) parts.push(`env=${signals["environment"].toFixed(2)}`);
    const scoreStr = entry.classificationScore !== undefined
      ? ` → score=${entry.classificationScore.toFixed(2)}`
      : "";
    lines.push(`  UBA signals: ${parts.join(" | ")}${scoreStr}`);
  }

  if (entry.userOverride) {
    lines.push("  [User override — locked against auto-reclassification]");
  }

  // Gap 13 — render AI decision context when present
  if (entry.origin) {
    const o = entry.origin;
    if (o.summary) {
      lines.push(`  Decision: ${o.summary}`);
    }
    if (o.reasoning && o.reasoning.length > 0) {
      lines.push(`  Reasoning:`);
      for (const step of o.reasoning) {
        lines.push(`    • ${step}`);
      }
    }
    const meta: string[] = [];
    if (o.tool) meta.push(`tool=${o.tool}`);
    if (o.model) meta.push(`model=${o.model}`);
    if (o.sessionId) meta.push(`session=${o.sessionId}`);
    if (o.promptHash) meta.push(`promptHash=${o.promptHash.slice(0, 12)}…`);
    if (meta.length > 0) {
      lines.push(`  Origin: ${meta.join(" | ")}`);
    }
  }

  // Gap 50 — External reference to the issue/document that drove the change.
  if (entry.externalRef) {
    const ref = entry.externalRef;
    const titlePart = ref.title ? `${ref.title} – ` : "";
    lines.push(`  Reference: ${titlePart}${ref.url}`);
  }

  return lines.join("\n");
}

export function formatEntries(
  entries: ContextEntry[],
  mode: OutputMode,
  opts: FormatEntryOptions = {},
): string {
  if (mode === "json") {
    return JSON.stringify(entries, null, 2);
  }
  if (entries.length === 0) {
    return "No context entries found.";
  }
  return entries.map((e) => formatEntry(e, mode, opts)).join("\n\n");
}
