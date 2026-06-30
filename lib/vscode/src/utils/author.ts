// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function normalized(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function readGitAuthor(repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "user.name"], {
      cwd: repoRoot,
    });
    return normalized(stdout);
  } catch {
    return undefined;
  }
}

export async function resolveAuthor(repoRoot: string): Promise<string> {
  const explicit =
    normalized(process.env["KODELA_AUTHOR"])
    ?? normalized(process.env["GIT_AUTHOR_NAME"])
    ?? normalized(process.env["GIT_COMMITTER_NAME"]);
  if (explicit) return explicit;

  const gitAuthor = await readGitAuthor(repoRoot);
  return gitAuthor ?? "unknown";
}
