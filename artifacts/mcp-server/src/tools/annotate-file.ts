// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Per-file MCP context capture — `kodela_annotate_file` tool.
 *
 * Called once per file modified in a session. Captures:
 *   - WHO edited this file (AI tool, human, or mixed — per-file actor)
 *   - WHY this specific file was changed
 *   - WHAT problem this change solves
 *   - AI reasoning and alternatives considered
 *   - Risk level and related files
 *
 * Writes a ContextEntry to `.kodela/objects/` and appends a FileChangeContext
 * to the session's `filesChangedDetail[]` array. Both are indexed in SQLite.
 *
 * `kodela_session_end` will reject the close call if any modified file
 * lacks per-file context (unless `force: true` is passed).
 */

import { z } from "zod";
import crypto from "node:crypto";
import {
  writeContextEntry,
  writeMappingFile,
  enrichEntry,
  readSession,
  writeSession,
  upsertEntry,
  hashTokenStream,
  hashFilePath,
  classifyRisk,
  SCHEMA_VERSION,
} from "@kodela/core";

import { linkEntryToSession } from "@kodela/core/sessions";
import type { ContextEntry, EntryRow, MappingFile, StorageBackend } from "@kodela/core";
import type { DatabaseSync } from "node:sqlite";
import { resolveSessionActorForAnnotate } from "../lib/resolve-actor.js";
import { insertEdges, edgesForAnnotation, edgesForCodeFunctions } from "../lib/graph-store.js";
import { parseFunctions, languageForFile } from "@kodela/core/code-graph";
import { loadCapturePolicy, evaluateCapture } from "@kodela/core/policy";
import { logCaptureDenial, encryptFieldsInPlace, isEncryptionEnabled } from "@kodela/core/audit";

/**
 * Sensitive ContextEntry note fields encrypted at rest when
 * `KODELA_MASTER_KEY` is configured (Phase 5.8.3 / doc 24 C1.1).
 * The encrypted envelope replaces the plaintext in place; the decisionsReader
 * decrypts on the way out so api-server / dashboard responses stay readable
 * for authorized callers (RBAC layer gates this).
 */
const ENCRYPT_AT_REST_FIELDS = ["note"] as const;

// ── Input schema ──────────────────────────────────────────────────────────────

/**
 * Per-file actor override.
 * Omit entirely to default to the session actor with source: "ai".
 */
export const ModifiedByInputSchema = z.object({
  source: z.enum(["ai", "human", "mixed"]),
  tool: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  author: z.string().optional(),
  ai_session_url: z.string().url().optional(),
});

export const AnnotateFileInputSchema = z.object({
  session_id: z
    .string()
    .min(1)
    .describe("Session ID from kodela_session_start"),

  file_path: z
    .string()
    .min(1)
    .describe("Repo-relative file path (e.g. src/auth/jwt.ts)"),

  // ── Required "why" fields ──────────────────────────────────────────────────
  why_changed: z
    .string()
    .min(10, "why_changed must explain why THIS file needed to change (min 10 chars)")
    .describe(
      "Why THIS file needed to change — specific to this file's role. " +
      "Not 'to add JWT' but 'session.ts holds the active token ID which the rotation logic checks'.",
    ),

  problem_solved: z
    .string()
    .min(10, "problem_solved must describe what this change fixes/enables (min 10 chars)")
    .describe(
      "What concrete problem this change fixes or enables. " +
      "Not 'improves auth' but 'prevents token replay after refresh by invalidating the previous token ID'.",
    ),

  // ── Diff metadata (required for enrichment) ───────────────────────────────
  lines_added: z
    .number()
    .int()
    .nonnegative()
    .describe("Number of lines added in this file"),

  lines_removed: z
    .number()
    .int()
    .nonnegative()
    .describe("Number of lines removed from this file"),

  diff: z
    .string()
    .optional()
    .describe("Unified diff string for this file (before → after)"),

  file_content: z
    .string()
    .optional()
    .describe("Full post-change file content — enables content fingerprinting"),

  // ── Optional richer context ────────────────────────────────────────────────
  ai_reasoning: z
    .string()
    .optional()
    .describe("How the approach was chosen — what was considered and rejected"),

  alternatives_considered: z
    .string()
    .optional()
    .describe("Alternatives that were evaluated and why they were rejected"),

  related_files: z
    .array(z.string())
    .default([])
    .describe("Other files in this session this change depends on or affects"),

  linked_decision_ids: z
    .array(z.string())
    .default([])
    .describe(
      "Decision ids (DEC-NNNN) this file change implements. Each creates a " +
      "FILE_CHANGE —IMPLEMENTS→ DECISION edge in the memory graph, which is " +
      "what kodela_get_why traverses to answer 'why is this code here?'.",
    ),

  // ── Per-file actor override ────────────────────────────────────────────────
  modified_by: ModifiedByInputSchema.optional().describe(
    "Who edited this file. Omit to default to the session actor with source: 'ai'. " +
    "Set source: 'human' when the developer hand-edited this file. " +
    "Set source: 'mixed' when AI scaffolded and human refined.",
  ),

  risk: z
    .enum(["low", "medium", "high", "critical"])
    .optional()
    .describe(
      "Risk level of this file's change. Omit to compute it from the file path " +
        "(auth/security/db/payments paths score higher) and change size — set it " +
        "explicitly only to override (e.g. escalate to 'critical').",
    ),
});

