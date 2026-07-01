// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 0 — `kodela search` end-to-end reranking. Seeds a temp repo with
 * annotations where the naive keyword order buries the best answer, then
 * confirms `runSearch` (reranker on by default) surfaces it at the top and
 * exposes the rerank score + signal breakdown; `rerank:false` shows raw order.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { writeContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { runSearch } from "./search.js";

function entry(over: Partial<ContextEntry>): ContextEntry {
  return {
    schemaVersion: "1.1.0",
    id: "00000000-0000-0000-0000-000000000000",
    filePath: "src/x.ts",
    astAnchor: null,
    contentHash: "hash",
    lineRange: { start: 1, end: 5 },
    note: "note",
    author: "ai",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    severity: "low",
    tags: [],
    source: "ai",
    confidence: 0.9,
    status: "mapped",
    reviewRequired: false,
    ...over,
  };
}

// Distractor: query terms sit in the body, off-topic. Answer: terms concentrated
// with an exact phrase + higher severity + high-signal fields.
const DISTRACTOR = entry({
  id: "11111111-1111-1111-1111-111111111111",
  filePath: "src/jobs/queue.ts",
  note: "we rate the job limit and login attempts against the worker queue",
  tags: ["queue"],
});
const ANSWER = entry({
  id: "22222222-2222-2222-2222-222222222222",
  filePath: "src/auth/login.ts",
  note: "throttle brute force with a rate limit on the login endpoint to stop credential stuffing",
  tags: ["auth", "security"],
  severity: "high",
  author: "human",
  source: "human",
});

describe("kodela search — reranking (Phase 0)", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-search-rerank-"));
    await writeContextEntry(tmp, DISTRACTOR);
    await writeContextEntry(tmp, ANSWER);
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("reranker (default) surfaces the real answer above the body-match distractor", async () => {
    const res = await runSearch({ repoRoot: tmp, query: "rate limit login", limit: 10 });
    assert.equal(res.reranked, true);
    assert.equal(res.hits.length, 2);
    assert.equal(res.hits[0]?.entry.id, ANSWER.id, "the login rate-limit answer ranks #1");
    assert.ok(res.hits[0]?.rerankScore !== undefined, "rerank score is exposed");
    assert.ok(res.hits[0]!.signals!.exact > 0, "the exact phrase 'rate limit' is detected");
    assert.ok(res.hits[0]!.rerankScore! >= res.hits[1]!.rerankScore!, "hits ordered by rerank score");
  });

  test("--no-rerank (rerank:false) leaves the raw keyword order untouched", async () => {
    const res = await runSearch({ repoRoot: tmp, query: "rate limit login", limit: 10, rerank: false });
    assert.ok(!res.reranked, "reranked is falsy when off");
    assert.ok(res.hits.every((h) => h.rerankScore === undefined), "no rerank annotations when off");
  });
});
