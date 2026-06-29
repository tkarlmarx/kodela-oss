// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * MCP Context Layer — `kodela_session_end` tool.
 *
 * Call once when the session is complete. Closes the session, validates
 * per-file context completeness using git-diff enforcement, assembles the
 * MCPContextEnvelope, and persists it to `.kodela/sessions/<id>.mcp.json`.
 *
 * Enforcement logic:
 *   1. Runs `git diff` against the baseline commit captured at session_start
 *   2. Applies auto-exclude rules (lock files, generated code, .kodelaignore)
 *   3. Compares remaining files against what was annotated via kodela_annotate_file
 *   4. If any files are missing annotation → BLOCK (unless force: true)
 *
 * Git is authoritative. The watcher's data in filesChangedDetail is preserved
 * but not used as the enforcement source.
 */

import { z } from "zod";
import {
  closeSession,
  getSessionEntries,
  buildMCPEnvelope,
  getFilesChangedSince,
  partitionFiles,
} from "@kodela/core/sessions";
import { readSession } from "@kodela/core";
import type { StorageBackend } from "@kodela/core";
import type { MCPContextEnvelope } from "@kodela/core/sessions";
import { enqueueSynthesisEvent } from "@kodela/core/synthesis";

export const SessionEndInputSchema = z.object({
  session_id: z
    .string()
    .min(1)
    .describe("Session ID from kodela_session_start"),
  outcome: z
    .enum(["success", "partial", "abandoned"])
    .default("success")
    .describe("Session outcome"),
  commit_message: z
    .string()
    .optional()
    .describe("Commit message if one exists; used as T3 intent source"),
  force: z
    .boolean()
    .optional()
    .describe(
      "Override enforcement — close even if files are missing annotation. " +
      "Not recommended. Provide force_reason when using this.",
    ),
  force_reason: z
    .string()
    .optional()
    .describe("Reason for force-closing (required when force: true)."),
});

export type SessionEndInput = z.infer<typeof SessionEndInputSchema>;

// ── Result types ──────────────────────────────────────────────────────────────

export interface SessionEndResult {
  ok: true;
  sessionId: string;
  envelope: MCPContextEnvelope;
  perFileContextComplete: boolean;
  filesAnnotated: number;
  filesDetectedByGit: number;
  autoExcludedCount: number;
  forceOverride: boolean;
  actorBreakdown: { ai: number; human: number; mixed: number };
  /**
   * Files present in the baseline-vs-HEAD git diff that this session never
   * claimed it touched. Informational only — never blocks close. They are
   * typically pre-existing working-tree changes that predate the session.
   */
  outOfScopeFiles: string[];
  /**
   * Phase 2 — number of synthesis events the close enqueued for the async
   * worker to pick up. One event per git-detected file that lacks a real
   * agent-authored whyChanged. Zero when every detected file was annotated
   * synchronously.
   */
  synthesisEventsEnqueued: number;
  /**
   * SaaS / team mode only — outcome of mirroring the closed session into
   * Postgres (the store the dashboard reads). Absent in local mode.
   */
  remote?: { stored: boolean; mode: string; error?: string };
}

