// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * MCP Context Layer — `kodela_session_start` tool.
 *
 * Call once at the beginning of a session, before any file changes are made.
 * Stores the user's exact prompt (T1 intent), actor metadata (WHO block),
 * branch context, and linked ticket so that `kodela_session_end` can assemble
 * a rich MCPContextEnvelope with 90-95% intent confidence.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startSession, updateSessionGoal } from "@kodela/core/sessions";
import { readSession, writeSession, listSessions } from "@kodela/core";
import type { KodelaSession } from "@kodela/core";
import { resolveActorFromEnv } from "../lib/resolve-actor.js";

/**
 * Stop-hook and PostToolUse injected text — must never become a session goal
 * (creates polluted "no-change" sessions that show up as junk in the
 * dashboard's session list).
 *
 * Match is intentionally substring-based on the lowercased prompt so the
 * hook can edit its phrasing without losing the guard. Add new entries here
 * whenever a hook produces a system-injected prompt the agent might forward.
 */
const HOOK_BOILERPLATE_NEEDLES: readonly string[] = [
  "all files are annotated. now close the kodela session",
  "you have ", // catches "You have N file(s) pending Kodela annotation"
  "kodela session ", // catches "Kodela session <id> is active…" injections
  "stop hook feedback",
  "stop_hook_active",
  "userpromptsubmit hook",
  "posttooluse hook",
];

function isHookBoilerplatePrompt(prompt: string): boolean {
  const lower = prompt.trim().toLowerCase();
  if (lower.length === 0) return true;
  return HOOK_BOILERPLATE_NEEDLES.some((needle) => lower.includes(needle));
}

async function findOpenSession(repoRoot: string): Promise<KodelaSession | null> {
  const sessions = await listSessions(repoRoot);
  const open = sessions.filter((s) => !s.endedAt);
  if (open.length === 0) return null;
  return open.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
}

export const SessionStartInputSchema = z.object({
  user_prompt: z
    .string()
    .min(1)
    .describe("The user's exact request — verbatim, unedited"),
  actor_tool: z
    .string()
    .min(1)
    .describe('AI tool name (e.g. "claude-code", "cursor")'),
  actor_model: z
    .string()
    .optional()
    .describe('Model identifier (e.g. "claude-sonnet-4")'),
  actor_author: z
    .string()
    .optional()
    .describe("Developer username or email"),
  branch_context: z
    .string()
    .optional()
    .describe("Current git branch name"),
  linked_ticket: z
    .string()
    .optional()
    .describe('Ticket reference (e.g. "JIRA-1234", "LINEAR-456")'),
  session_id: z
    .string()
    .optional()
    .describe("Explicit session UUID; auto-generated if omitted"),
});

export type SessionStartInput = z.infer<typeof SessionStartInputSchema>;

export interface SessionStartResult {
  sessionId: string;
  startedAt: string;
  baselineCommit?: string;
  baselineBranch?: string;
  isGitRepo: boolean;
  message: string;
}

// ── Git baseline capture ──────────────────────────────────────────────────────

interface GitBaseline {
  isGitRepo: boolean;
  baselineCommit?: string;
  baselineBranch?: string;
}

/**
 * Capture the current git state as a baseline for session_end enforcement.
 *
 * Uses `git stash create` to get a commit hash that includes uncommitted
 * changes (so files already dirty at session start aren't falsely flagged).
 * Falls back to `git rev-parse HEAD` if the tree is clean.
 */
function captureGitBaseline(repoRoot: string): GitBaseline {
  // Is this a git repo?
  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    return { isGitRepo: false };
  }

  try {
    // git stash create writes a commit object including uncommitted state
    // but doesn't modify the working tree. Returns empty string if clean.
    const stashCommit = execSync("git stash create", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // Fall back to HEAD if tree was clean (stash create returns empty)
    const baseline = stashCommit || execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    return {
      isGitRepo: true,
      baselineCommit: baseline || undefined,
      baselineBranch: branch || undefined,
    };
  } catch {
    // Git exists but command failed (no commits yet, etc.)
    return { isGitRepo: true };
  }
}

export async function sessionStart(
  repoRoot: string,
  input: SessionStartInput,
): Promise<SessionStartResult> {
  // Reject hook/system boilerplate as a session goal (A3 server-side guard).
  // Without this, every stop-hook reminder / system-reminder prompt spawns its
  // own session, polluting the dashboard with hundreds of empty 'unknown'
  // sessions.
  if (isHookBoilerplatePrompt(input.user_prompt)) {
    const open = await findOpenSession(repoRoot);
    if (open) {
      return {
        sessionId: open.id,
        startedAt: open.startedAt,
        baselineCommit: open.baselineCommit,
        baselineBranch: open.baselineBranch,
        isGitRepo: open.isGitRepo ?? true,
        message:
          "Skipped session start for hook boilerplate. Reusing open session. " +
          "Call kodela_session_end for this session when done.",
      };
    }
    throw new Error(
      "Cannot start a session from hook boilerplate. " +
      "Call kodela_session_end on the active session, or supply a real user prompt.",
    );
  }

  const actor = resolveActorFromEnv(input);

  // Reuse an already-open session instead of creating a duplicate (A6).
  // Only reuse when the actor platform matches — never cross Cursor/Claude.
  const existingOpen = await findOpenSession(repoRoot);
  if (existingOpen) {
    const existingTool = existingOpen.actor?.tool;
    if (!existingTool || existingTool === actor.tool) {
      return {
        sessionId: existingOpen.id,
        startedAt: existingOpen.startedAt,
        baselineCommit: existingOpen.baselineCommit,
        baselineBranch: existingOpen.baselineBranch,
        isGitRepo: existingOpen.isGitRepo ?? true,
        message:
          "Reusing open session. Call kodela_annotate_file for each file you change, " +
          "then kodela_session_end when done.",
      };
    }
  }
  const sessionId = input.session_id ?? randomUUID();

  // Capture git baseline before any changes happen
  const gitBaseline = captureGitBaseline(repoRoot);

  const session = await startSession(repoRoot, sessionId, {
    model: actor.model,
    goal: input.user_prompt,
  });

  const updated = await readSession(repoRoot, sessionId);
  if (updated) {
    const withActorAndBaseline = {
      ...updated,
      actor: {
        tool: actor.tool,
        model: actor.model,
        author: actor.author,
      },
      branchContext: input.branch_context ?? gitBaseline.baselineBranch,
      linkedTicket: input.linked_ticket,
      // Git baseline fields
      baselineCommit: gitBaseline.baselineCommit,
      baselineBranch: gitBaseline.baselineBranch,
      isGitRepo: gitBaseline.isGitRepo,
    };
    await writeSession(repoRoot, withActorAndBaseline);
  }

  if (session.goal !== input.user_prompt) {
    await updateSessionGoal(repoRoot, sessionId, input.user_prompt);
  }

  return {
    sessionId,
    startedAt: session.startedAt,
    baselineCommit: gitBaseline.baselineCommit,
    baselineBranch: gitBaseline.baselineBranch,
    isGitRepo: gitBaseline.isGitRepo,
    message:
      "Session started. Call kodela_annotate_file for each file you change, then kodela_session_end when done.",
  };
}

export function formatSessionStartResponse(result: SessionStartResult): string {
  return JSON.stringify(result, null, 2);
}
