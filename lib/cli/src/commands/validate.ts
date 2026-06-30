// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 48 — `kodela validate` command.
 *
 * For each entry in scope, sends the current code at the mapped line range
 * plus the annotation note to the configured AI provider and asks whether
 * the explanation still accurately describes the code.
 *
 * Results are written back as `lastValidation: { validatedAt, valid, discrepancy? }`.
 *
 * Usage:
 *   kodela validate                          # all entries in the repo
 *   kodela validate src/payments/            # entries for a specific path
 *   kodela validate --entry <uuid>           # a single entry by ID
 *   kodela validate --threshold high         # only high-drift entries
 *   kodela validate --dry-run                # print what would be validated
 */

import fs from "node:fs/promises";
import path from "node:path";
import { readIndex, readContextEntry, writeContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { resolveProvider } from "./ai-layer.js";
import type { AiLayerConfig, AiProvider } from "./ai-layer.js";

const VALIDATE_SYSTEM_PROMPT = `You are a code annotation validator.
The user will provide:
  1. An annotation note that was written to describe a code region.
  2. The current code in that region.

Respond with ONLY a JSON object in this exact shape:
{
  "valid": true | false,
  "discrepancy": "optional explanation when valid is false (one sentence)"
}

Rules:
- Set valid=true when the annotation still accurately describes the code.
- Set valid=false when the annotation's key claims no longer hold (renamed functions,
  changed algorithm, removed dependency, wrong authentication method, etc.).
- Keep the discrepancy under 150 characters.
- Do not add any text outside the JSON object.`;

/** Normalise the AI response to a structured result. */
function parseValidationResponse(
  raw: string,
): { valid: boolean; discrepancy?: string } | null {
  try {
    const jsonStr = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonStr) return null;
    const parsed = JSON.parse(jsonStr) as {
      valid?: unknown;
      discrepancy?: unknown;
    };
    if (typeof parsed.valid !== "boolean") return null;
    return {
      valid: parsed.valid,
      ...(typeof parsed.discrepancy === "string" && parsed.discrepancy
        ? { discrepancy: parsed.discrepancy }
        : {}),
    };
  } catch {
    return null;
  }
}

export type ValidateOptions = {
  repoRoot: string;
  /** Optional path prefix filter (file or directory, relative to repoRoot). */
  scopePath?: string;
  /** Validate only this specific entry UUID. */
  entryId?: string;
  /** Only validate entries at or above this drift level. */
  threshold?: "low" | "medium" | "high";
  /** Dry-run: print what would be validated without writing. */
  dryRun?: boolean;
  aiConfig?: AiLayerConfig;
};

export type ValidationRecord = {
  entryId: string;
  filePath: string;
  lineRange: { start: number; end: number };
  note: string;
  valid: boolean | null;
  discrepancy?: string;
  skipped?: string;
};

export type ValidateResult = {
  records: ValidationRecord[];
  validated: number;
  skipped: number;
  invalid: number;
};

