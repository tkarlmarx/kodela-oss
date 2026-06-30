// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 53 — Extract Reasoning CLI Command
 *
 * On-demand or batch reasoning extraction for existing ContextEntry objects.
 *
 * Usage:
 *   kodela extract-reasoning --entry <uuid>            single entry
 *   kodela extract-reasoning --file src/auth/login.ts  all entries on a file
 *   kodela extract-reasoning --source ai               all AI-sourced entries
 *   kodela extract-reasoning --threshold low           low-confidence entries only
 *   kodela extract-reasoning --diff diff.patch         diff-only mode (no entry)
 *
 * Flags:
 *   --dry-run         Show what would be extracted without writing
 *   --force           Re-extract even if reasoning was recently extracted
 */

import fs from "node:fs/promises";
import {
  readContextEntry,
  writeContextEntry,
  extractReasoning,
  buildFallbackReasoning,
} from "@kodela/core";
import type { ContextEntry, ReasoningObject } from "@kodela/core";
import { listAllEntries } from "../utils/entries.js";
import type { AiLayerConfig } from "./ai-layer.js";

// ---------------------------------------------------------------------------
// Options and result types
// ---------------------------------------------------------------------------

export type ExtractReasoningMode =
  | { kind: "entry"; entryId: string }
  | { kind: "file"; filePath: string }
  | { kind: "source"; source: string; threshold?: string }
  | { kind: "diff"; diffPath: string };

export type ExtractReasoningOptions = {
  repoRoot: string;
  mode: ExtractReasoningMode;
  dryRun?: boolean;
  /** Force re-extraction even if reasoning was recently extracted. */
  force?: boolean;
  aiConfig?: AiLayerConfig;
};

export type ExtractReasoningResultEntry = {
  entryId: string;
  filePath: string;
  method: string;
  confidence: string;
  skipped: boolean;
  skipReason?: string;
  error?: string;
};

