// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Enterprise shared-memory read for the MCP server (`storage.readMode`).
 *
 * Resolves whether — and how — kodela_get_context should augment the local
 * index with the org's shared Postgres memory, then fetches it. Mirrors the
 * CLI's resolution (config → env → license → git remote) so an org that sets
 * readMode centrally gets shared memory in the editor with no per-dev setup.
 *
 * Note: the MCP server always runs inside a repo with a local index, and
 * staleness/decision-fusion need that local index, so BOTH "remote" and "merge"
 * are applied as a merge (local ∪ remote, local wins ties) here — the agent is
 * never shown less than its own repo's captured why.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  loadLicense,
  resolveRepoIdentity,
  fetchRemoteContext,
  fetchRemoteRecall,
  fetchRemoteWhy,
  type ProjectContext,
  type RemoteRecallResult,
  type WhyItem,
} from "@kodela/core";

interface KodelaConfigStorage {
  readMode?: "local" | "remote" | "merge";
  server?: { url?: string; api_key_env?: string };
}

async function readStorageConfig(repoRoot: string): Promise<KodelaConfigStorage> {
  try {
    const raw = await readFile(path.join(repoRoot, "kodela.config.json"), "utf8");
    const parsed = JSON.parse(raw) as { storage?: KodelaConfigStorage };
    return parsed.storage ?? {};
  } catch {
    return {};
  }
}

export interface SharedMemoryQuery {
  filePath?: string;
  intent?: string;
  tokenBudget: number;
}

interface SharedConfig {
  serverUrl: string;
  apiKey: string;
  orgId: string;
  repoFullName: string;
  readMode: "remote" | "merge";
}

/**
 * Resolve the shared-memory read config (config → env → license → git remote)
 * when readMode is remote|merge. Returns null (read local only) when readMode is
 * local or anything needed to reach the server is missing.
 */
async function resolveSharedConfig(
  repoRoot: string,
  onWarn?: (message: string) => void,
): Promise<SharedConfig | null> {
  const storage = await readStorageConfig(repoRoot);
  const readMode = storage.readMode ?? "local";
  if (readMode !== "remote" && readMode !== "merge") return null;

  const serverUrl = storage.server?.url;
  const apiKeyEnv = storage.server?.api_key_env ?? "KODELA_API_KEY";
  const apiKey = process.env[apiKeyEnv];
  const orgId = process.env["KODELA_ORG_ID"] ?? (await loadLicense(repoRoot))?.orgId;
  const repoFullName =
    process.env["KODELA_REPO"] ?? (await resolveRepoIdentity(repoRoot))?.repoFullName;

  if (!serverUrl || !apiKey || !orgId || !repoFullName) {
    onWarn?.(
      `readMode="${readMode}" set but shared-memory config is incomplete ` +
        `(need server URL, ${apiKeyEnv}, org id, and a git remote); reading local only.`,
    );
    return null;
  }
  return { serverUrl, apiKey, orgId, repoFullName, readMode };
}

/**
 * Recall over the org's shared memory when readMode is remote|merge. Returns null
 * (local-only) when unconfigured/offline. The caller decides whether to replace
 * (remote) or merge (merge) with the local recall.
 */
export async function fetchSharedRecall(
  repoRoot: string,
  query: string,
  limit: number,
  onWarn?: (message: string) => void,
): Promise<{ mode: "remote" | "merge"; result: RemoteRecallResult } | null> {
  const cfg = await resolveSharedConfig(repoRoot, onWarn);
  if (!cfg) return null;
  try {
    const result = await fetchRemoteRecall({ ...cfg, query, limit });
    return { mode: cfg.readMode, result };
  } catch (err) {
    onWarn?.(
      `shared-memory recall failed (${err instanceof Error ? err.message : String(err)}); reading local only.`,
    );
    return null;
  }
}

/**
 * "Why is this file here?" over the org's shared memory when readMode is
 * remote|merge. Returns null (local-only) when unconfigured/offline. The caller
 * decides whether to replace (remote) or merge (merge) with the local why.
 */
export async function fetchSharedWhy(
  repoRoot: string,
  filePath: string,
  opts: { maxDepth?: number; minEdgeConfidence?: number; asOf?: string },
  onWarn?: (message: string) => void,
): Promise<{ mode: "remote" | "merge"; items: WhyItem[] } | null> {
  const cfg = await resolveSharedConfig(repoRoot, onWarn);
  if (!cfg) return null;
  try {
    const items = await fetchRemoteWhy({ ...cfg, filePath, ...opts });
    return { mode: cfg.readMode, items };
  } catch (err) {
    onWarn?.(
      `shared-memory why failed (${err instanceof Error ? err.message : String(err)}); reading local only.`,
    );
    return null;
  }
}

/**
 * Fetch the org's shared context for this repo when readMode is remote|merge and
 * everything needed to reach the server resolves. Returns null (read local only)
 * when readMode is local, config is incomplete, or the remote read fails — the
 * caller then serves the local index unchanged.
 */
export async function fetchSharedContext(
  repoRoot: string,
  query: SharedMemoryQuery,
  onWarn?: (message: string) => void,
): Promise<ProjectContext | null> {
  const cfg = await resolveSharedConfig(repoRoot, onWarn);
  if (!cfg) return null;

  try {
    return await fetchRemoteContext({
      ...cfg,
      filePath: query.filePath,
      intent: query.intent,
      tokenBudget: query.tokenBudget,
    });
  } catch (err) {
    onWarn?.(
      `shared-memory read failed (${err instanceof Error ? err.message : String(err)}); reading local only.`,
    );
    return null;
  }
}
