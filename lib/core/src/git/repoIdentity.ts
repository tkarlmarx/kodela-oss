// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Resolve the current repo's "owner/repo" full name + provider from
 * `git remote get-url origin`. Lives in core so the CLI (central sync, context
 * read) and the MCP server (shared-memory read) resolve repo identity the same
 * way. Best-effort — returns null when there is no recognisable remote.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RepoProvider = "github" | "gitlab" | "local";

export interface RepoIdentity {
  repoFullName: string;
  provider: RepoProvider;
}

/**
 * Parse a git remote URL into { repoFullName, provider }. Host-agnostic so it
 * works for **self-hosted GitHub Enterprise / GitLab** (the enterprise norm) and
 * proxied remotes, not just github.com / gitlab.com. Handles HTTPS/SSH URL forms
 * and scp-style `git@host:owner/repo`. `repoFullName` is the last two path
 * segments (`owner/repo`); `provider` is inferred from the host. Returns null if
 * owner/repo can't be recovered.
 */
export function parseRepoIdentity(remoteUrl: string): RepoIdentity | null {
  const url = remoteUrl.trim();
  if (!url) return null;

  // Host — everything after an optional scheme + userinfo, up to the first
  // "/", ":" or end. Used only to guess the provider.
  const host = url.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)/i)?.[1] ?? "";
  const provider: RepoProvider = /gitlab/i.test(host)
    ? "gitlab"
    : /github/i.test(host)
      ? "github"
      : "local";

  // Path — the owner/repo portion, from either scp-style or URL-style remotes.
  let pathPart: string;
  const scp = url.match(/^[^/]+@[^/:]+:(.+)$/); // git@host:owner/repo(.git)
  if (scp) {
    pathPart = scp[1]!;
  } else {
    const urlStyle = url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i); // scheme://host/owner/repo
    pathPart = urlStyle ? urlStyle[1]! : url; // else a bare owner/repo
  }

  const segments = pathPart
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) return null;

  return { repoFullName: segments.slice(-2).join("/"), provider };
}

/** Resolve the repo identity from `origin`, or null if unavailable. */
export async function resolveRepoIdentity(
  repoRoot: string,
): Promise<RepoIdentity | null> {
  let remoteUrl: string;
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      timeout: 5_000,
    });
    remoteUrl = stdout.trim();
  } catch {
    return null;
  }
  if (!remoteUrl) return null;
  return parseRepoIdentity(remoteUrl);
}
