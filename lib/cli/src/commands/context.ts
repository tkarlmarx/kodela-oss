// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import path from "node:path";
import { openIndex, KODELA_DIR, buildProjectContext } from "@kodela/core";
import type { QueryContext, ProjectContext, ExpansionConfig } from "@kodela/core";

export interface ContextOptions {
  repoRoot: string;
  filePath?: string;
  intent?: string;
  budget?: number;
  debug?: boolean;
  output?: "json" | "pretty";
}

export interface ContextResult {
  context: ProjectContext;
}

export async function runContext(options: ContextOptions): Promise<ContextResult> {
  const { repoRoot, filePath, intent, budget, debug } = options;

  const dbPath = path.join(repoRoot, KODELA_DIR, "index.db");
  const db = openIndex(dbPath);

  const query: QueryContext = {
    filePath,
    intent,
    tokenBudget: budget,
    debug: debug === true,
  };

  const expansionOverride: Partial<ExpansionConfig> = {};
  if (budget !== undefined) {
    expansionOverride.tokenBudget = budget;
  }

  const context = buildProjectContext(db, query, repoRoot, expansionOverride);
  return { context };
}

export function formatContextResult(result: ContextResult, debug: boolean): string {
  const { context } = result;

  if (debug && context.debug) {
    return JSON.stringify({ context, debug: context.debug }, null, 2);
  }

  const output: Record<string, unknown> = {
    clusters: context.clusters,
    entries: context.entries,
    sessions: context.sessions,
    meta: context.meta,
  };
  if (context.warnings && context.warnings.length > 0) {
    output.warnings = context.warnings;
  }

  return JSON.stringify(output, null, 2);
}

export function formatContextResultPretty(result: ContextResult, debug: boolean): string {
  const { context } = result;
  const lines: string[] = [];

  lines.push(`Context: ${context.meta.selectedClusters} cluster(s), ${context.meta.selectedEntries} entr${context.meta.selectedEntries === 1 ? "y" : "ies"} — ${context.meta.tokenUsage} tokens`);

  if (context.clusters.length > 0) {
    lines.push("\nClusters:");
    for (const c of context.clusters) {
      const files = c.filesChanged.slice(0, 3).join(", ");
      const more = c.filesChanged.length > 3 ? ` +${c.filesChanged.length - 3} more` : "";
      lines.push(`  • [v${c.version}] ${c.id.slice(0, 8)} — ${c.goal ?? c.scope ?? "no label"} (${files}${more})`);
    }
  }

  if (context.entries.length > 0) {
    lines.push("\nEntries:");
    for (const e of context.entries) {
      lines.push(`  • ${e.filePath} [score: ${(e.confidence * 100).toFixed(0)}%] cluster: ${e.clusterId?.slice(0, 8) ?? "none"}`);
    }
  }

  if (context.warnings && context.warnings.length > 0) {
    lines.push("\nWarnings:");
    for (const w of context.warnings) {
      lines.push(`  ⚠ ${w}`);
    }
  }

  if (context.meta.timing) {
    const t = context.meta.timing;
    lines.push(`\nTiming: ${t.totalMs}ms (query=${t.queryMs} cluster=${t.clusterMs} scoring=${t.scoringMs} expansion=${t.expansionMs} assembly=${t.assemblyMs})`);
  }

  if (debug && context.debug) {
    lines.push("\n--- Debug: Scoring Breakdown ---");
    lines.push(JSON.stringify(context.debug, null, 2));
  }

  return lines.join("\n");
}
