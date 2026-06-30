// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 126 — `kodela_annotate` MCP tool
 *
 * Allows an AI agent (Claude, Copilot, etc.) to write a high-trust context
 * annotation directly into Kodela's store via the MCP server.  The entry is
 * written with `source: "ai"`, `sourceType: "sdk"`, `ingestion: "deterministic"`,
 * `trustLevel: "high"`, and `extractionMethod: "mcp"` so the dashboard and
 * synthesiser can distinguish MCP-authored entries from watcher-inferred ones.
 *
 * Both `writeContextEntry` AND `writeMappingFile` are called so the entry
 * becomes addressable via the file-path index.  `writeContextEntry` alone
 * does NOT write mapping files.
 *
 * Gap 126 enrichment fix: when the caller supplies `file_content`, `diff`,
 * `lines_added`, or `lines_removed`, these are forwarded to `enrichEntry` so
 * all five enrichment layers fire:
 *   1. Content fingerprint + initial drift (requires file_content)
 *   2. Scope classification (always runs)
 *   3. Ingestion provenance (always runs — deterministic/high)
 *   4. Structured AnnotationSummary (benefits from diff + line counts)
 *   5. Raw context capture (populated from diff + line counts)
 *
 * The entry is also written to the SQLite index (index.db) when the caller
 * passes a `db` handle, so `kodela_get_context` Phase 4 path finds it
 * immediately without waiting for a separate indexing pass.
 */