export interface SessionEndIncompleteResult {
  ok: false;
  error: "INCOMPLETE_PER_FILE_CONTEXT";
  message: string;
  missingFiles: string[];
  autoExcludedFiles: string[];
  /** See SessionEndResult.outOfScopeFiles — informational. */
  outOfScopeFiles: string[];
  hint: string;
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function sessionEnd(
  repoRoot: string,
  input: SessionEndInput,
  backend?: StorageBackend | null,
): Promise<SessionEndResult | SessionEndIncompleteResult> {
  const { session_id, commit_message, force = false, force_reason } = input;

  // ── Load session ──────────────────────────────────────────────────────────
  const session = await readSession(repoRoot, session_id);
  if (!session) {
    throw new Error(`Session not found: ${session_id}`);
  }

  // ── Determine files actually changed via git ──────────────────────────────
  let filesDetectedByGit: string[] = [];
  let autoExcludedFiles: string[] = [];
  let kodelaIgnoredFiles: string[] = [];

  if (session.isGitRepo !== false && session.baselineCommit) {
    // Git is available and we have a baseline — use git as authoritative source
    const allChanged = getFilesChangedSince(repoRoot, session.baselineCommit);

    // Apply exclusion rules
    const partition = partitionFiles(
      allChanged.map((f) => f.path),
      repoRoot,
    );

    filesDetectedByGit = partition.enforced;
    autoExcludedFiles = partition.autoExcluded;
    kodelaIgnoredFiles = partition.kodelaIgnored;
  } else {
    // Not a git repo or no baseline — fall back to session.filesChanged
    const fallbackFiles = [
      ...new Set([
        ...(session.filesChanged ?? []),
        ...(session.changes?.files ?? []),
      ]),
    ].filter((f) => f.length > 0);

    if (fallbackFiles.length > 0) {
      const partition = partitionFiles(fallbackFiles, repoRoot);
      filesDetectedByGit = partition.enforced;
      autoExcludedFiles = partition.autoExcluded;
      kodelaIgnoredFiles = partition.kodelaIgnored;
    }
  }

  // ── Determine which files are annotated (re-read to avoid annotate race) ──
  const sessionForAnnot = await readSession(repoRoot, session_id);
  const annotatedDetail = sessionForAnnot?.filesChangedDetail ?? session.filesChangedDetail ?? [];
  const annotatedPaths = new Set(annotatedDetail.map((f) => f.path));

  // ── Session-scoped enforcement (Sprint 1 / Pillar A) ──────────────────────
  //
  // Old behavior: missing = filesDetectedByGit − annotatedPaths
  //   This conflated working-tree state with session scope. Any file modified
  //   before the session started counted as "missing context" and blocked close.
  //
  // New behavior: scope enforcement to files the session claimed it touched.
  //   touchedFiles is populated by kodela_annotate_file (and, in later sprints,
  //   by watcher events). Files in gitDiff but outside touchedFiles are
  //   reported as outOfScopeFiles — informational, never blocking.
  //
  // Backward compat: when touchedFiles is undefined AND filesChangedDetail
  //   is empty, no scope claim exists, so we fall back to legacy full-diff
  //   enforcement to preserve behavior for older sessions.
  const sessionTouched = sessionForAnnot?.touchedFiles ?? session.touchedFiles;
  const hasScopeClaim = (sessionTouched && sessionTouched.length > 0) || annotatedDetail.length > 0;

  const touchedSet = new Set<string>([
    ...(sessionTouched ?? []),
    ...annotatedDetail.map((f) => f.path),
  ]);

  const enforcedSet = hasScopeClaim
    ? filesDetectedByGit.filter((p) => touchedSet.has(p))
    : filesDetectedByGit;

  const outOfScopeFiles = hasScopeClaim
    ? filesDetectedByGit.filter((p) => !touchedSet.has(p))
    : [];

  const missing = enforcedSet.filter((p) => !annotatedPaths.has(p));

  // ── Enforcement decision ──────────────────────────────────────────────────
  if (missing.length > 0 && !force) {
    const baselineRef = session.baselineCommit
      ? session.baselineCommit.slice(0, 8)
      : "unknown";

    return {
      ok: false,
      error: "INCOMPLETE_PER_FILE_CONTEXT",
      message:
        `Session cannot close. ${missing.length} file(s) were touched by this session ` +
        `(per kodela_annotate_file / watcher) and changed on disk (per git diff against ` +
        `baseline ${baselineRef}) but lack per-file context.`,
      missingFiles: missing,
      autoExcludedFiles: [...autoExcludedFiles, ...kodelaIgnoredFiles],
      outOfScopeFiles,
      hint:
        "Call kodela_annotate_file for each missing file with why_changed " +
        "and problem_solved. To override (not recommended), pass " +
        "force: true with a force_reason explaining why.",
    };
  }

  // ── Compute actor breakdown ───────────────────────────────────────────────
  const actorBreakdown = { ai: 0, human: 0, mixed: 0 };
  for (const fc of session.filesChangedDetail ?? []) {
    actorBreakdown[fc.modifiedBy.source] += 1;
  }

  const perFileContextComplete = missing.length === 0;

  const isForceOverride = force === true && missing.length > 0;

  // ── Close session ─────────────────────────────────────────────────────────
  await closeSession(repoRoot, session_id);

  // Update session with force override flag if applicable
  if (isForceOverride) {
    const updatedSession = await readSession(repoRoot, session_id);
    if (updatedSession) {
      updatedSession.forceOverride = true;
      const { writeSession } = await import("@kodela/core");
      await writeSession(repoRoot, updatedSession);
    }
  }

  // SaaS / team mode — mirror the final closed session (endedAt, aggregated
  // risk, per-file detail) into Postgres so the dashboard's session view
  // matches what the MCP client recorded. Re-read so we persist the closed
  // state, not the pre-close snapshot. A remote failure is surfaced on the
  // result rather than aborting the (already-completed) local close.
  let sessionRemote: { stored: boolean; mode: string; error?: string } | undefined;
  if (backend) {
    const closed = await readSession(repoRoot, session_id);
    if (closed) {
      try {
        await backend.writeSession(closed, repoRoot);
        sessionRemote = { stored: true, mode: backend.mode };
      } catch (err) {
        sessionRemote = {
          stored: false,
          mode: backend.mode,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  // ── Build envelope ────────────────────────────────────────────────────────
  const sessionWithEntries = await getSessionEntries(repoRoot, session_id);
  if (!sessionWithEntries) {
    throw new Error(`Session not found after close: ${session_id}`);
  }

  const { session: closedSession, entries } = sessionWithEntries;

  const envelope = await buildMCPEnvelope(repoRoot, closedSession, entries, {
    commitMessage: commit_message,
    outcome: input.outcome,
    actorBreakdown,
    perFileContextComplete,
  });

  // Attach git-diff enforcement fields to the envelope on disk
  // (these are optional fields on the schema, added post-build)
  const enrichedEnvelope: MCPContextEnvelope = {
    ...envelope,
    captureMethod: session.baselineCommit ? "git" : envelope.captureMethod,
    filesDetectedByGit,
    autoExcludedFiles: [...autoExcludedFiles, ...kodelaIgnoredFiles],
    forceOverride: isForceOverride,
    ...(isForceOverride && force_reason ? { forceOverrideReason: force_reason } : {}),
    perFileContextComplete,
  };

  // Phase 2 — enqueue synthesis events for git-detected files that the
  // agent never annotated. The synthesis worker (artifacts/synthesis-worker)
  // picks these up asynchronously and writes a draft annotation per file.
  // The hook is fire-and-forget — failures must never block session close.
  let synthesisEventsEnqueued = 0;
  try {
    const annotatedPathSet = annotatedPaths;
    for (const detectedPath of filesDetectedByGit) {
      // Skip files that already carry a real agent-authored annotation.
      const existing = closedSession.filesChangedDetail?.find((f) => f.path === detectedPath);
      const hasAgentAnnotation =
        existing?.provenance === "agent-authored" &&
        (existing.whyChanged?.trim().length ?? 0) >= 10;
      if (annotatedPathSet.has(detectedPath) && hasAgentAnnotation) continue;

      const result = enqueueSynthesisEvent(repoRoot, {
        sessionId: session_id,
        filePath: detectedPath,
        ...(session.baselineCommit ? { commitSha: session.baselineCommit } : {}),
      });
      if (result.enqueued) synthesisEventsEnqueued++;
    }
  } catch (err) {
    // Log only — synthesis is best-effort and must not block close.
    process.stderr.write(
      `[kodela-mcp] synthesis enqueue failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  return {
    ok: true,
    sessionId: session_id,
    envelope: enrichedEnvelope,
    perFileContextComplete,
    filesAnnotated: (session.filesChangedDetail ?? []).length,
    filesDetectedByGit: filesDetectedByGit.length,
    autoExcludedCount: autoExcludedFiles.length + kodelaIgnoredFiles.length,
    forceOverride: isForceOverride,
    actorBreakdown,
    outOfScopeFiles,
    synthesisEventsEnqueued,
    ...(sessionRemote ? { remote: sessionRemote } : {}),
  };
}

// ── Response formatter ────────────────────────────────────────────────────────

export function formatSessionEndResponse(
  result: SessionEndResult | SessionEndIncompleteResult,
): string {
  if (!result.ok) {
    return JSON.stringify(result, null, 2);
  }
  return JSON.stringify(
    {
      ...result.envelope,
      _meta: {
        perFileContextComplete: result.perFileContextComplete,
        filesAnnotated: result.filesAnnotated,
        filesDetectedByGit: result.filesDetectedByGit,
        autoExcludedCount: result.autoExcludedCount,
        forceOverride: result.forceOverride,
        actorBreakdown: result.actorBreakdown,
        outOfScopeFiles: result.outOfScopeFiles,
        ...(result.remote ? { remote: result.remote } : {}),
      },
    },
    null,
    2,
  );
}
