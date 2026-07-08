// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fetchRemoteContext, mergeContexts, fetchRemoteRecall, mergeRecallItems, fetchRemoteWhy, mergeWhyItems } from "./remote.js";
import type { ProjectContext } from "./types.js";
import type { RecallItem } from "../retrieval/recall.js";
import type { WhyItem } from "../why/whyForFile.js";

/** Minimal ProjectContext factory for merge tests. */
function ctx(partial: Partial<ProjectContext>): ProjectContext {
  return {
    clusters: [],
    entries: [],
    sessions: [],
    meta: {
      tokenUsage: 0,
      totalCandidates: 0,
      selectedClusters: 0,
      selectedEntries: 0,
    },
    ...partial,
  };
}

describe("fetchRemoteContext", () => {
  test("builds the GET /api/context/get request with auth + scope headers", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify(ctx({})), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchRemoteContext({
      serverUrl: "https://kodela.example.com/",
      apiKey: "key-123",
      orgId: "org-abc",
      repoId: "repo-xyz",
      filePath: "src/auth/session.ts",
      intent: "bugfix",
      tokenBudget: 8000,
      fetchImpl,
    });

    assert.ok(captured, "fetch was called");
    const u = new URL(captured!.url);
    // trailing slash on serverUrl must not double up
    assert.equal(u.origin + u.pathname, "https://kodela.example.com/api/context/get");
    assert.equal(u.searchParams.get("repoId"), "repo-xyz");
    assert.equal(u.searchParams.get("file"), "src/auth/session.ts");
    assert.equal(u.searchParams.get("intent"), "bugfix");
    assert.equal(u.searchParams.get("token_budget"), "8000");

    const headers = new Headers(captured!.init?.headers);
    assert.equal(headers.get("authorization"), "Bearer key-123");
    assert.equal(headers.get("x-kodela-org-id"), "org-abc");
  });

  test("omits optional query params when not provided", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(ctx({})), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchRemoteContext({
      serverUrl: "https://s.co",
      apiKey: "k",
      orgId: "o",
      repoId: "r",
      fetchImpl,
    });

    const u = new URL(capturedUrl);
    assert.equal(u.searchParams.get("repoId"), "r");
    assert.equal(u.searchParams.has("file"), false);
    assert.equal(u.searchParams.has("intent"), false);
    assert.equal(u.searchParams.has("token_budget"), false);
  });

  test("prefers repoFullName → ?repo= over raw repoId", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(ctx({})), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchRemoteContext({
      serverUrl: "https://s.co",
      apiKey: "k",
      orgId: "o",
      repoFullName: "acme/widgets",
      fetchImpl,
    });

    const u = new URL(capturedUrl);
    assert.equal(u.searchParams.get("repo"), "acme/widgets");
    assert.equal(u.searchParams.has("repoId"), false, "raw repoId not sent when full name is given");
  });

  test("throws when neither repoId nor repoFullName is provided", async () => {
    await assert.rejects(
      () =>
        fetchRemoteContext({
          serverUrl: "https://s.co",
          apiKey: "k",
          orgId: "o",
          fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
        }),
      /requires repoId or repoFullName/,
    );
  });

  test("throws with status + body on a non-2xx response", async () => {
    const fetchImpl = (async () =>
      new Response("repoId is required.", { status: 400 })) as unknown as typeof fetch;

    await assert.rejects(
      () =>
        fetchRemoteContext({
          serverUrl: "https://s.co",
          apiKey: "k",
          orgId: "o",
          repoId: "r",
          fetchImpl,
        }),
      /HTTP 400.*repoId is required/,
    );
  });
});

