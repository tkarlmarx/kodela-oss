// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 76 — kodela enrich
 * Gap 122 — Reasoning extraction via `--reasoning` flag
 *
 * Retroactively improve context entries. Modes of operation:
 *
 *   --list          Print every enrichable entry (ID, file, range, current note).
 *   --id + --note   Update the note for one specific entry and clear the flag.
 *   --auto          For every enrichable entry that has an `origin.summary`,
 *                   rebuild the note from that summary and clear the flag.
 *   --reasoning     Gap 122: Call the reasoning extraction engine for every entry
 *                   that has a diff but no meaningful reasoning yet. Writes
 *                   `reasoning.intent`, `reasoning.reasoning`, `reasoning.alternatives`,
 *                   and `reasoning.confidence` into each entry file.
 *   (no flags)      Print a summary count and suggest one of the modes above.
 */

import { readIndex, readContextEntry, writeContextEntry } from "@kodela/core";
import { extractReasoning } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";

export type EnrichProgressEvent = {
  action: "enriched" | "skipped";
  current: number;
  total: number;
  id: string;
  filePath: string;
  confidence?: number;
};

export type EnrichOptions = {
  repoRoot: string;
  list?: boolean;
  id?: string;
  note?: string;
  auto?: boolean;
  /** Gap 122: Extract AI reasoning for entries with diffs but no reasoning. */
  reasoning?: boolean;
  dryRun?: boolean;
  /** Optional file path substring to scope enrichment to a single file. */
  scopeFile?: string;
  /** Called after each entry is processed, for streaming/progress reporting. */
  onProgress?: (event: EnrichProgressEvent) => void;
  /** AI config for reasoning extraction. */
  aiConfig?: {
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  };
};

export type EnrichResult = {
  mode: "summary" | "list" | "manual" | "auto" | "reasoning";
  enrichableCount: number;
  updatedCount: number;
  skippedCount: number;
  entries?: Array<{
    id: string;
    filePath: string;
    lineRange: { start: number; end: number };
    note: string;
    hasSummary: boolean;
  }>;
  dryRun: boolean;
};

/**
 * Build an improved note from origin data already stored on the entry.
 * Returns `null` when there is no useful summary to build from.
 */
function buildNoteFromOrigin(entry: ContextEntry): string | null {
  const summary = entry.origin?.summary;
  if (!summary || summary.trim().length === 0) return null;

  const tool = entry.origin?.tool ?? entry.aiTool;
  const firstSentence = summary.trim().split(/(?<=[.!?])\s+/)[0] ?? summary.trim();
  const label = tool ? `Auto-annotated (${tool}): ` : "Auto-annotated: ";
  return (label + firstSentence).slice(0, 200);
}

/**
 * Gap 122: Determine whether an entry needs reasoning extraction.
 *
 * An entry needs reasoning extraction when:
 *   - It has a raw diff (or at least a note to derive intent from)
 *   - It has no existing reasoning, OR
 *   - Its existing reasoning used the deterministic fallback ("diff-inference")
 *     with confidence "low" (meaning no AI call was made or it failed)
 */
function needsReasoningExtraction(entry: ContextEntry): boolean {
  const r = (entry as Record<string, unknown>)["reasoning"] as
    | { extractionMethod?: string; confidence?: string }
    | undefined
    | null;
  if (!r) return true;
  if (r.extractionMethod === "diff-inference" && r.confidence === "low") return true;
  return false;
}

