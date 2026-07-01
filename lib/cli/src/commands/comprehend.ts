// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela comprehend` (Phase 2 — P2.1 comprehension graph).
 *
 * "Help me understand this codebase." Walks the tracked source files, parses
 * their functions/classes with the tree-sitter layer, and builds a
 * file→class→function node graph with plain-English descriptions — each node
 * *fused with the captured why* (the context entries that overlap it). Fully
 * offline: descriptions come from the deterministic heuristic describer, so the
 * CE needs no API key. Decision fusion (the decision-DB traversal) is layered on
 * in the dashboard/MCP surfaces where that graph already lives.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { parseFunctions, languageForFile } from "@kodela/core/code-graph";
import {
  buildComprehension,
  type ComprehensionFileInput,
  type ComprehensionGraph,
} from "@kodela/core/comprehension";
import { readAllEntries } from "./status.js";

const execFileAsync = promisify(execFile);

export interface ComprehendOptions {
  repoRoot: string;
  /** Restrict to files whose path includes this substring (a file or dir). */
  filter?: string;
  /** Max source files to parse (guards huge repos). Default 400. */
  maxFiles?: number;
  /** Only include nodes that carry a fused why. */
  documentedOnly?: boolean;
}

export interface ComprehendResult {
  graph: ComprehensionGraph;
  filesParsed: number;
  filesTruncated: boolean;
}

async function gitSourceFiles(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export async function runComprehend(opts: ComprehendOptions): Promise<ComprehendResult> {
  const maxFiles = opts.maxFiles ?? 400;
  let files = (await gitSourceFiles(opts.repoRoot)).filter((f) => languageForFile(f) !== null);
  if (opts.filter) {
    const needle = opts.filter.toLowerCase();
    files = files.filter((f) => f.toLowerCase().includes(needle));
  }
  const filesTruncated = files.length > maxFiles;
  if (filesTruncated) files = files.slice(0, maxFiles);

  const parsed: ComprehensionFileInput[] = [];
  for (const rel of files) {
    let content: string;
    try {
      content = await fs.readFile(path.join(opts.repoRoot, rel), "utf8");
    } catch {
      continue; // deleted or unreadable — skip
    }
    const functions = await parseFunctions(rel, content);
    // Even a file with no parsed functions is worth a node (it still carries why).
    parsed.push({ filePath: rel, functions });
  }

  const entries = await readAllEntries(opts.repoRoot).catch(() => []);
  let graph = buildComprehension(parsed, { entries });

  if (opts.documentedOnly) {
    const keep = new Set(
      graph.nodes.filter((n) => n.whys.length > 0 || n.decisions.length > 0).map((n) => n.id),
    );
    graph = {
      ...graph,
      nodes: graph.nodes.filter((n) => keep.has(n.id)),
      edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    };
  }

  return { graph, filesParsed: parsed.length, filesTruncated };
}

const RISK_ICON: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "⚪",
  none: "  ",
};

export function formatComprehendResult(result: ComprehendResult, output: "text" | "json"): string {
  if (output === "json") {
    return JSON.stringify(
      { ...result.graph, filesParsed: result.filesParsed, filesTruncated: result.filesTruncated },
      null,
      2,
    );
  }

  const { graph } = result;
  const lines: string[] = [];
  lines.push(
    `Comprehension graph — ${graph.stats.files} files, ${graph.stats.classes} classes, ${graph.stats.functions} functions`,
  );
  lines.push(
    `${graph.stats.documented} nodes carry captured why (${Math.round(graph.stats.coverage * 100)}% coverage)` +
      (result.filesTruncated ? "  ⚠ file list truncated" : ""),
  );
  lines.push("");

  // Group nodes under their file for a readable tree.
  const byFile = new Map<string, typeof graph.nodes>();
  for (const n of graph.nodes) {
    if (n.kind === "file") continue;
    (byFile.get(n.filePath) ?? byFile.set(n.filePath, []).get(n.filePath)!).push(n);
  }
  const fileNodes = graph.nodes.filter((n) => n.kind === "file");
  for (const file of fileNodes) {
    const children = byFile.get(file.filePath) ?? [];
    if (children.length === 0 && file.whys.length === 0) continue;
    lines.push(`${RISK_ICON[file.riskLevel]} ${file.filePath}`);
    lines.push(`     ${file.description}`);
    if (file.whys.length > 0) lines.push(`     why: ${file.whys[0]!.note}`);
    for (const c of children) {
      const loc = c.lineRange ? `:${c.lineRange.start}-${c.lineRange.end}` : "";
      lines.push(`  ${RISK_ICON[c.riskLevel]} ${c.kind} ${c.name}${loc}`);
      lines.push(`       ${c.description}`);
      if (c.decisions.length > 0) {
        lines.push(`       decision: ${c.decisions.map((d) => d.title).join("; ")}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