describe("mergeContexts (readMode: merge)", () => {
  test("unions entries and dedupes by id with local winning ties", () => {
    const local = ctx({
      entries: [
        { id: "e1", filePath: "a.ts", confidence: 0.9, clusterId: null, sessionId: null, scope: null, createdAt: "2026-01-01" },
        { id: "e2", filePath: "b.ts", confidence: 0.8, clusterId: null, sessionId: null, scope: null, createdAt: "2026-01-02" },
      ],
      meta: { tokenUsage: 100, totalCandidates: 2, selectedClusters: 0, selectedEntries: 2 },
    });
    const remote = ctx({
      entries: [
        // duplicate id — local must win (confidence 0.9 kept, not 0.1)
        { id: "e1", filePath: "a.ts", confidence: 0.1, clusterId: null, sessionId: null, scope: null, createdAt: "2026-01-01" },
        { id: "e3", filePath: "c.ts", confidence: 0.7, clusterId: null, sessionId: null, scope: null, createdAt: "2026-01-03" },
      ],
      meta: { tokenUsage: 50, totalCandidates: 2, selectedClusters: 0, selectedEntries: 2 },
    });

    const merged = mergeContexts(local, remote);

    assert.deepEqual(
      merged.entries.map((e) => e.id),
      ["e1", "e2", "e3"],
      "deduped union, local order first",
    );
    assert.equal(merged.entries.find((e) => e.id === "e1")?.confidence, 0.9, "local won the tie");
    assert.equal(merged.meta.selectedEntries, 3);
    assert.equal(merged.meta.tokenUsage, 150, "token usage summed as upper bound");
    assert.equal(merged.meta.totalCandidates, 4);
  });

  test("concatenates warnings from both sides", () => {
    const local = ctx({ warnings: ["local warn"] });
    const remote = ctx({ warnings: ["remote warn"] });
    const merged = mergeContexts(local, remote);
    assert.deepEqual(merged.warnings, ["local warn", "remote warn"]);
  });

  test("omits warnings when neither side has any", () => {
    const merged = mergeContexts(ctx({}), ctx({}));
    assert.equal(merged.warnings, undefined);
  });
});

describe("fetchRemoteRecall", () => {
  test("builds GET /api/context/recall with repo + q + auth headers", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ items: [], block: "none" }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchRemoteRecall({
      serverUrl: "https://s.co/",
      apiKey: "k",
      orgId: "o",
      repoFullName: "acme/widgets",
      query: "token rotation",
      limit: 5,
      fetchImpl,
    });

    const u = new URL(captured!.url);
    assert.equal(u.origin + u.pathname, "https://s.co/api/context/recall");
    assert.equal(u.searchParams.get("repo"), "acme/widgets");
    assert.equal(u.searchParams.get("q"), "token rotation");
    assert.equal(u.searchParams.get("limit"), "5");
    const headers = new Headers(captured!.init?.headers);
    assert.equal(headers.get("x-kodela-org-id"), "o");
  });

  test("throws when neither repoId nor repoFullName given", async () => {
    await assert.rejects(
      () =>
        fetchRemoteRecall({
          serverUrl: "https://s.co", apiKey: "k", orgId: "o", query: "x",
          fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
        }),
      /requires repoId or repoFullName/,
    );
  });
});

describe("fetchRemoteWhy + mergeWhyItems", () => {
  test("builds GET /api/context/why with repo + file", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchRemoteWhy({
      serverUrl: "https://s.co", apiKey: "k", orgId: "o",
      repoFullName: "acme/widgets", filePath: "src/a.ts", maxDepth: 4, fetchImpl,
    });
    const u = new URL(capturedUrl);
    assert.equal(u.origin + u.pathname, "https://s.co/api/context/why");
    assert.equal(u.searchParams.get("repo"), "acme/widgets");
    assert.equal(u.searchParams.get("file"), "src/a.ts");
    assert.equal(u.searchParams.get("max_depth"), "4");
  });

  test("mergeWhyItems dedupes by decisionId keeping higher confidence", () => {
    const local: WhyItem[] = [{ decisionId: "d1", title: "A", reasonExcerpt: "", confidence: 0.9 }];
    const remote: WhyItem[] = [
      { decisionId: "d1", title: "A", reasonExcerpt: "", confidence: 0.2 },
      { decisionId: "d2", title: "B", reasonExcerpt: "", confidence: 0.7 },
    ];
    const merged = mergeWhyItems(local, remote);
    assert.deepEqual(merged.map((i) => i.decisionId), ["d1", "d2"]);
    assert.equal(merged[0]!.confidence, 0.9, "kept the higher-confidence d1");
  });
});

describe("mergeRecallItems (readMode: merge)", () => {
  const item = (ref: string, score: number): RecallItem => ({ ref, note: `n:${ref}`, score, tags: [] });

  test("dedupes by ref (local wins), re-sorts by score, caps at limit", () => {
    const local = [item("a.ts:1-2", 0.9), item("b.ts:1-2", 0.4)];
    const remote = [item("a.ts:1-2", 0.1), item("c.ts:1-2", 0.7)];
    const merged = mergeRecallItems("q", local, remote, 2);
    assert.deepEqual(merged.items.map((i) => i.ref), ["a.ts:1-2", "c.ts:1-2"], "top-2 by score, local a kept");
    assert.equal(merged.items.find((i) => i.ref === "a.ts:1-2")?.score, 0.9, "local won the tie");
    assert.match(merged.block, /token rotation|Relevant prior context|a\.ts/);
  });
});
