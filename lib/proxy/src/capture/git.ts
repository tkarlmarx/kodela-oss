// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const exec = promisify(execFile);

export interface GitContext {
  branch: string;
  commitSha: string;
  commitMessage: string;
  author: string;
  email: string;
  repoRoot: string;
  isDirty: boolean;
  workingDir: string;
  projectId: string;
}

const DEFAULT_CONTEXT: GitContext = {
  branch: "unknown",
  commitSha: "unknown",
  commitMessage: "",
  author: "unknown",
  email: "",
  repoRoot: process.cwd(),
  isDirty: false,
  workingDir: process.cwd(),
  projectId: "",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

export async function captureGitContext(workingDir: string): Promise<GitContext> {
  const ctx: GitContext = { ...DEFAULT_CONTEXT, workingDir, repoRoot: workingDir };

  try {
    ctx.branch = await git(workingDir, "rev-parse", "--abbrev-ref", "HEAD");
  } catch {
  }

  try {
    const log = await git(workingDir, "log", "-1", "--format=%H|%s|%an|%ae");
    const [sha, msg, author, email] = log.split("|");
    if (sha) ctx.commitSha = sha;
    if (msg) ctx.commitMessage = msg;
    if (author) ctx.author = author;
    if (email) ctx.email = email;
  } catch {
  }

  try {
    const status = await git(workingDir, "status", "--porcelain");
    ctx.isDirty = status.length > 0;
  } catch {
  }

  try {
    const rootPath = await git(workingDir, "rev-parse", "--show-toplevel");
    if (rootPath) ctx.repoRoot = rootPath;
  } catch {
  }

  try {
    const remoteUrl = await git(workingDir, "remote", "get-url", "origin");
    if (remoteUrl) {
      ctx.projectId = createHash("sha256").update(remoteUrl).digest("hex").slice(0, 16);
    }
  } catch {
  }

  return ctx;
}