export async function runEnrich(opts: EnrichOptions): Promise<EnrichResult> {
  const {
    repoRoot,
    list = false,
    id,
    note,
    auto = false,
    reasoning = false,
    dryRun = false,
    scopeFile,
    onProgress,
    aiConfig,
  } = opts;

  const index = await readIndex(repoRoot);
  const allEntries = await Promise.all(
    index.entries.map((eid) => readContextEntry(repoRoot, eid)),
  );

  const enrichable = allEntries.filter(
    (e) =>
      (e.canUpgradeAttribution === true ||
        (e.sourceType === "watcher" && !e.summary?.intent)) &&
      (scopeFile ? e.filePath.includes(scopeFile) : true),
  );

  // ── --list ──────────────────────────────────────────────────────────────────
  if (list) {
    return {
      mode: "list",
      enrichableCount: enrichable.length,
      updatedCount: 0,
      skippedCount: 0,
      dryRun,
      entries: enrichable.map((e) => ({
        id: e.id,
        filePath: e.filePath,
        lineRange: e.lineRange,
        note: e.note,
        hasSummary: Boolean(e.origin?.summary),
      })),
    };
  }

  // ── --id + --note ───────────────────────────────────────────────────────────
  if (id !== undefined && note !== undefined) {
    const target = allEntries.find((e) => e.id === id);
    if (!target) {
      throw new Error(`No context entry found with ID: ${id}`);
    }
    if (!dryRun) {
      const updated: ContextEntry = {
        ...target,
        note: note.trim(),
        canUpgradeAttribution: false,
        updatedAt: new Date().toISOString(),
      };
      await writeContextEntry(repoRoot, updated);
    }
    return {
      mode: "manual",
      enrichableCount: enrichable.length,
      updatedCount: 1,
      skippedCount: 0,
      dryRun,
    };
  }

  if (id !== undefined && note === undefined) {
    throw new Error("--id requires --note to specify the new note text.");
  }

  // ── --reasoning (Gap 122) ────────────────────────────────────────────────────
  if (reasoning) {
    const candidates = allEntries.filter(
      (e) =>
        needsReasoningExtraction(e) &&
        (scopeFile ? e.filePath.includes(scopeFile) : true),
    );
    const total = candidates.length;
    let current = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    for (const entry of candidates) {
      current++;
      const diff = (entry as Record<string, unknown>)["rawContext"] as
        | { diff?: string }
        | undefined;

      const result = await extractReasoning(entry.filePath, {
        diff: diff?.diff,
        note: entry.note,
        extractionMethod: "prompt",
        aiConfig,
        existingReasoning: (entry as Record<string, unknown>)["reasoning"] as
          | { intent: string; reasoning: string; confidence: "high" | "medium" | "low"; extractionMethod: "manual" | "prompt" | "hook" | "diff-inference"; extractedAt: string; alternatives: string[]; raw?: string }
          | undefined,
        reextractAfterDays: 0, // always re-extract in --reasoning mode (unless idempotency guard fires)
      });

      if (!dryRun) {
        // Promote status to "mapped" when AI-extracted reasoning is high confidence
        const newStatus =
          result.extractionMethod !== "diff-inference" &&
          result.confidence === "high" &&
          entry.status === "uncertain"
            ? "mapped"
            : entry.status;

        const updated: ContextEntry = {
          ...entry,
          reasoning: result,
          status: newStatus,
          canUpgradeAttribution: false,
          updatedAt: new Date().toISOString(),
        };
        await writeContextEntry(repoRoot, updated);
      }

      updatedCount++;
      onProgress?.({
        action: "enriched",
        current,
        total,
        id: entry.id,
        filePath: entry.filePath,
        confidence: result.confidence === "high" ? 0.9 : result.confidence === "medium" ? 0.7 : 0.4,
      });
    }

    if (candidates.length === 0) {
      skippedCount = 0;
    }

    return {
      mode: "reasoning",
      enrichableCount: total,
      updatedCount,
      skippedCount,
      dryRun,
    };
  }

  // ── --auto ──────────────────────────────────────────────────────────────────
  if (auto) {
    let updatedCount = 0;
    let skippedCount = 0;
    const total = enrichable.length;
    let current = 0;

    for (const entry of enrichable) {
      current++;
      const newNote = buildNoteFromOrigin(entry);
      if (!newNote) {
        skippedCount++;
        onProgress?.({ action: "skipped", current, total, id: entry.id, filePath: entry.filePath });
        continue;
      }
      const enrichedConfidence = Math.min(entry.confidence + 0.2, 0.85);
      if (!dryRun) {
        const updated: ContextEntry = {
          ...entry,
          note: newNote,
          confidence: enrichedConfidence,
          canUpgradeAttribution: false,
          updatedAt: new Date().toISOString(),
          summary: entry.summary
            ? { ...entry.summary, intent: entry.summary.intent || newNote }
            : { intent: newNote, changeType: "modification" as const, risk: "low" as const, shortSummary: newNote.slice(0, 80) },
        };
        await writeContextEntry(repoRoot, updated);
      }
      updatedCount++;
      onProgress?.({ action: "enriched", current, total, id: entry.id, filePath: entry.filePath, confidence: enrichedConfidence });
    }

    return {
      mode: "auto",
      enrichableCount: enrichable.length,
      updatedCount,
      skippedCount,
      dryRun,
    };
  }

  // ── Default: count summary ──────────────────────────────────────────────────
  return {
    mode: "summary",
    enrichableCount: enrichable.length,
    updatedCount: 0,
    skippedCount: 0,
    dryRun,
  };
}

export function formatEnrichResult(result: EnrichResult): string {
  const prefix = result.dryRun ? "[DRY RUN] " : "";

  switch (result.mode) {
    case "summary": {
      if (result.enrichableCount === 0) {
        return "No enrichable entries found. All auto-annotated notes are up to date.";
      }
      return [
        `${result.enrichableCount} enrichable ${result.enrichableCount === 1 ? "entry" : "entries"} found.`,
        "",
        "Options:",
        "  --list         Show all enrichable entries",
        "  --id <uuid> --note <text>   Update one entry manually",
        "  --auto         Auto-update entries that have an origin summary",
        "  --reasoning    Extract AI reasoning for entries with diffs (Gap 122)",
      ].join("\n");
    }

    case "list": {
      if (result.enrichableCount === 0) {
        return "No enrichable entries found.";
      }
      const lines = [
        `${result.enrichableCount} enrichable ${result.enrichableCount === 1 ? "entry" : "entries"}:`,
        "",
      ];
      for (const e of result.entries ?? []) {
        const summaryHint = e.hasSummary ? " [has summary]" : " [no summary — manual only]";
        lines.push(`  ${e.id}`);
        lines.push(`    ${e.filePath}  L${e.lineRange.start}-${e.lineRange.end}${summaryHint}`);
        lines.push(`    Current note: ${e.note}`);
        lines.push("");
      }
      return lines.join("\n").trimEnd();
    }

    case "manual": {
      return `${prefix}Updated 1 entry note.`;
    }

    case "auto": {
      const lines = [
        `${prefix}Auto-enrich complete: ${result.updatedCount} updated, ${result.skippedCount} skipped (no summary available).`,
      ];
      if (result.skippedCount > 0) {
        lines.push(
          `  Use --list to see skipped entries, then --id + --note to update them manually.`,
        );
      }
      return lines.join("\n");
    }

    case "reasoning": {
      if (result.enrichableCount === 0) {
        return "No entries require reasoning extraction. All entries already have AI-extracted reasoning.";
      }
      const lines = [
        `${prefix}Reasoning extraction complete: ${result.updatedCount} entries updated.`,
        `  Intent, decision logic, and alternatives written to each entry's reasoning field.`,
        `  Entries with high-confidence reasoning promoted to status: mapped.`,
      ];
      return lines.join("\n");
    }
  }
}
