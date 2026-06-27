// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ExecResult = { stdout: string; stderr: string };

export async function runGit(
  args: string[],
  cwd: string,
  timeoutMs = 10000,
): Promise<ExecResult> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function tryRunGit(
  args: string[],
  cwd: string,
): Promise<ExecResult | null> {
  try {
    return await runGit(args, cwd);
  } catch {
    return null;
  }
}
