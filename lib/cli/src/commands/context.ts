// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import path from "node:path";
import { openIndex, KODELA_DIR, buildProjectContext } from "@kodela/core";
import type { QueryContext, ProjectContext, ExpansionConfig } from "@kodela/core";
import {
  fetchRemoteContext,
  mergeContexts,
  type FetchRemoteContextOptions,
} from "../context/remoteContext.js";

/**
 * Enterprise shared-memory read mode (`storage.readMode`).
 * - "local"  — read only the local .kodela/ index (default, offline).
 * - "remote" — read the org's shared memory from the server.
 * - "merge"  — union local + remote (local wins ties).
 */
export type ReadMode = "local" | "remote" | "merge";

/** Resolved remote-read credentials + scope; required for remote/merge. */
export interface RemoteReadConfig {
  serverUrl: string;
  apiKey: string;
  orgId: string;
  /** Repo "owner/name" — resolved server-side. Provide this OR repoId. */
  repoFullName?: string;
  /** Raw repo_links id. Provide this OR repoFullName. */
  repoId?: string;
}

export interface ContextOptions {
  repoRoot: string;
  filePath?: string;
  intent?: string;
  budget?: number;
  debug?: boolean;
  output?: "json" | "pretty";
  /** Shared-memory read mode. Defaults to "local". */
  readMode?: ReadMode;
  /** Remote credentials + scope; required when readMode is "remote" or "merge". */
  remote?: RemoteReadConfig;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Called when remote read fails and we fall back to local. */
  onWarn?: (message: string) => void;
}

export interface ContextResult {
  context: ProjectContext;
  /** Which read path actually produced the returned context. */
  source: "local" | "remote" | "merge";
}

/** Read + rank the local SQLite index — the offline path and merge base. */
function readLocalContext(options: ContextOptions): ProjectContext {
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

  return buildProjectContext(db, query, repoRoot, expansionOverride);
}

function remoteRequest(options: ContextOptions): FetchRemoteContextOptions {
  const r = options.remote!;
  return {
    serverUrl: r.serverUrl,
    apiKey: r.apiKey,
    orgId: r.orgId,
    repoFullName: r.repoFullName,
    repoId: r.repoId,
    filePath: options.filePath,
    intent: options.intent,
    tokenBudget: options.budget,
    fetchImpl: options.fetchImpl,
  };
}

export async function runContext(options: ContextOptions): Promise<ContextResult> {
  const readMode = options.readMode ?? "local";
  const warn = (m: string) => options.onWarn?.(m);

  // Pure remote read — never touches the local index unless the remote read
  // fails, in which case we fall back to local so the developer is never left
  // with nothing.
  if (readMode === "remote" && options.remote) {
    try {
      const context = await fetchRemoteContext(remoteRequest(options));
      return { context, source: "remote" };
    } catch (err) {
      warn(
        `Remote context read failed (${err instanceof Error ? err.message : String(err)}); ` +
          `falling back to local.`,
      );
    }
  }

  const localContext = readLocalContext(options);

  // Merge — union the developer's local why with the org's shared memory.
  if (readMode === "merge" && options.remote) {
    try {
      const remote = await fetchRemoteContext(remoteRequest(options));
      return { context: mergeContexts(localContext, remote), source: "merge" };
    } catch (err) {
      warn(
        `Remote context read failed (${err instanceof Error ? err.message : String(err)}); ` +
          `using local only.`,
      );
    }
  }

  return { context: localContext, source: "local" };
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

  const src = result.source === "local" ? "" : ` [${result.source}]`;
  lines.push(`Context${src}: ${context.meta.selectedClusters} cluster(s), ${context.meta.selectedEntries} entr${context.meta.selectedEntries === 1 ? "y" : "ies"} — ${context.meta.tokenUsage} tokens`);

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
