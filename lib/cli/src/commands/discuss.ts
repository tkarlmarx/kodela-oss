// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 44 — Annotation discussion threads.
 *
 * Three modes:
 *
 *   kodela discuss <entryId>
 *     Lists the active (unresolved) comment thread for the entry.
 *     Add --all to include resolved comments.
 *
 *   kodela discuss <entryId> --add "your comment"
 *     Appends a new comment as the current git user.
 *
 *   kodela discuss <entryId> --resolve <commentId>
 *     Marks the specified comment as resolved (sets resolvedAt).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  readComments,
  writeComment,
  resolveComment,
} from "@kodela/core";
import type { ContextComment } from "@kodela/core";

const execFileAsync = promisify(execFile);

async function resolveAuthor(repoRoot: string): Promise<string> {
  if (process.env["KODELA_AUTHOR"]) {
    return process.env["KODELA_AUTHOR"];
  }
  try {
    const { stdout: email } = await execFileAsync(
      "git",
      ["config", "user.email"],
      { cwd: repoRoot },
    );
    const trimmed = email.trim();
    if (trimmed) return trimmed;
  } catch {
    // fall through to name
  }
  try {
    const { stdout: name } = await execFileAsync(
      "git",
      ["config", "user.name"],
      { cwd: repoRoot },
    );
    const trimmed = name.trim();
    if (trimmed) return trimmed;
  } catch {
    // fall through to unknown
  }
  return "unknown";
}

export type DiscussOptions = {
  repoRoot: string;
  entryId: string;
  add?: string;
  resolve?: string;
  all?: boolean;
};

export type DiscussResult =
  | { mode: "list"; comments: ContextComment[]; includeResolved: boolean }
  | { mode: "added"; comment: ContextComment }
  | { mode: "resolved"; commentId: string; found: boolean };

export async function runDiscuss(opts: DiscussOptions): Promise<DiscussResult> {
  const { repoRoot, entryId } = opts;

  if (opts.add !== undefined) {
    const author = await resolveAuthor(repoRoot);
    const comment: ContextComment = {
      id: randomUUID(),
      entryId,
      author,
      body: opts.add,
      createdAt: new Date().toISOString(),
    };
    await writeComment(repoRoot, comment);
    return { mode: "added", comment };
  }

  if (opts.resolve !== undefined) {
    const found = await resolveComment(repoRoot, entryId, opts.resolve);
    return { mode: "resolved", commentId: opts.resolve, found };
  }

  const includeResolved = opts.all ?? false;
  const comments = await readComments(repoRoot, entryId, { includeResolved });
  return { mode: "list", comments, includeResolved };
}

export function formatDiscussResult(result: DiscussResult): string {
  if (result.mode === "added") {
    const c = result.comment;
    return [
      `Comment posted on entry ${c.entryId}`,
      `  ID:      ${c.id}`,
      `  Author:  ${c.author}`,
      `  Posted:  ${c.createdAt}`,
      `  Body:    ${c.body}`,
    ].join("\n");
  }

  if (result.mode === "resolved") {
    if (!result.found) {
      return `Comment ${result.commentId} not found — nothing changed.`;
    }
    return `Comment ${result.commentId} marked as resolved.`;
  }

  // mode === "list"
  if (result.comments.length === 0) {
    const qualifier = result.includeResolved ? "" : "active ";
    return `No ${qualifier}comments on this entry.`;
  }

  const header = result.includeResolved
    ? `Discussion thread (${result.comments.length} total, including resolved):`
    : `Discussion thread (${result.comments.length} active):`;

  const lines: string[] = [header];
  for (const c of result.comments) {
    const resolvedLabel = c.resolvedAt ? ` [resolved ${c.resolvedAt}]` : "";
    lines.push(`\n  [${c.id}]${resolvedLabel}`);
    lines.push(`  ${c.author}  ${c.createdAt}`);
    lines.push(`  ${c.body}`);
  }
  return lines.join("\n");
}