export type AnnotateFileInput = z.infer<typeof AnnotateFileInputSchema>;

// ── Core function ─────────────────────────────────────────────────────────────

export async function annotateFile(
  repoRoot: string,
  input: AnnotateFileInput,
  db: DatabaseSync | null,
  backend?: StorageBackend | null,
): Promise<{
  ok: boolean;
  entryId?: string;
  filePath: string;
  enriched: boolean;
  modifiedBy: { source: string; tool: string | null };
  error?: string;
  remote?: { stored: boolean; mode: string; error?: string };
}> {
  // 1. Load session to resolve actor defaults
  const session = await readSession(repoRoot, input.session_id);
  if (!session) {
    return {
      ok: false,
      filePath: input.file_path,
      enriched: false,
      modifiedBy: { source: "ai", tool: null },
      error: `Session ${input.session_id} not found`,
    };
  }

  // 2. Resolve the per-file actor (KODELA_AGENT env wins over session metadata)
  const modifiedBy = resolveModifiedBy(
    input.modified_by,
    resolveSessionActorForAnnotate(session),
  );

  // 2a. Phase 5.8.1 — capture-policy enforcement (internal design note).
  // Path globs and agent allow/deny are evaluated BEFORE any persistence. Denials
  // are appended to the hash-chain audit log as `capture_denied` entries so an
  // external auditor can prove the policy fired. Missing policy file → OPEN_POLICY,
  // so existing repos that haven't opted in see no behaviour change.
  try {
    const policy = await loadCapturePolicy(repoRoot);
    const decision = evaluateCapture(policy, {
      filePath: input.file_path,
      agentTool: modifiedBy.tool ?? undefined,
    });
    if (!decision.allow) {
      await logCaptureDenial({
        repoRoot,
        decision,
        context: {
          actor: session.actor?.author ?? session.actor?.tool ?? "unknown",
          sessionId: input.session_id,
          filePath: input.file_path,
          agentTool: modifiedBy.tool ?? undefined,
        },
      });
      return {
        ok: false,
        filePath: input.file_path,
        enriched: false,
        modifiedBy: { source: modifiedBy.source, tool: modifiedBy.tool ?? null },
        error: `Capture denied by policy: ${decision.reason} — ${decision.detail}`,
      };
    }
  } catch (err) {
    // A malformed policy file MUST NOT silently allow captures — surface the
    // error so the operator fixes the YAML and re-runs. This is the only place
    // in this tool that swallows-into-error rather than crashing.
    return {
      ok: false,
      filePath: input.file_path,
      enriched: false,
      modifiedBy: { source: modifiedBy.source, tool: modifiedBy.tool ?? null },
      error: `Capture-policy load failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. Build the note from the required "why" fields
  const noteParts: string[] = [input.why_changed];
  noteParts.push(`\nProblem solved: ${input.problem_solved}`);
  if (input.ai_reasoning) noteParts.push(`\nAI reasoning: ${input.ai_reasoning}`);
  if (input.alternatives_considered) {
    noteParts.push(`\nAlternatives considered: ${input.alternatives_considered}`);
  }
  const note = noteParts.join("");

  // 4. Compute content hash from file content if available
  let contentHash = "";
  if (input.file_content) {
    contentHash = hashTokenStream(input.file_content);
  } else {
    contentHash = crypto.createHash("sha256").update(input.file_path).digest("hex");
  }

  const now = new Date().toISOString();
  const entryId = crypto.randomUUID();

  // Risk is computed from the file path + change size when the agent doesn't
  // set it — so a change under auth/security/db/payments is never silently
  // recorded as "low". An explicit `risk` (e.g. escalating to "critical") wins.
  const risk = input.risk ?? classifyRisk(input.file_path, input.lines_added, input.lines_removed);

  // 5. Build the partial ContextEntry
  const partial: ContextEntry = {
    schemaVersion: SCHEMA_VERSION,
    id: entryId,
    filePath: input.file_path,
    astAnchor: null,
    contentHash,
    lineRange: { start: 1, end: Math.max(1, input.lines_added + input.lines_removed) },
    note,
    author: modifiedBy.author,
    createdAt: now,
    updatedAt: now,
    severity: risk,
    tags: [
      "per-file-context",
      `session:${input.session_id}`,
      modifiedBy.source,
      ...(modifiedBy.tool ? [modifiedBy.tool] : []),
    ],
    source: modifiedBy.source === "human" ? "human" : "ai",
    aiTool: modifiedBy.tool ?? undefined,
    confidence: modifiedBy.source === "ai" ? 0.95 : modifiedBy.source === "mixed" ? 0.85 : 1.0,
    attributionConfidence: modifiedBy.source === "ai" ? 0.95 : 1.0,
    canUpgradeAttribution: false,
    status: "mapped",
    reviewRequired: risk === "high" || risk === "critical",
    sessionId: input.session_id,
    origin: modifiedBy.tool
      ? {
          type: "ai",
          tool: modifiedBy.tool,
          model: modifiedBy.model ?? undefined,
          sessionId: input.session_id,
          summary: input.why_changed.slice(0, 200),
        }
      : undefined,
  };

  // 6. Run full enrichment pipeline
  const entry = enrichEntry(partial, {
    sourceType: "sdk",
    isExplicitAgent: modifiedBy.source !== "human",
    trustLevel: "high",
    fileContent: input.file_content,
    diff: input.diff,
    linesAdded: input.lines_added,
    linesRemoved: input.lines_removed,
    fileCount: 1,
    aiProposalNote: input.why_changed,
  });

  // 6a. Phase 5.8.3 (internal design note) — encrypt the sensitive `note` field at
  // rest when KODELA_MASTER_KEY is configured. No-op when not configured so
  // existing repos see no behaviour change. decisionsReader decrypts on the
  // way out for authorized callers (RBAC gates this).
  if (isEncryptionEnabled()) {
    encryptFieldsInPlace(entry as unknown as Record<string, unknown>, ENCRYPT_AT_REST_FIELDS);
  }

  // 7. Write entry + mapping file
  await writeContextEntry(repoRoot, entry);

  const mappingFile: MappingFile = {
    schemaVersion: SCHEMA_VERSION,
    filePathHash: hashFilePath(input.file_path),
    updatedAt: now,
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

  // 8. Write to SQLite index
  if (db !== null) {
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
      // Non-fatal — file-based path is source of truth
    }

    // Memory-graph edges (internal design note).
    // Own small transaction; idempotent so repeat annotate_file calls don't throw.
    try {
      insertEdges(
        db,
        edgesForAnnotation({
          entryId: entry.id,
          sessionId: entry.sessionId ?? input.session_id,
          author: modifiedBy.author,
          actorSource: modifiedBy.source,
          linkedDecisionIds: input.linked_decision_ids,
        }),
        now,
      );
    } catch {
      // Non-fatal — annotation already persisted; edges are enrichment.
    }

    // Bridge edges (internal design note) — link this FILE_CHANGE to the CODE_FUNCTION nodes
    // it touched so the graph fuses code structure with the decision/session
    // graph. Best-effort: needs file_content and a tree-sitter grammar.
    if (input.file_content) {
      try {
        const language = languageForFile(input.file_path);
        if (language) {
          const functions = await parseFunctions(input.file_content, language);
          if (functions.length > 0) {
            insertEdges(
              db,
              edgesForCodeFunctions({
                entryId: entry.id,
                filePath: input.file_path,
                functions: functions.map((f) => ({
                  astAnchor: f.ast_anchor,
                  name: f.name,
                  kind: f.kind,
                  startLine: f.startLine,
                  endLine: f.endLine,
                  language: f.language,
                })),
              }),
              now,
            );
          }
        }
      } catch {
        // Non-fatal — fusion edges are enrichment; grammar may be unavailable.
      }
    }
  }

  // 9. Link entry to session
  await linkEntryToSession(repoRoot, input.session_id, entryId, input.file_path);

  // 10. Update session's filesChangedDetail — replace existing or append new
  const existingFileContext = (session.filesChangedDetail ?? []).find(
    (f) => f.path === input.file_path,
  );

  // Phase 2 supersede: if the existing FileChangeContext for this path was
  // synthesized by the worker, the agent's real annotation now supersedes it.
  // We preserve the synthesized entry IDs in the new agent-authored
  // FileChangeContext.entryIds so the synthesized ContextEntry stays
  // discoverable in the timeline, log the event for traceability, and let
  // the new FileChangeContext's provenance="agent-authored" + replacement
  // semantics carry the dashboard's draft-treatment removal.
  const isSupersedingSynthesis = existingFileContext?.provenance === "synthesized";
  if (isSupersedingSynthesis) {
    process.stderr.write(
      `[kodela-mcp] annotate_file superseded synthesized entry(s) ` +
      `[${(existingFileContext?.entryIds ?? []).join(",")}] ` +
      `for file=${input.file_path} session=${input.session_id} ` +
      `with new agent entry=${entryId}\n`,
    );
  }

  const fileContext = {
    path: input.file_path,
    linesAdded: input.lines_added,
    linesRemoved: input.lines_removed,
    modifiedBy: {
      source: modifiedBy.source as "ai" | "human" | "mixed",
      tool: modifiedBy.tool,
      model: modifiedBy.model,
      author: modifiedBy.author,
      ...(input.modified_by?.ai_session_url
        ? { aiSessionUrl: input.modified_by.ai_session_url }
        : {}),
    },
    whyChanged: input.why_changed,
    problemSolved: input.problem_solved,
    ...(input.ai_reasoning ? { aiReasoning: input.ai_reasoning } : {}),
    ...(input.alternatives_considered
      ? { alternativesConsidered: input.alternatives_considered }
      : {}),
    relatedFiles: input.related_files,
    relatedEntryIds: existingFileContext?.relatedEntryIds ?? [],
    risk,
    reviewRequired: risk === "high" || risk === "critical",
    entryIds: existingFileContext
      ? [...new Set([...existingFileContext.entryIds, entryId])]
      : [entryId],
    firstAnnotatedAt: existingFileContext?.firstAnnotatedAt ?? now,
    lastUpdatedAt: now,
    // Phase 1 of doc 23 catch-up plan: every annotate_file call originates
    // from an AI agent (or a human, distinguished via modifiedBy.source). The
    // dashboard's draft / dashed UI treatment is reserved for synthesized
    // entries from the Phase 2 worker, so we tag this path explicitly.
    // `as const` keeps the literal narrow so writeSession's schema accepts it.
    provenance: (modifiedBy.source === "human" ? "human-authored" : "agent-authored") as
      | "human-authored"
      | "agent-authored",
  };

  // Re-read before write to avoid lost updates when annotate + session_end overlap.
  const latest = await readSession(repoRoot, input.session_id);
  if (!latest) {
    return {
      ok: false,
      error: `Session not found: ${input.session_id}`,
      filePath: input.file_path,
      enriched: false,
      modifiedBy: { source: modifiedBy.source, tool: modifiedBy.tool },
    };
  }
  const existingOthers = (latest.filesChangedDetail ?? []).filter(
    (f) => f.path !== input.file_path,
  );

  const touchedFiles = Array.from(
    new Set([...(latest.touchedFiles ?? []), input.file_path]),
  );

  // Tag the session as MCP-sourced so the dashboard / envelope can show
  // 'captured via: mcp' instead of the misleading 'captureSource empty' badge.
  const captureSources = Array.from(
    new Set([...(latest.captureSources ?? []), "mcp"]),
  );

  const updatedSession = {
    ...latest,
    filesChangedDetail: [...existingOthers, fileContext],
    touchedFiles,
    captureSources,
  };

  await writeSession(repoRoot, updatedSession);
  // SaaS / team mode — keep the Postgres session row in sync with each
  // annotated file (touchedFiles / filesChangedDetail) so the dashboard's
  // session view reflects progress before close. Non-fatal on failure.
  if (backend) {
    try {
      await backend.writeSession(updatedSession, repoRoot);
    } catch {
      // Non-fatal — session_end re-mirrors the final state.
    }
  }

  // SaaS / team mode — dual-write the entry to Postgres `entries` (the store
  // the dashboard reads). Keeps the local filesystem + SQLite writes as the
  // MCP read path's source of truth while ensuring the per-file "why" reaches
  // the team store. A remote failure is reported, never swallowed.
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
    ok: true,
    entryId,
    filePath: input.file_path,
    enriched: Boolean(input.file_content || input.diff),
    modifiedBy: { source: modifiedBy.source, tool: modifiedBy.tool },
    ...(remote ? { remote } : {}),
  };
}

// ── Actor resolution ──────────────────────────────────────────────────────────

type ResolvedActor = {
  source: "ai" | "human" | "mixed";
  tool: string | null;
  model: string | null;
  author: string;
};

function resolveModifiedBy(
  override: AnnotateFileInput["modified_by"],
  sessionActor: { tool: string; model: string | null; author: string },
): ResolvedActor {
  if (!override) {
    // Default: session actor wrote this file as AI
    return {
      source: "ai",
      tool: sessionActor.tool,
      model: sessionActor.model,
      author: sessionActor.author,
    };
  }

  if (override.source === "human") {
    // Human edits: force tool + model to null
    return {
      source: "human",
      tool: null,
      model: null,
      author: override.author ?? sessionActor.author,
    };
  }

  // AI or mixed: fill missing fields from session actor
  return {
    source: override.source,
    tool: override.tool !== undefined ? override.tool : sessionActor.tool,
    model: override.model !== undefined ? override.model : sessionActor.model,
    author: override.author ?? sessionActor.author,
  };
}

// ── Response formatter ────────────────────────────────────────────────────────

export function formatAnnotateFileResponse(result: {
  ok: boolean;
  entryId?: string;
  filePath: string;
  enriched: boolean;
  modifiedBy: { source: string; tool: string | null };
  error?: string;
  remote?: { stored: boolean; mode: string; error?: string };
}): string {
  if (!result.ok) {
    return JSON.stringify({ ok: false, error: result.error, filePath: result.filePath }, null, 2);
  }
  return JSON.stringify(
    {
      ok: true,
      entryId: result.entryId,
      filePath: result.filePath,
      enriched: result.enriched,
      modifiedBy: result.modifiedBy,
      ...(result.remote ? { remote: result.remote } : {}),
      message:
        `Per-file context recorded for ${result.filePath}. ` +
        `Actor: ${result.modifiedBy.source}${result.modifiedBy.tool ? ` (${result.modifiedBy.tool})` : ""}.`,
    },
    null,
    2,
  );
}