import { z } from "zod";
import crypto from "node:crypto";
import {
  writeContextEntry,
  writeMappingFile,
  enrichEntry,
  upsertEntry,
  hashTokenStream,
  hashFilePath,
  SCHEMA_VERSION as CORE_SCHEMA_VERSION,
} from "@kodela/core";
import { linkEntryToSession } from "@kodela/core/sessions";
import type { ContextEntry, EntryRow, MappingFile, StorageBackend } from "@kodela/core";
import type { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** git-style change_type values accepted by the tool */
const GIT_CHANGE_TYPES = [
  "feature",
  "fix",
  "refactor",
  "docs",
  "test",
  "chore",
] as const;

type GitChangeType = (typeof GIT_CHANGE_TYPES)[number];

/** Maps git-style change_type to the internal AnnotationSummary changeType enum. */
function mapChangeType(
  git: GitChangeType,
): "addition" | "modification" | "refactor" | "fix" | "new-file" {
  switch (git) {
    case "feature": return "addition";
    case "fix":     return "fix";
    case "refactor": return "refactor";
    case "docs":    return "modification";
    case "test":    return "modification";
    case "chore":   return "modification";
  }
}

export const AnnotateInputSchema = z.object({
  file_path: z
    .string()
    .describe("Repo-relative file path being annotated (e.g. src/auth/login.ts)"),
  line_start: z
    .number()
    .int()
    .positive()
    .describe("Start line of the annotated region (1-indexed)"),
  line_end: z
    .number()
    .int()
    .positive()
    .describe("End line of the annotated region (1-indexed, inclusive)"),
  intent: z
    .string()
    .min(1)
    .describe(
      "What the change achieves — first-person, present-tense description (e.g. 'Add JWT refresh rotation')",
    ),
  change_type: z
    .enum(GIT_CHANGE_TYPES)
    .describe("Type of change: feature | fix | refactor | docs | test | chore"),
  risk: z
    .enum(["low", "medium", "high", "critical"])
    .describe("Risk level of this change"),
  short_summary: z
    .string()
    .min(1)
    .max(200)
    .describe("One-sentence summary of the annotation for display (max 200 chars)"),
  reasoning: z
    .string()
    .optional()
    .describe("Why this approach was chosen — rationale, trade-offs, alternatives considered"),
  note: z
    .string()
    .optional()
    .describe("Human-readable annotation note; defaults to `short_summary` when omitted"),
  severity: z
    .enum(["low", "medium", "high", "critical"])
    .default("low")
    .describe("Severity of the annotation (default: low)"),
  session_id: z
    .string()
    .uuid()
    .optional()
    .describe("Kodela session UUID to link this annotation to (optional)"),
  tags: z
    .array(z.string())
    .default([])
    .describe("Optional freeform tags (e.g. ['auth', 'security'])"),
  // ── Gap 126 enrichment fields ──────────────────────────────────────────────
  file_content: z
    .string()
    .optional()
    .describe(
      "Full post-change content of the annotated file. " +
      "Enables content fingerprinting and drift detection. " +
      "Provide when available for richer enrichment.",
    ),
  diff: z
    .string()
    .optional()
    .describe(
      "Unified diff string (before → after) for the change. " +
      "Used to populate rawContext.diff and improve AnnotationSummary changeType inference.",
    ),
  lines_added: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Number of lines added in this change (used for rawContext and summary sizing)."),
  lines_removed: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Number of lines removed in this change (used for rawContext and summary sizing)."),
});

export type AnnotateInput = z.infer<typeof AnnotateInputSchema>;

// Hardcoded schema version (Gap 126 spec)
const SCHEMA_VERSION = "1.1.0";

// ---------------------------------------------------------------------------
// Core annotation writer
// ---------------------------------------------------------------------------

/**
 * Write a high-trust MCP-sourced context entry to the Kodela store.
 *
 * When `db` is provided (the server's open SQLite index), the entry is also
 * written to `index.db` so `kodela_get_context` Phase 4 path finds it
 * immediately without a separate indexing pass.
 *
 * Returns the newly created entry ID on success.
 */
export async function annotate(
  repoRoot: string,
  input: AnnotateInput,
  db?: DatabaseSync | null,
  backend?: StorageBackend | null,
): Promise<{
  entryId: string;
  filePath: string;
  enriched: boolean;
  remote?: { stored: boolean; mode: string; error?: string };
}> {
  const {
    file_path,
    line_start,
    line_end,
    intent,
    change_type,
    risk,
    short_summary,
    reasoning: reasoningText,
    note,
    severity,
    session_id,
    tags,
    file_content,
    diff,
    lines_added,
    lines_removed,
  } = input;

  const now = new Date().toISOString();
  const entryId = crypto.randomUUID();
  const effectiveNote = note?.trim() || short_summary;

  // Derive content hash from the file slice when content is available.
  // This mirrors the approach in ingestAIContext so drift detection works.
  let contentHash = "";
  if (file_content) {
    const fileLines = file_content.split("\n");
    const effectiveEnd = Math.max(line_start, line_end);
    const slice = fileLines.slice(line_start - 1, effectiveEnd).join("\n");
    contentHash = hashTokenStream(slice);
  }

  const partial: ContextEntry = {
    schemaVersion: SCHEMA_VERSION,
    id: entryId,
    filePath: file_path,
    astAnchor: null,
    contentHash,
    lineRange: {
      start: line_start,
      end: Math.max(line_start, line_end),
    },
    note: effectiveNote,
    author: "ai-agent",
    createdAt: now,
    updatedAt: now,
    severity,
    tags,
    source: "ai",
    confidence: 0.95,
    attributionConfidence: 0.95,
    canUpgradeAttribution: false,
    classificationScore: 0,
    classificationSignals: {} as Record<string, number>,
    status: "mapped",
    reviewRequired: false,
    ...(session_id ? { sessionId: session_id } : {}),
    summary: {
      intent,
      changeType: mapChangeType(change_type),
      risk: risk === "critical" ? "high" as const : risk as "low" | "medium" | "high",
      shortSummary: short_summary,
    },
    ...(reasoningText
      ? {
          reasoning: {
            intent,
            reasoning: reasoningText,
            alternatives: [],
            confidence: "high" as const,
            extractedAt: now,
            extractionMethod: "mcp" as const,
            source: "ai" as const,
          },
        }
      : {}),
  };

  // Apply all five enrichment layers.
  // Passing file_content, diff, and line counts ensures:
  //   Layer 1 — content fingerprint is computed (not skipped)
  //   Layer 4 — AnnotationSummary gets real changeType from diff
  //   Layer 5 — rawContext carries actual line counts and diff
  const entry = enrichEntry(partial, {
    sourceType: "sdk",
    isExplicitAgent: true,
    trustLevel: "high",
    fileContent: file_content,
    diff,
    linesAdded: lines_added ?? 0,
    linesRemoved: lines_removed ?? 0,
    fileCount: 1,
    aiProposalNote: intent,
  });

  // Write the entry file and mapping file atomically.
  // writeMappingFile makes the annotation addressable via the file-path index
  // so kodela_get_context (legacy path) finds it immediately.
  await writeContextEntry(repoRoot, entry);

  const mappingFile: MappingFile = {
    schemaVersion: CORE_SCHEMA_VERSION,
    filePathHash: hashFilePath(file_path),
    updatedAt: new Date().toISOString(),
    mappings: [
      {
        entryId,
        lineRange: entry.lineRange,
        confidence: entry.confidence,
        status: entry.status as "mapped" | "uncertain" | "orphaned",
      },
    ],
  };
  await writeMappingFile(repoRoot, mappingFile);

  // Write to the SQLite index when available so the Phase 4 cluster-aware
  // retrieval path (buildProjectContext) finds the entry without a separate
  // indexing pass.
  if (db !== null && db !== undefined) {
    const row: EntryRow = {
      id: entry.id,
      filePath: entry.filePath,
      schemaVersion: entry.schemaVersion,
      status: entry.status,
      severity: entry.severity,
      source: entry.source,
      confidence: entry.confidence,
      scope: entry.scope ?? null,
      sessionId: entry.sessionId ?? null,
      clusterId: entry.clusterId ?? null,
      reviewRequired: entry.reviewRequired,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    try {
      upsertEntry(db, row);
    } catch {
      // Non-fatal — file-based path is the source of truth; index is a cache
    }
  }

  // Link the annotation to its session so kodela_session_end can include it
  // in the MCPContextEnvelope via getSessionEntries. Without this call the
  // session's filesChanged list and aggregatedRisk would not reflect the
  // annotation written here.
  if (session_id) {
    await linkEntryToSession(repoRoot, session_id, entryId, file_path);
  }

  // SaaS / team mode — dual-write the entry to the Postgres `entries` table
  // (the store the dashboard reads). The local filesystem + SQLite writes
  // above remain the source of truth for the MCP read path; this makes the
  // MCP-authored "why" actually reach the team store, closing the gap where
  // a configured DATABASE_URL was silently ignored. A remote failure is
  // surfaced (never swallowed) so the operator knows the dashboard is stale.
  let remote: { stored: boolean; mode: string; error?: string } | undefined;
  if (backend) {
    try {
      await backend.writeEntry(entry);
      remote = { stored: true, mode: backend.mode };
    } catch (err) {
      remote = {
        stored: false,
        mode: backend.mode,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    entryId,
    filePath: file_path,
    enriched: Boolean(file_content || diff || lines_added || lines_removed),
    ...(remote ? { remote } : {}),
  };
}

// ---------------------------------------------------------------------------
// MCP response formatter
// ---------------------------------------------------------------------------

export function formatAnnotateResponse(result: {
  entryId: string;
  filePath: string;
  enriched: boolean;
  remote?: { stored: boolean; mode: string; error?: string };
}): string {
  return JSON.stringify(
    {
      ok: true,
      entryId: result.entryId,
      filePath: result.filePath,
      enriched: result.enriched,
      ...(result.remote ? { remote: result.remote } : {}),
      message: result.enriched
        ? `Annotation written with extractionMethod: "mcp", trustLevel: "high", full enrichment applied`
        : `Annotation written with extractionMethod: "mcp", trustLevel: "high"`,
    },
    null,
    2,
  );
}
