// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContextEntry } from "@kodela/core";
import type { StatusResult } from "../status/metrics.js";

const execFileAsync = promisify(execFile);

/**
 * Parse a git remote URL and extract the "owner/repo" portion.
 * Handles both HTTPS (https://github.com/owner/repo[.git]) and
 * SSH (git@github.com:owner/repo[.git]) formats for GitHub and GitLab.
 * Returns null if the URL cannot be recognised.
 */
function parseGitRemoteFullName(remoteUrl: string): string | null {
  const httpsMatch = remoteUrl.match(
    /(?:https?:\/\/)?(?:www\.)?(?:github|gitlab)\.com\/([^/]+\/[^/.]+?)(?:\.git)?\s*$/,
  );
  if (httpsMatch?.[1]) return httpsMatch[1];

  const sshMatch = remoteUrl.match(
    /@(?:github|gitlab)\.com:([^/]+\/[^/.]+?)(?:\.git)?\s*$/,
  );
  if (sshMatch?.[1]) return sshMatch[1];

  return null;
}

interface ConnectedRepo {
  id: string;
  repoFullName: string;
}

/**
 * Push a coverage snapshot to the Kodela API server after a `kodela status` run.
 *
 * Flow:
 *  1. Resolve the current repo's full name from `git remote get-url origin`.
 *  2. Fetch the list of connected repos from the server to find the matching repoId.
 *  3. POST the computed snapshot metrics to POST /api/dashboard/repos/:repoId/snapshots.
 *
 * This function is intentionally non-fatal — all errors are silently swallowed
 * so they never block the primary `status` output or exit code.
 */
export async function pushSnapshotToServer(
  apiUrl: string,
  orgId: string,
  apiSecret: string | undefined,
  repoRoot: string,
  result: StatusResult,
  entries: ContextEntry[],
): Promise<void> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Kodela-Org-Id": orgId,
  };
  if (apiSecret) {
    headers["Authorization"] = `Bearer ${apiSecret}`;
  }

  let remoteUrl: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: repoRoot, timeout: 5_000 },
    );
    remoteUrl = stdout.trim();
  } catch {
    return;
  }

  const repoFullName = parseGitRemoteFullName(remoteUrl);
  if (!repoFullName) return;

  const reposRes = await fetch(`${apiUrl}/api/dashboard/repos`, {
    headers,
    signal: AbortSignal.timeout(5_000),
  });
  if (!reposRes.ok) return;

  const repos = (await reposRes.json()) as ConnectedRepo[];
  const repo = repos.find((r) => r.repoFullName === repoFullName);
  if (!repo) return;

  const aiGeneratedPct =
    entries.length > 0
      ? (entries.filter((e) => e.source === "ai").length / entries.length) * 100
      : 0;

  await fetch(`${apiUrl}/api/dashboard/repos/${repo.id}/snapshots`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      totalEntries: result.total,
      mappedEntries: result.mapped,
      aiGeneratedPct,
      unresolvedCriticalPct: result.unresolved_critical_pct,
      orphanedPct: result.orphaned_pct,
      confidenceScore: result.confidence_score,
    }),
    signal: AbortSignal.timeout(5_000),
  });
}
