// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import path from "node:path";
import { readIndex, readContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { normalizeFilePath } from "../utils/repo.js";
import type { OutputMode } from "../output/formatters.js";

export type ExportOptions = {
  repoRoot: string;
  target?: string;
  repo?: boolean;
  maxTokens?: number;
  output?: OutputMode;
};

export type ExportResult = {
  entries: ContextEntry[];
  totalEntries: number;
  truncated: boolean;
  tokenEstimate: number;
  scope: "file" | "directory" | "repo";
  scopePath?: string;
};

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function rankEntry(entry: ContextEntry): number {
  const sevScore = SEVERITY_RANK[entry.severity] ?? 1;
  const reviewBonus = entry.reviewRequired ? 0.5 : 0;
  const recencyMs = new Date(entry.updatedAt).getTime();
  const recencyScore = recencyMs / 1e13;
  return sevScore + reviewBonus + recencyScore;
}

function prioritize(entries: ContextEntry[], maxTokens?: number): { picked: ContextEntry[]; truncated: boolean; tokenEstimate: number } {
  const sorted = [...entries].sort((a, b) => rankEntry(b) - rankEntry(a));

  if (!maxTokens) {
    const text = serialiseEntries(sorted, "text");
    return { picked: sorted, truncated: false, tokenEstimate: estimateTokens(text) };
  }

  const picked: ContextEntry[] = [];
  let budget = maxTokens;

  for (const entry of sorted) {
    const rendered = renderTextEntry(entry);
    const cost = estimateTokens(rendered);
    if (cost > budget) continue;
    picked.push(entry);
    budget -= cost;
  }

  const truncated = picked.length < sorted.length;
  const tokenEstimate = maxTokens - budget;
  return { picked, truncated, tokenEstimate };
}

export async function runExport(opts: ExportOptions): Promise<ExportResult> {
  const { repoRoot, target, repo = false, maxTokens, output: _output = "text" } = opts;

  const index = await readIndex(repoRoot);
  const allEntries = await Promise.all(
    index.entries.map((id) => readContextEntry(repoRoot, id)),
  );

  let scope: ExportResult["scope"];
  let scopePath: string | undefined;
  let candidates: ContextEntry[];

  if (repo || (!target && !repo)) {
    scope = "repo";
    candidates = allEntries;
  } else {
    const normalizedTarget = normalizeFilePath(target!);
    const absTarget = path.isAbsolute(normalizedTarget)
      ? normalizedTarget
      : path.join(repoRoot, normalizedTarget);

    const isDir = !path.extname(normalizedTarget);

    if (isDir) {
      scope = "directory";
      scopePath = normalizedTarget;
      const prefix = normalizedTarget.endsWith("/") ? normalizedTarget : normalizedTarget + "/";
      candidates = allEntries.filter(
        (e) => normalizeFilePath(e.filePath).startsWith(prefix) ||
               normalizeFilePath(e.filePath) === normalizedTarget,
      );
    } else {
      scope = "file";
      scopePath = normalizedTarget;
      candidates = allEntries.filter(
        (e) => normalizeFilePath(e.filePath) === normalizedTarget,
      );
    }

    void absTarget;
  }

  const { picked, truncated, tokenEstimate } = prioritize(candidates, maxTokens);

  return {
    entries: picked,
    totalEntries: candidates.length,
    truncated,
    tokenEstimate,
    scope,
    scopePath,
  };
}

function renderTextEntry(entry: ContextEntry): string {
  const lines: string[] = [];

  const statusIcon =
    entry.status === "mapped" ? "✓" : entry.status === "uncertain" ? "⚠" : "✗";
  const sev = entry.severity !== "low" ? ` [${entry.severity}]` : "";
  const review = entry.reviewRequired ? " · review-required" : "";

  lines.push(
    `${statusIcon} Lines ${entry.lineRange.start}–${entry.lineRange.end}${sev}${review} | source:${entry.source}${entry.aiTool ? `(${entry.aiTool})` : ""} | confidence:${(entry.confidence * 100).toFixed(0)}%`,
  );
  lines.push(`  Note: ${entry.note}`);

  if (entry.tags.length > 0) {
    lines.push(`  Tags: ${entry.tags.join(", ")}`);
  }

  if (entry.origin) {
    const o = entry.origin;
    if (o.summary) lines.push(`  Decision: ${o.summary}`);
    if (o.reasoning && o.reasoning.length > 0) {
      for (const step of o.reasoning) lines.push(`    • ${step}`);
    }
    const meta: string[] = [];
    if (o.model) meta.push(`model:${o.model}`);
    if (o.sessionId) meta.push(`session:${o.sessionId}`);
    if (meta.length > 0) lines.push(`  Origin: ${meta.join(" | ")}`);
  }

  // Gap 50 — External reference to the issue/document that drove the change.
  if (entry.externalRef) {
    const ref = entry.externalRef;
    const titlePart = ref.title ? `${ref.title} – ` : "";
    lines.push(`  Reference: ${titlePart}${ref.url}`);
  }

  return lines.join("\n");
}

function serialiseEntries(entries: ContextEntry[], _mode: OutputMode): string {
  if (entries.length === 0) return "";

  const byFile = new Map<string, ContextEntry[]>();
  for (const e of entries) {
    const fp = normalizeFilePath(e.filePath);
    if (!byFile.has(fp)) byFile.set(fp, []);
    byFile.get(fp)!.push(e);
  }

  const sections: string[] = [];
  for (const [filePath, fileEntries] of byFile) {
    const sorted = [...fileEntries].sort((a, b) => a.lineRange.start - b.lineRange.start);
    sections.push(`### ${filePath}`);
    sections.push(sorted.map(renderTextEntry).join("\n\n"));
  }
  return sections.join("\n\n");
}

export function formatExportResult(result: ExportResult, mode: OutputMode): string {
  if (mode === "json") {
    return JSON.stringify(
      {
        scope: result.scope,
        scopePath: result.scopePath,
        totalEntries: result.totalEntries,
        exportedEntries: result.entries.length,
        truncated: result.truncated,
        tokenEstimate: result.tokenEstimate,
        entries: result.entries,
      },
      null,
      2,
    );
  }

  if (result.entries.length === 0) {
    const where = result.scopePath ?? "repository";
    return `No context annotations found for ${where}.`;
  }

  const header = buildTextHeader(result);
  const body = serialiseEntries(result.entries, "text");
  const footer = result.truncated
    ? `\n---\n⚠ Output truncated to fit token budget. ${result.totalEntries - result.entries.length} entr${result.totalEntries - result.entries.length !== 1 ? "ies" : "y"} omitted (lowest priority). Run without --max-tokens to export all.`
    : "";

  return [header, body, footer].filter(Boolean).join("\n\n");
}

function buildTextHeader(result: ExportResult): string {
  const scopeLabel =
    result.scope === "repo"
      ? "entire repository"
      : result.scope === "directory"
        ? `directory: ${result.scopePath}`
        : `file: ${result.scopePath}`;

  const lines = [
    "# Kodela Context Export",
    `Scope: ${scopeLabel}`,
    `Annotations exported: ${result.entries.length}${result.totalEntries !== result.entries.length ? ` of ${result.totalEntries}` : ""}`,
    `Estimated tokens: ~${result.tokenEstimate}`,
  ];

  if (result.truncated) {
    lines.push(`Token budget active — entries ordered by risk (critical → high → medium → low) then recency.`);
  }

  lines.push("---");
  return lines.join("\n");
}