/** DRIFT_ORDER: only include entries at or above the threshold level. */
const DRIFT_RANK: Record<"low" | "medium" | "high", number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export async function runValidate(opts: ValidateOptions): Promise<ValidateResult> {
  const { repoRoot, scopePath, entryId, threshold, dryRun = false } = opts;

  const index = await readIndex(repoRoot);
  const allEntries = await Promise.all(
    index.entries.map((id) => readContextEntry(repoRoot, id)),
  );

  // Filter by scope
  let entries = allEntries.filter((e) => e.status !== "orphaned");

  if (entryId) {
    entries = entries.filter((e) => e.id === entryId);
  } else if (scopePath) {
    const normalized = scopePath.replace(/\\/g, "/").replace(/^\.\//, "");
    entries = entries.filter(
      (e) =>
        e.filePath === normalized ||
        e.filePath.startsWith(normalized.endsWith("/") ? normalized : normalized + "/"),
    );
  }

  // Filter by drift threshold
  if (threshold) {
    const minRank = DRIFT_RANK[threshold];
    entries = entries.filter((e) => {
      if (!e.contentDrift) return threshold === "low"; // no drift info → include only if threshold is low
      return DRIFT_RANK[e.contentDrift] >= minRank;
    });
  }

  // Resolve AI provider
  let provider: AiProvider | null = null;
  let providerError: string | null = null;
  if (!dryRun) {
    try {
      provider = resolveProvider(opts.aiConfig ?? {});
    } catch (e) {
      providerError = e instanceof Error ? e.message : String(e);
    }
  }

  const records: ValidationRecord[] = [];
  let validated = 0;
  let skipped = 0;
  let invalid = 0;

  for (const entry of entries) {
    if (dryRun) {
      records.push({
        entryId: entry.id,
        filePath: entry.filePath,
        lineRange: entry.lineRange,
        note: entry.note,
        valid: null,
        skipped: "dry-run",
      });
      skipped++;
      continue;
    }

    if (providerError) {
      records.push({
        entryId: entry.id,
        filePath: entry.filePath,
        lineRange: entry.lineRange,
        note: entry.note,
        valid: null,
        skipped: `no AI provider: ${providerError}`,
      });
      skipped++;
      continue;
    }

    // Read current code
    let currentCode: string;
    try {
      const absolutePath = path.resolve(repoRoot, entry.filePath);
      const fileContent = await fs.readFile(absolutePath, "utf-8");
      const lines = fileContent.split("\n");
      currentCode = lines.slice(entry.lineRange.start - 1, entry.lineRange.end).join("\n");
    } catch {
      records.push({
        entryId: entry.id,
        filePath: entry.filePath,
        lineRange: entry.lineRange,
        note: entry.note,
        valid: null,
        skipped: "file unreadable",
      });
      skipped++;
      continue;
    }

    // Call AI provider
    const prompt =
      `Annotation note:\n"${entry.note}"\n\nCurrent code (lines ${entry.lineRange.start}–${entry.lineRange.end} of ${entry.filePath}):\n\`\`\`\n${currentCode}\n\`\`\``;

    let parsed: { valid: boolean; discrepancy?: string } | null = null;
    try {
      const rawResponse = await provider!.summarise(
        `${VALIDATE_SYSTEM_PROMPT}\n\n${prompt}`,
      );
      parsed = parseValidationResponse(rawResponse);
    } catch {
      records.push({
        entryId: entry.id,
        filePath: entry.filePath,
        lineRange: entry.lineRange,
        note: entry.note,
        valid: null,
        skipped: "AI request failed",
      });
      skipped++;
      continue;
    }

    if (!parsed) {
      records.push({
        entryId: entry.id,
        filePath: entry.filePath,
        lineRange: entry.lineRange,
        note: entry.note,
        valid: null,
        skipped: "AI response could not be parsed",
      });
      skipped++;
      continue;
    }

    // Persist the validation result
    const updated: ContextEntry = {
      ...entry,
      lastValidation: {
        validatedAt: new Date().toISOString(),
        valid: parsed.valid,
        ...(parsed.discrepancy ? { discrepancy: parsed.discrepancy } : {}),
      },
      updatedAt: new Date().toISOString(),
    };
    await writeContextEntry(repoRoot, updated);

    records.push({
      entryId: entry.id,
      filePath: entry.filePath,
      lineRange: entry.lineRange,
      note: entry.note,
      valid: parsed.valid,
      discrepancy: parsed.discrepancy,
    });

    validated++;
    if (!parsed.valid) invalid++;
  }

  return { records, validated, skipped, invalid };
}

export function formatValidateResult(result: ValidateResult, verbose = false): string {
  const lines: string[] = [];

  lines.push(
    `Validated ${result.validated} entr${result.validated !== 1 ? "ies" : "y"}` +
    (result.skipped > 0 ? `, skipped ${result.skipped}` : "") +
    (result.invalid > 0 ? ` — ${result.invalid} annotation${result.invalid !== 1 ? "s" : ""} may be stale` : " — all current"),
  );

  if (!verbose && !result.records.some((r) => r.valid === false)) {
    return lines.join("\n");
  }

  lines.push("");

  for (const rec of result.records) {
    if (rec.skipped) {
      if (verbose) {
        lines.push(`  ⏭ ${rec.filePath}:${rec.lineRange.start}-${rec.lineRange.end} — skipped (${rec.skipped})`);
      }
      continue;
    }
    if (rec.valid === false) {
      lines.push(`  ✗ ${rec.filePath}:${rec.lineRange.start}-${rec.lineRange.end}`);
      lines.push(`      Note:        ${rec.note}`);
      if (rec.discrepancy) {
        lines.push(`      Discrepancy: ${rec.discrepancy}`);
      }
    } else if (verbose) {
      lines.push(`  ✓ ${rec.filePath}:${rec.lineRange.start}-${rec.lineRange.end} — still accurate`);
    }
  }

  return lines.join("\n");
}
