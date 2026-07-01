// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela recall` (Phase 1 — automatic recall injection).
 *
 * "What do we already know about X?" — returns the most relevant prior *why* as
 * a ready-to-paste context block, ranked by the Phase-0 reranker. With no query
 * it auto-recalls for the *current task* by using the latest session's goal, so
 * an agent (or a hook) can inject relevant memory at the start of a session
 * without anyone typing the question.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { formatRecallBlock, type RecallItem } from "@kodela/core/retrieval";
import { runSearch } from "./search.js";

export interface RecallOptions {
  repoRoot: string;
  query?: string;
  limit?: number;
  /** Prefer semantic (embedding) retrieval; falls back to keyword. Default true. */
  semantic?: boolean;
}

export interface RecallResult {
  query: string;
  /** True when the query was auto-derived from the latest session goal. */
  autoQuery: boolean;
  items: RecallItem[];
  /** The injectable markdown block. */
  block: string;
}

/** Most recent session's goal, if any — the query for task-scoped recall. */
async function latestSessionGoal(repoRoot: string): Promise<string | undefined> {
  const dir = path.join(repoRoot, ".kodela", "sessions");
  const files = await fs.readdir(dir).catch(() => []);
  let best: { startedAt?: string; goal?: string } | undefined;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    if (f.includes(".mcp.") || f.endsWith(".summary.json") || f.includes(".actions.")) continue;
    try {
      const s = JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as { startedAt?: string; goal?: string };
      if (s.goal && s.goal.trim() && (!best || (s.startedAt ?? "") > (best.startedAt ?? ""))) best = s;
    } catch {
      /* skip malformed */
    }
  }
  return best?.goal?.trim();
}

export async function runRecall(opts: RecallOptions): Promise<RecallResult> {
  const limit = opts.limit ?? 8;
  let query = opts.query?.trim() ?? "";
  let autoQuery = false;
  if (!query) {
    const goal = await latestSessionGoal(opts.repoRoot);
    if (goal) {
      query = goal;
      autoQuery = true;
    }
  }

  if (!query) {
    return {
      query: "",
      autoQuery: false,
      items: [],
      block: "_Nothing to recall: pass a query (`kodela recall \"<topic>\"`) or start a session with a goal._",
    };
  }

  const result = await runSearch({
    repoRoot: opts.repoRoot,
    query,
    semantic: opts.semantic ?? true,
    rerank: true,
    limit,
  });

  const items: RecallItem[] = result.hits.map((h) => ({
    ref: `${h.entry.filePath}:${h.entry.lineRange.start}-${h.entry.lineRange.end}`,
    note: h.entry.note,
    score: h.rerankScore ?? h.similarityScore,
    tags: h.entry.tags,
  }));

  const heading = autoQuery
    ? `## Relevant prior context for this task\n_(recalled for the current session goal: "${query}")_`
    : `## Relevant prior context for "${query}"`;

  return {
    query,
    autoQuery,
    items,
    block: formatRecallBlock(query, items, { heading }),
  };
}