export type ExtractReasoningResult = {
  mode: string;
  dryRun: boolean;
  processed: number;
  skipped: number;
  errors: number;
  entries: ExtractReasoningResultEntry[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesSource(entry: ContextEntry, source: string): boolean {
  return entry.source === source;
}

function matchesThreshold(
  entry: ContextEntry,
  threshold?: string,
): boolean {
  if (!threshold) return true;
  const conf = entry.confidence;
  if (threshold === "low") return conf < 0.7;
  if (threshold === "medium") return conf >= 0.7 && conf < 0.9;
  if (threshold === "high") return conf >= 0.9;
  return true;
}

async function processEntry(
  repoRoot: string,
  entry: ContextEntry,
  opts: {
    force?: boolean;
    dryRun?: boolean;
    aiConfig?: AiLayerConfig;
    diff?: string;
  },
): Promise<ExtractReasoningResultEntry> {
  const base: ExtractReasoningResultEntry = {
    entryId: entry.id,
    filePath: entry.filePath,
    method: "pending",
    confidence: "pending",
    skipped: false,
  };

  // Idempotency check unless --force
  if (!opts.force && entry.reasoning) {
    const ageMs = Date.now() - new Date(entry.reasoning.extractedAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < 30) {
      return {
        ...base,
        method: entry.reasoning.extractionMethod,
        confidence: entry.reasoning.confidence,
        skipped: true,
        skipReason: `fresh (${Math.round(ageDays)}d old)`,
      };
    }
  }

  try {
    let reasoning: ReasoningObject;

    if (opts.dryRun) {
      // In dry-run mode, produce the fallback object as a preview
      reasoning = buildFallbackReasoning(entry.filePath, entry.note);
    } else {
      reasoning = await extractReasoning(entry.filePath, {
        diff: opts.diff,
        note: entry.note,
        extractionMethod: "prompt",
        aiConfig: opts.aiConfig,
        existingReasoning: opts.force ? undefined : entry.reasoning,
        reextractAfterDays: opts.force ? 0 : 30,
      });

      const updated: ContextEntry = {
        ...entry,
        reasoning,
        updatedAt: new Date().toISOString(),
      };
      await writeContextEntry(repoRoot, updated);
    }

    return {
      ...base,
      method: reasoning.extractionMethod,
      confidence: reasoning.confidence,
      skipped: false,
    };
  } catch (err) {
    return {
      ...base,
      method: "error",
      confidence: "error",
      skipped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Main command runner
// ---------------------------------------------------------------------------

export async function runExtractReasoning(
  opts: ExtractReasoningOptions,
): Promise<ExtractReasoningResult> {
  const { repoRoot, mode, dryRun = false, force = false, aiConfig } = opts;
  const results: ExtractReasoningResultEntry[] = [];

  switch (mode.kind) {
    case "entry": {
      const entry = await readContextEntry(repoRoot, mode.entryId);
      const r = await processEntry(repoRoot, entry, { force, dryRun, aiConfig });
      results.push(r);
      break;
    }

    case "file": {
      const allEntries = await listAllEntries(repoRoot);
      const targets = allEntries.filter(
        (e) =>
          e.filePath === mode.filePath ||
          e.filePath.endsWith("/" + mode.filePath) ||
          e.filePath === mode.filePath.replace(/^\.\//, ""),
      );
      for (const entry of targets) {
        const r = await processEntry(repoRoot, entry, { force, dryRun, aiConfig });
        results.push(r);
      }
      break;
    }

    case "source": {
      const allEntries = await listAllEntries(repoRoot);
      const targets = allEntries.filter(
        (e) =>
          matchesSource(e, mode.source) &&
          matchesThreshold(e, mode.threshold),
      );
      for (const entry of targets) {
        const r = await processEntry(repoRoot, entry, { force, dryRun, aiConfig });
        results.push(r);
      }
      break;
    }

    case "diff": {
      // Diff-only mode: read the diff file and produce a standalone ReasoningObject
      let diffContent: string;
      try {
        diffContent = await fs.readFile(mode.diffPath, "utf-8");
      } catch {
        throw new Error(`Cannot read diff file: ${mode.diffPath}`);
      }

      if (!dryRun) {
        const reasoning = await extractReasoning(mode.diffPath, {
          diff: diffContent,
          extractionMethod: "prompt",
          aiConfig,
        });
        results.push({
          entryId: "(diff-only)",
          filePath: mode.diffPath,
          method: reasoning.extractionMethod,
          confidence: reasoning.confidence,
          skipped: false,
        });
      } else {
        const fallback = buildFallbackReasoning(mode.diffPath);
        results.push({
          entryId: "(diff-only)",
          filePath: mode.diffPath,
          method: fallback.extractionMethod,
          confidence: fallback.confidence,
          skipped: false,
        });
      }
      break;
    }
  }

  const processed = results.filter((r) => !r.skipped && !r.error).length;
  const skipped = results.filter((r) => r.skipped).length;
  const errors = results.filter((r) => Boolean(r.error)).length;

  return {
    mode: mode.kind,
    dryRun,
    processed,
    skipped,
    errors,
    entries: results,
  };
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

export function formatExtractReasoningResult(
  result: ExtractReasoningResult,
): string {
  const lines: string[] = [];

  const prefix = result.dryRun ? "[dry-run] " : "";

  if (result.entries.length === 0) {
    lines.push(`${prefix}No entries matched the filter.`);
    return lines.join("\n");
  }

  for (const e of result.entries) {
    if (e.error) {
      lines.push(`✗ ${e.filePath} (${e.entryId.slice(0, 8)}) — error: ${e.error}`);
    } else if (e.skipped) {
      lines.push(
        `⤷ ${e.filePath} (${e.entryId.slice(0, 8)}) — skipped: ${e.skipReason ?? ""}`,
      );
    } else {
      const flag = result.dryRun ? "~" : "✓";
      lines.push(
        `${flag} ${e.filePath} (${e.entryId.slice(0, 8)}) — method: ${e.method}, confidence: ${e.confidence}`,
      );
    }
  }

  lines.push("");
  lines.push(
    `${prefix}Processed ${result.processed} · Skipped ${result.skipped} · Errors ${result.errors}`,
  );

  return lines.join("\n");
}

export function formatExtractReasoningResultJson(
  result: ExtractReasoningResult,
): string {
  return JSON.stringify(result, null, 2);
}
