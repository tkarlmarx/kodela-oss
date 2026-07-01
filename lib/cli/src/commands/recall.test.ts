// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 1 — `kodela recall` end-to-end. Seeds a temp repo with annotations and
 * confirms recall (a) returns a ranked, injectable block for an explicit query,
 * (b) auto-derives the query from the latest session goal when none is given,
 * and (c) degrades gracefully (an explicit "nothing to recall" note) when there
 * is neither a query nor a session goal.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { writeContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { runRecall } from "./recall.js";

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

const AUTH = entry({
  id: "22222222-2222-2222-2222-222222222222",
  filePath: "src/auth/login.ts",
  lineRange: { start: 10, end: 20 },
  note: "throttle brute force with a rate limit on the login endpoint to stop credential stuffing",
  tags: ["auth", "security"],
  severity: "high",
  author: "human",
  source: "human",
});
const QUEUE = entry({
  id: "11111111-1111-1111-1111-111111111111",
  filePath: "src/jobs/queue.ts",
  note: "the worker queue drains jobs oldest-first to keep latency bounded",
  tags: ["queue"],
});

describe("kodela recall (Phase 1)", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-recall-"));
    await writeContextEntry(tmp, AUTH);
    await writeContextEntry(tmp, QUEUE);
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("explicit query returns a ranked, injectable block referencing the best hit", async () => {
    const res = await runRecall({ repoRoot: tmp, query: "rate limit login", semantic: false });
    assert.equal(res.autoQuery, false);
    assert.equal(res.query, "rate limit login");
    assert.ok(res.items.length >= 1, "at least one item recalled");
    assert.equal(res.items[0]?.ref, "src/auth/login.ts:10-20", "the login answer is ranked first");
    assert.match(res.block, /## Relevant prior context for "rate limit login"/);
    assert.match(res.block, /src\/auth\/login\.ts:10-20/);
  });

  test("no query auto-recalls from the latest session goal", async () => {
    const sessionsDir = path.join(tmp, ".kodela", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "old.json"),
      JSON.stringify({ startedAt: "2026-04-01T00:00:00.000Z", goal: "refactor the worker queue" }),
    );
    // Terms all present in the answer note so the keyword branch (semantic:false
    // in this fixture) matches; in production recall defaults to semantic, which
    // handles free-form goals that don't keyword-overlap.
    await fs.writeFile(
      path.join(sessionsDir, "new.json"),
      JSON.stringify({ startedAt: "2026-06-01T00:00:00.000Z", goal: "login rate limit" }),
    );

    const res = await runRecall({ repoRoot: tmp, semantic: false });
    assert.equal(res.autoQuery, true, "query was auto-derived");
    assert.equal(res.query, "login rate limit", "uses the most recent session goal");
    assert.match(res.block, /for this task/);
    assert.equal(res.items[0]?.ref, "src/auth/login.ts:10-20");
  });

  test("no query and no session goal yields an explicit 'nothing to recall' note", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-recall-bare-"));
    try {
      const res = await runRecall({ repoRoot: bare, semantic: false });
      assert.equal(res.autoQuery, false);
      assert.equal(res.items.length, 0);
      assert.match(res.block, /Nothing to recall/);
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });
});
