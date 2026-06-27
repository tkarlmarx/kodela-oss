// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import type {
  FileChange,
  AggregatedFile,
  AggregatedChangeSummary,
  ContextImpact,
  RiskLevel,
} from "./types.js";
import { detectModule } from "./module.js";
import { classifyRisk } from "./classify.js";
import { detectAIChange } from "./ai-detect.js";

/**
 * Aggregate a batch of file changes into a concise, prioritized summary.
 *
 * Pipeline:
 *   1. Return null for empty input.
 *   2. Deduplicate by filePath (highest timestamp wins for duplicates).
 *   3. Compute totalLinesChanged.
 *   4. Classify risk, detect module, and compute context impact per file.
 *   5. Split into high / medium / low risk buckets; sort by linesChanged desc.
 *   6. Apply smart surfacing: top 5 high-risk, top 3 medium-risk.
 *   7. Detect AI change.
 *   8. Generate deterministic 2–4 line summary text.
 *
 * Performance: O(n log n) due to sorting; no nested expensive loops.
 * Determinism: same input always produces the same output.
 */
export function aggregateChanges(
  files: FileChange[],
): AggregatedChangeSummary | null {
  if (files.length === 0) {
    return null;
  }

  // ─── Step 1: Deduplicate by filePath (last-write-wins) ───────────────────
  const fileMap = new Map<string, FileChange>();
  for (const file of files) {
    const existing = fileMap.get(file.filePath);
    if (existing === undefined || file.timestamp >= existing.timestamp) {
      fileMap.set(file.filePath, file);
    }
  }
  const dedupedFiles = Array.from(fileMap.values());

  // ─── Step 2: Totals ───────────────────────────────────────────────────────
  const totalFiles = dedupedFiles.length;
  let totalLinesChanged = 0;
  for (const f of dedupedFiles) {
    totalLinesChanged += f.linesChanged;
  }

  // ─── Step 3: Per-file classification ─────────────────────────────────────
  const allAggregated: AggregatedFile[] = dedupedFiles.map((file) => {
    const module = detectModule(file.filePath);
    const risk = classifyRisk(file);

    const contextImpact: ContextImpact = { mapped: 0, uncertain: 0, orphaned: 0 };
    for (const c of file.contexts) {
      contextImpact[c.status]++;
    }

    return {
      filePath: file.filePath,
      module,
      linesChanged: file.linesChanged,
      risk,
      contextImpact,
    };
  });

  // ─── Step 4: Collect unique modules (stable alphabetical order) ──────────
  const moduleSet = new Set<string>();
  for (const f of allAggregated) {
    moduleSet.add(f.module);
  }
  const modulesAffected = Array.from(moduleSet).sort();

  // ─── Step 5: Risk buckets sorted by linesChanged descending ──────────────
  const sortByLines = (a: AggregatedFile, b: AggregatedFile): number =>
    b.linesChanged - a.linesChanged;

  const highRiskAll = allAggregated.filter((f) => f.risk === "high").sort(sortByLines);
  const mediumRiskAll = allAggregated.filter((f) => f.risk === "medium").sort(sortByLines);
  const lowRiskFiles = allAggregated.filter((f) => f.risk === "low").sort(sortByLines);

  // ─── Step 6: Smart surfacing ──────────────────────────────────────────────
  const highRiskFiles = highRiskAll.slice(0, 5);
  const mediumRiskFiles = mediumRiskAll.slice(0, 3);

  // ─── Step 7: Overall risk score ───────────────────────────────────────────
  let riskScore: RiskLevel = "low";
  if (highRiskAll.length > 0) riskScore = "high";
  else if (mediumRiskAll.length > 0) riskScore = "medium";

  // ─── Step 8: AI detection ─────────────────────────────────────────────────
  const aiDetected = detectAIChange(dedupedFiles, totalLinesChanged);

  // ─── Step 9: Deterministic summary text ───────────────────────────────────
  const summaryText = buildSummaryText({
    totalFiles,
    totalLinesChanged,
    riskScore,
    aiDetected,
    allAggregated,
    highRiskAll,
    mediumRiskAll,
  });

  return {
    totalFiles,
    totalLinesChanged,
    modulesAffected,
    riskScore,
    highRiskFiles,
    mediumRiskFiles,
    lowRiskFiles,
    aiDetected,
    summaryText,
  };
}

type SummaryContext = {
  totalFiles: number;
  totalLinesChanged: number;
  riskScore: RiskLevel;
  aiDetected: boolean;
  allAggregated: AggregatedFile[];
  highRiskAll: AggregatedFile[];
  mediumRiskAll: AggregatedFile[];
};

function buildSummaryText(ctx: SummaryContext): string {
  const {
    totalFiles,
    totalLinesChanged,
    riskScore,
    aiDetected,
    allAggregated,
    highRiskAll,
    mediumRiskAll,
  } = ctx;

  const fileSuffix = totalFiles !== 1 ? "files" : "file";
  const totalOrphaned = allAggregated.reduce(
    (sum, f) => sum + f.contextImpact.orphaned,
    0,
  );
  const allOrphaned =
    allAggregated.length > 0 &&
    allAggregated.every((f) => f.contextImpact.orphaned > 0);
  const attentionCount = highRiskAll.length + mediumRiskAll.length;

  if (riskScore === "low") {
    return (
      `Low-risk change: ${totalFiles} ${fileSuffix} modified (${totalLinesChanged} lines).\n` +
      `No high-risk areas detected.`
    );
  }

  const lines: string[] = [];

  const changeLabel = aiDetected ? "Large AI-assisted" : "Batch";
  lines.push(
    `${changeLabel} change detected: ${totalFiles} ${fileSuffix} modified (${totalLinesChanged} lines).`,
  );

  if (allOrphaned) {
    lines.push(
      `Warning: all context entries are orphaned — manual review required.`,
    );
  } else if (totalOrphaned > 0) {
    lines.push(
      `${totalOrphaned} context entr${totalOrphaned !== 1 ? "ies" : "y"} orphaned across changed files.`,
    );
  }

  const highRiskModules = Array.from(
    new Set(highRiskAll.map((f) => f.module)),
  ).sort();
  if (highRiskModules.length > 0) {
    lines.push(`High-risk areas: ${highRiskModules.join(", ")}.`);
  }

  if (attentionCount > 0) {
    const attentionSuffix = attentionCount !== 1 ? "files require" : "file requires";
    lines.push(
      `${attentionCount} ${attentionSuffix} attention due to low confidence or orphaned context.`,
    );
  }

  return lines.join("\n");
}
