// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela architecture` (Phase 3 — P3.1 layers + business-domain mapping).
 *
 * Auto-derives the shape of the codebase — technical layers (API, UI, data,
 * auth, core, …) and business domains — from the tracked files, then fuses in
 * the captured risk so you see "here's the auth layer, and it carries 2
 * high-risk decisions". Human-refinable: a `.kodela/architecture.json` with
 * `{ rules?, domains? }` overrides the heuristics. Also derives the layer-to-
 * layer dependency matrix from the import graph. Offline.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  deriveArchitecture,
  type ArchitectureMap,
  type ArchitectureNodeInput,
  type LayerRule,
} from "@kodela/core/architecture";
import type { WhyLink } from "@kodela/core/comprehension";
import { readAllEntries } from "./status.js";
import { scanDependencyEdges } from "../lib/dep-scan.js";

const execFileAsync = promisify(execFile);

export interface ArchitectureCliOptions {
  repoRoot: string;
}

export interface ArchitectureRunResult {
  map: ArchitectureMap;
  /** True when .kodela/architecture.json refinements were applied. */
  refined: boolean;
}

interface RefineConfig {
  rules?: LayerRule[];
  domains?: Record<string, string>;
}

async function gitFiles(repoRoot: string): Promise<string[]> {
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

async function loadRefinements(repoRoot: string): Promise<RefineConfig | null> {
  try {
    const raw = await fs.readFile(path.join(repoRoot, ".kodela", "architecture.json"), "utf8");
    const parsed = JSON.parse(raw) as RefineConfig;
    return parsed;
  } catch {
    return null;
  }
}

export async function runArchitecture(opts: ArchitectureCliOptions): Promise<ArchitectureRunResult> {
  const [files, entries, edges, refine] = await Promise.all([
    gitFiles(opts.repoRoot),
    readAllEntries(opts.repoRoot).catch(() => []),
    scanDependencyEdges(opts.repoRoot),
    loadRefinements(opts.repoRoot),
  ]);

  const whysByFile = new Map<string, WhyLink[]>();
  for (const e of entries) {
    if ((e as { archived?: boolean }).archived === true) continue;
    const w: WhyLink = { entryId: e.id, note: e.note, severity: e.severity, tags: e.tags };
    (whysByFile.get(e.filePath) ?? whysByFile.set(e.filePath, []).get(e.filePath)!).push(w);
  }

  const nodes: ArchitectureNodeInput[] = files.map((f) => ({
    filePath: f,
    whys: whysByFile.get(f),
  }));

  const map = deriveArchitecture(nodes, {
    rules: refine?.rules,
    domains: refine?.domains,
    dependencies: edges,
  });
  return { map, refined: refine !== null };
}

const RISK_ICON: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "⚪",
  none: "  ",
};

export function formatArchitectureResult(
  result: ArchitectureRunResult,
  output: "text" | "json",
): string {
  if (output === "json") {
    return JSON.stringify({ ...result.map, refined: result.refined }, null, 2);
  }

  const { map } = result;
  const lines: string[] = [];
  lines.push(
    `Architecture — ${map.stats.files} files across ${map.stats.layers} layers, ${map.stats.domains} domains` +
      (result.refined ? "  (refined via .kodela/architecture.json)" : ""),
  );
  lines.push("");
  lines.push("Layers (by size):");
  for (const l of map.layers) {
    const risk = l.highestRisk !== "none" ? `  ${RISK_ICON[l.highestRisk]} ${l.highestRisk} risk` : "";
    lines.push(`  ${l.layer.padEnd(20)} ${String(l.fileCount).padStart(4)} files${risk}`);
  }
  if (map.layerEdges.length > 0) {
    lines.push("");
    lines.push("Layer dependencies (imports across layers):");
    for (const e of map.layerEdges.slice(0, 15)) {
      lines.push(`  ${e.from} → ${e.to}  (${e.weight})`);
    }
  }
  lines.push("");
  lines.push("Business domains (by size):");
  for (const d of map.domains.slice(0, 15)) {
    lines.push(`  ${d.domain.padEnd(20)} ${String(d.fileCount).padStart(4)} files`);
  }
  return lines.join("\n").trimEnd();
}
