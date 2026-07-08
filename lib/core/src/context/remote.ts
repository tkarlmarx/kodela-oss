// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Client side of Enterprise shared memory (`storage.readMode`). Lives in core so
 * both the CLI (`kodela context`) and the MCP server (`kodela_get_context`)
 * share one implementation.
 *
 * `fetchRemoteContext` calls `GET /api/context/get` on the central server, which
 * materialises the org's Postgres-backed entries and runs the SAME
 * `buildProjectContext` the local path uses — so the envelope shape is identical
 * whether context is read locally, remotely, or merged.
 *
 * `mergeContexts` unions a local and a remote `ProjectContext` for `readMode:
 * "merge"`, deduping by entry / cluster / session id with **local winning ties**
 * (the developer's uncommitted local why is authoritative over the shared copy).
 */
import type { ProjectContext } from "./types.js";
import { formatRecallBlock, type RecallItem } from "../retrieval/recall.js";
import type { WhyItem } from "../why/whyForFile.js";

export interface FetchRemoteContextOptions {
  /** Base server URL, e.g. "https://kodela.example.com" (no trailing slash). */
  serverUrl: string;
  /** Bearer API key (from the api_key_env variable). */
  apiKey: string;
  /** Authenticated org id — sent as X-Kodela-Org-Id and checked server-side. */
  orgId: string;
  /** Raw repo_links id. Provide this OR repoFullName. */
  repoId?: string;
  /** Repo "owner/name" — resolved to a repo_links id server-side. Preferred. */
  repoFullName?: string;
  filePath?: string;
  intent?: string;
  tokenBudget?: number;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Read the org's shared memory for one repo from the central server.
 * Throws on network failure or a non-2xx response — callers that want an
 * offline fallback should catch and drop back to local read.
 */
export async function fetchRemoteContext(
  opts: FetchRemoteContextOptions,
): Promise<ProjectContext> {
  const {
    serverUrl,
    apiKey,
    orgId,
    repoId,
    repoFullName,
    filePath,
    intent,
    tokenBudget,
    fetchImpl = fetch,
  } = opts;

  if (!repoId && !repoFullName) {
    throw new Error("fetchRemoteContext requires repoId or repoFullName.");
  }

  const base = serverUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  // Prefer the ergonomic full name; the server resolves it to a repo_links id.
  if (repoFullName) params.set("repo", repoFullName);
  else if (repoId) params.set("repoId", repoId);
  if (filePath) params.set("file", filePath);
  if (intent) params.set("intent", intent);
  if (tokenBudget !== undefined) params.set("token_budget", String(tokenBudget));

  const res = await fetchImpl(`${base}/api/context/get?${params.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Kodela-Org-Id": orgId,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "unknown");
    throw new Error(`Remote context read failed — HTTP ${res.status}: ${text}`);
  }

  return (await res.json()) as ProjectContext;
}

/**
 * Union two context envelopes for `readMode: "merge"`. Deduplicates by id at
 * every layer with **local winning ties**, then recomputes `meta` counts from
 * the merged arrays. `tokenUsage` is summed as an upper bound (the two sides
 * were budgeted independently); callers that need a hard cap should re-run
 * `buildProjectContext` over the union instead.
 */
export function mergeContexts(
  local: ProjectContext,
  remote: ProjectContext,
): ProjectContext {
  const clusters = dedupeById(local.clusters, remote.clusters, (c) => c.id);
  const entries = dedupeById(local.entries, remote.entries, (e) => e.id);
  const sessions = dedupeById(local.sessions, remote.sessions, (s) => s.id);

  const warnings = [
    ...(local.warnings ?? []),
    ...(remote.warnings ?? []),
  ];

  const merged: ProjectContext = {
    clusters,
    entries,
    sessions,
    meta: {
      tokenUsage: local.meta.tokenUsage + remote.meta.tokenUsage,
      totalCandidates: local.meta.totalCandidates + remote.meta.totalCandidates,
      selectedClusters: clusters.length,
      selectedEntries: entries.length,
    },
  };

  if (local.summary || remote.summary) {
    merged.summary = local.summary ?? remote.summary;
  }
  if (warnings.length > 0) {
    merged.warnings = warnings;
  }

  return merged;
}

export interface FetchRemoteRecallOptions {
  serverUrl: string;
  apiKey: string;
  orgId: string;
  repoId?: string;
  repoFullName?: string;
  query: string;
  limit?: number;
  fetchImpl?: typeof fetch;
}

export interface RemoteRecallResult {
  items: RecallItem[];
  block: string;
}

/**
 * Recall over the org's shared memory via `GET /api/context/recall`. Throws on
 * network / non-2xx so the caller can fall back to local. Returns the ranked
 * items + a ready-to-paste block.
 */
export async function fetchRemoteRecall(
  opts: FetchRemoteRecallOptions,
): Promise<RemoteRecallResult> {
  const { serverUrl, apiKey, orgId, repoId, repoFullName, query, limit, fetchImpl = fetch } = opts;
  if (!repoId && !repoFullName) {
    throw new Error("fetchRemoteRecall requires repoId or repoFullName.");
  }
  const base = serverUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ q: query });
  if (repoFullName) params.set("repo", repoFullName);
  else if (repoId) params.set("repoId", repoId);
  if (limit !== undefined) params.set("limit", String(limit));

  const res = await fetchImpl(`${base}/api/context/recall?${params.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, "X-Kodela-Org-Id": orgId },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown");
    throw new Error(`Remote recall failed — HTTP ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { items?: RecallItem[]; block?: string };
  const items = Array.isArray(data.items) ? data.items : [];
  return { items, block: data.block ?? formatRecallBlock(query, items) };
}

/**
 * Merge local + remote recall for `readMode: "merge"`: dedupe by `ref` (local
 * wins ties), re-sort by score descending, cap at `limit`, and rebuild the
 * block. Local wins so a developer's uncommitted why ranks over the shared copy.
 */
export function mergeRecallItems(
  query: string,
  local: RecallItem[],
  remote: RecallItem[],
  limit?: number,
): RemoteRecallResult {
  const seen = new Set<string>();
  const merged: RecallItem[] = [];
  for (const it of [...local, ...remote]) {
    if (seen.has(it.ref)) continue;
    seen.add(it.ref);
    merged.push(it);
  }
  merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const capped = typeof limit === "number" ? merged.slice(0, limit) : merged;
  return { items: capped, block: formatRecallBlock(query, capped) };
}

export interface FetchRemoteWhyOptions {
  serverUrl: string;
  apiKey: string;
  orgId: string;
  repoId?: string;
  repoFullName?: string;
  filePath: string;
  maxDepth?: number;
  minEdgeConfidence?: number;
  asOf?: string;
  fetchImpl?: typeof fetch;
}

/**
 * "Why is this file here?" over the org's shared memory via
 * `GET /api/context/why`. Throws on network / non-2xx so callers can fall back
 * to local. Returns the ranked decisions (WhyItem[]).
 */
export async function fetchRemoteWhy(opts: FetchRemoteWhyOptions): Promise<WhyItem[]> {
  const {
    serverUrl, apiKey, orgId, repoId, repoFullName, filePath,
    maxDepth, minEdgeConfidence, asOf, fetchImpl = fetch,
  } = opts;
  if (!repoId && !repoFullName) {
    throw new Error("fetchRemoteWhy requires repoId or repoFullName.");
  }
  const base = serverUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ file: filePath });
  if (repoFullName) params.set("repo", repoFullName);
  else if (repoId) params.set("repoId", repoId);
  if (maxDepth !== undefined) params.set("max_depth", String(maxDepth));
  if (minEdgeConfidence !== undefined) params.set("min_edge_confidence", String(minEdgeConfidence));
  if (asOf) params.set("as_of", asOf);

  const res = await fetchImpl(`${base}/api/context/why?${params.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, "X-Kodela-Org-Id": orgId },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "unknown");
    throw new Error(`Remote why failed — HTTP ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { items?: WhyItem[] };
  return Array.isArray(data.items) ? data.items : [];
}

/**
 * Merge local + remote why for `readMode: "merge"`: dedupe by decisionId (keep
 * the higher confidence), re-sort by confidence descending.
 */
export function mergeWhyItems(local: WhyItem[], remote: WhyItem[]): WhyItem[] {
  const byId = new Map<string, WhyItem>();
  for (const it of [...local, ...remote]) {
    const prev = byId.get(it.decisionId);
    if (!prev || it.confidence > prev.confidence) byId.set(it.decisionId, it);
  }
  return [...byId.values()].sort(
    (a, b) => b.confidence - a.confidence || a.decisionId.localeCompare(b.decisionId),
  );
}

/** Concat two lists, keeping the first occurrence of each id (local wins). */
function dedupeById<T>(
  localItems: readonly T[],
  remoteItems: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of [...localItems, ...remoteItems]) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
