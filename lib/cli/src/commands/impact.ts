// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela impact` (Phase 2 — P2.3 diff impact).
 *
 * "What does this change touch?" — on both axes at once. It resolves the changed
 * files (explicit args, or `git diff` vs a base), walks the reverse dependency
 * graph to find the structural blast radius, and fuses the captured
 * why/decisions/risk sitting on everything in that radius. In --ci mode it fails
 * the build when the blast radius touches high/critical-risk code, turning "read
 * the why before you touch load-bearing code" into a pre-commit gate.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { computeImpact, type ImpactReport } from "@kodela/core/impact";
import type { WhyLink } from "@kodela/core/comprehension";
import { readAllEntries } from "./status.js";
import { scanDependencyEdges } from "../lib/dep-scan.js";

const execFileAsync = promisify(execFile);

export interface ImpactOptions {
  repoRoot: string;
  /** Explicit changed files; when omitted, derived from git diff. */
  files?: string[];
  /** Git ref to diff against when files aren't given. Default HEAD. */
  base?: string;
  maxDepth?: number;
}

export interface ImpactRunResult {
  report: ImpactReport;
  /** How the changed-file set was resolved, for the report header. */
  source: "args" | "git";
}

async function gitChangedFiles(repoRoot: string, base: string): Promise<string[]> {
  const out = new Set<string>();
  const run = async (args: string[]) => {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
      for (const f of stdout.split("\n").filter(Boolean)) out.add(f);
    } catch {
      /* ignore — best effort */
    }
  };
  // Uncommitted (working tree + staged) vs base, so a pre-commit run sees them.
  await run(["diff", "--name-only", base]);
  await run(["diff", "--name-only", "--cached", base]);
  return [...out];
}

/** dependents adjacency (file → files that import it) from the shared scanner. */
async function reverseDependencies(repoRoot: string): Promise<Map<string, string[]>> {
  const dependents = new Map<string, string[]>();
  for (const { from, to } of await scanDependencyEdges(repoRoot)) {
    // `from` imports `to` ⇒ `from` is a dependent of `to`.
    (dependents.get(to) ?? dependents.set(to, []).get(to)!).push(from);
  }
  return dependents;
}

export async function runImpact(opts: ImpactOptions): Promise<ImpactRunResult> {
  const base = opts.base ?? "HEAD";
  const source: "args" | "git" = opts.files && opts.files.length > 0 ? "args" : "git";
  const changedFiles =
    source === "args" ? opts.files! : await gitChangedFiles(opts.repoRoot, base);

  const [dependents, entries] = await Promise.all([
    reverseDependencies(opts.repoRoot),
    readAllEntries(opts.repoRoot).catch(() => []),
  ]);

  const whysByFile = new Map<string, WhyLink[]>();
  for (const e of entries) {
    if ((e as { archived?: boolean }).archived === true) continue;
    const w: WhyLink = {
      entryId: e.id,
      note: e.note.length > 200 ? `${e.note.slice(0, 200).trimEnd()}…` : e.note,
      severity: e.severity,
      tags: e.tags,
    };
    (whysByFile.get(e.filePath) ?? whysByFile.set(e.filePath, []).get(e.filePath)!).push(w);
  }

  const report = computeImpact(
    { changedFiles, dependents, whysByFile },
    { maxDepth: opts.maxDepth },
  );
  return { report, source };
}

const RISK_ICON: Record<string, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "⚪",
  none: "  ",
};

export function formatImpactResult(result: ImpactRunResult, output: "text" | "json"): string {
  if (output === "json") {
    return JSON.stringify({ ...result.report, source: result.source }, null, 2);
  }

  const { report } = result;
  const lines: string[] = [];
  if (report.changedFiles.length === 0) {
    return "No changed files detected (clean working tree, or pass files explicitly).";
  }
  lines.push(`Impact of changing ${report.changedFiles.length} file(s):`);
  lines.push(
    `  ${report.stats.dependents} downstream file(s) in the blast radius · ` +
      `${report.stats.decisions} decision(s) · highest risk: ${report.highestRisk}`,
  );
  lines.push("");
  for (const f of report.impacted) {
    const tag = f.distance === 0 ? "changed" : `+${f.distance} hop${f.distance === 1 ? "" : "s"}`;
    lines.push(`${RISK_ICON[f.riskLevel]} ${f.filePath}  (${tag})`);
    for (const w of f.whys.slice(0, 2)) lines.push(`      why: ${w.note}`);
    for (const d of f.decisions) lines.push(`      decision: ${d.title} (${d.status})`);
  }
  return lines.join("\n").trimEnd();
}
