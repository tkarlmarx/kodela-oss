// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  runMigrateToSaas,
  formatMigrateToSaasResult,
  MigrateToSaasError,
} from "./migrate-to-saas.js";
import { initBaseline, writeContextEntry, writeSession } from "@kodela/core";
import type { ContextEntry, KodelaSession } from "@kodela/core";

/** Build a minimal-but-valid ContextEntry. */
function makeEntry(overrides: Partial<ContextEntry> = {}): ContextEntry {
  return {
    id: randomUUID(),
    schemaVersion: "1.1.0",
    filePath: "src/test.ts",
    astAnchor: null,
    contentHash: "abc123",
    lineRange: { start: 1, end: 5 },
    note: "test entry",
    author: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    severity: "low",
    tags: [],
    source: "ai",
    confidence: 0.9,
    status: "mapped",
    reviewRequired: false,
    ...overrides,
  } as ContextEntry;
}

function makeSession(overrides: Partial<KodelaSession> = {}): KodelaSession {
  return {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    entries: [],
    aggregatedRisk: "low",
    filesChanged: [],
    ...overrides,
  } as KodelaSession;
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { repoId: string; entries: ContextEntry[]; sessions: KodelaSession[] };
}

interface FetchStub {
  calls: FetchCall[];
  responses: Array<{ status: number; body: unknown }>;
}

function installFetchStub(stub: FetchStub): typeof globalThis.fetch {
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    stub.calls.push({ url, method, headers, body });
    const response = stub.responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return original;
}

describe("runMigrateToSaas", () => {
  let repoRoot: string;
  let originalFetch: typeof globalThis.fetch;
  let fetchStub: FetchStub;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-migrate-saas-test-"));
    await initBaseline(repoRoot, { force: true });
    fetchStub = { calls: [], responses: [] };
    originalFetch = installFetchStub(fetchStub);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  test("dry-run reports counts without POSTing", async () => {
    const entry = makeEntry();
    await writeContextEntry(repoRoot, entry);

    const result = await runMigrateToSaas({
      repoRoot,
      serverUrl: "https://example.test",
      apiKey: "test-key",
      repoId: "repo-001",
      dryRun: true,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.entriesFound, 1);
    assert.equal(result.entriesUploaded, 0, "dry run must not POST");
    assert.equal(fetchStub.calls.length, 0, "dry run must not call fetch");
  });

  test("sends entries to the migration endpoint with auth headers", async () => {
    const entry = makeEntry();
    await writeContextEntry(repoRoot, entry);
    fetchStub.responses.push({
      status: 200,
      body: {
        repoId: "repo-001",
        orgId: "org-test",
        entriesAccepted: 1,
        signoffsAccepted: 0,
        commentsAccepted: 0,
        sessionsAccepted: 0,
        rejections: [],
      },
    });

    const result = await runMigrateToSaas({
      repoRoot,
      serverUrl: "https://example.test/",
      apiKey: "test-key",
      repoId: "repo-001",
    });

    assert.equal(fetchStub.calls.length, 1);
    const call = fetchStub.calls[0]!;
    assert.equal(call.url, "https://example.test/api/migrations/local-import");
    assert.equal(call.method, "POST");
    assert.equal(call.headers["Authorization"], "Bearer test-key");
    assert.equal(call.headers["Content-Type"], "application/json");
    assert.equal(call.body.repoId, "repo-001");
    assert.equal(call.body.entries.length, 1);
    assert.equal(call.body.entries[0]!.id, entry.id);
    assert.equal(result.entriesUploaded, 1);
  });

  test("sends sessions in the same batch as entries", async () => {
    const entry = makeEntry();
    const session = makeSession();
    await writeContextEntry(repoRoot, entry);
    await writeSession(repoRoot, session);
    fetchStub.responses.push({
      status: 200,
      body: {
        repoId: "repo-001",
        orgId: "org-test",
        entriesAccepted: 1,
        signoffsAccepted: 0,
        commentsAccepted: 0,
        sessionsAccepted: 1,
        rejections: [],
      },
    });

    const result = await runMigrateToSaas({
      repoRoot,
      serverUrl: "https://example.test",
      apiKey: "test-key",
      repoId: "repo-001",
    });

    assert.equal(fetchStub.calls.length, 1);
    const body = fetchStub.calls[0]!.body;
    assert.equal(body.entries.length, 1);
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0]!.id, session.id);
    assert.equal(result.entriesUploaded, 1);
    assert.equal(result.sessionsUploaded, 1);
  });

  test("batch size splits a large set across multiple requests", async () => {
    const entries = Array.from({ length: 5 }, () => makeEntry());
    for (const entry of entries) await writeContextEntry(repoRoot, entry);
    // Provide 3 responses (5 entries / batch of 2 = 3 batches).
    for (let i = 0; i < 3; i++) {
      fetchStub.responses.push({
        status: 200,
        body: {
          repoId: "repo-001",
          orgId: "org-test",
          entriesAccepted: i === 2 ? 1 : 2,
          sessionsAccepted: 0,
          signoffsAccepted: 0,
          commentsAccepted: 0,
          rejections: [],
        },
      });
    }

    const result = await runMigrateToSaas({
      repoRoot,
      serverUrl: "https://example.test",
      apiKey: "test-key",
      repoId: "repo-001",
      batchSize: 2,
    });

    assert.equal(fetchStub.calls.length, 3);
    assert.equal(result.entriesUploaded, 5);
  });

  test("propagates server-side rejections without throwing", async () => {
    const entry = makeEntry();
    await writeContextEntry(repoRoot, entry);
    fetchStub.responses.push({
      status: 200,
      body: {
        repoId: "repo-001",
        orgId: "org-test",
        entriesAccepted: 0,
        signoffsAccepted: 0,
        commentsAccepted: 0,
        sessionsAccepted: 0,
        rejections: [{ kind: "entry", id: entry.id, reason: "schema validation failed" }],
      },
    });

    const result = await runMigrateToSaas({
      repoRoot,
      serverUrl: "https://example.test",
      apiKey: "test-key",
      repoId: "repo-001",
    });

    assert.equal(result.entriesUploaded, 0);
    assert.equal(result.rejections.length, 1);
    assert.equal(result.rejections[0]!.id, entry.id);
  });

  test("captures HTTP errors per batch and continues", async () => {
    const e1 = makeEntry();
    const e2 = makeEntry();
    await writeContextEntry(repoRoot, e1);
    await writeContextEntry(repoRoot, e2);
    fetchStub.responses.push({ status: 503, body: { error: "Service down" } });
    fetchStub.responses.push({
      status: 200,
      body: {
        repoId: "repo-001",
        orgId: "org-test",
        entriesAccepted: 1,
        signoffsAccepted: 0,
        commentsAccepted: 0,
        sessionsAccepted: 0,
        rejections: [],
      },
    });

    const result = await runMigrateToSaas({
      repoRoot,
      serverUrl: "https://example.test",
      apiKey: "test-key",
      repoId: "repo-001",
      batchSize: 1,
    });

    assert.equal(fetchStub.calls.length, 2, "second batch must run after first fails");
    assert.equal(result.httpErrors.length, 1);
    assert.match(result.httpErrors[0]!, /HTTP 503/);
    assert.equal(result.entriesUploaded, 1, "successful batch still counted");
  });

  test("throws MigrateToSaasError when required options are missing", async () => {
    await assert.rejects(
      () =>
        runMigrateToSaas({
          repoRoot,
          serverUrl: "",
          apiKey: "k",
          repoId: "r",
        }),
      (err) => err instanceof MigrateToSaasError,
    );
  });
});

describe("formatMigrateToSaasResult", () => {
  test("renders success summary when there are no errors", () => {
    const txt = formatMigrateToSaasResult({
      entriesFound: 3,
      sessionsFound: 1,
      signoffsFound: 0,
      commentsFound: 0,
      entriesUploaded: 3,
      sessionsUploaded: 1,
      signoffsUploaded: 0,
      commentsUploaded: 0,
      rejections: [],
      httpErrors: [],
      dryRun: false,
    });
    assert.match(txt, /Migration complete/);
    assert.match(txt, /Overall: success/);
  });

  test("renders partial summary when there are rejections", () => {
    const txt = formatMigrateToSaasResult({
      entriesFound: 1,
      sessionsFound: 0,
      signoffsFound: 0,
      commentsFound: 0,
      entriesUploaded: 0,
      sessionsUploaded: 0,
      signoffsUploaded: 0,
      commentsUploaded: 0,
      rejections: [{ kind: "entry", id: "abc", reason: "bad schema" }],
      httpErrors: [],
      dryRun: false,
    });
    assert.match(txt, /1 record\(s\) rejected/);
    assert.match(txt, /Overall: partial/);
  });

  test("renders HTTP-failure summary when batches failed", () => {
    const txt = formatMigrateToSaasResult({
      entriesFound: 1,
      sessionsFound: 0,
      signoffsFound: 0,
      commentsFound: 0,
      entriesUploaded: 0,
      sessionsUploaded: 0,
      signoffsUploaded: 0,
      commentsUploaded: 0,
      rejections: [],
      httpErrors: ["HTTP 503: down"],
      dryRun: false,
    });
    assert.match(txt, /1 HTTP batch failure/);
    assert.match(txt, /failed batches present/);
  });

  test("renders dry-run summary without upload counts", () => {
    const txt = formatMigrateToSaasResult({
      entriesFound: 5,
      sessionsFound: 2,
      signoffsFound: 0,
      commentsFound: 0,
      entriesUploaded: 0,
      sessionsUploaded: 0,
      signoffsUploaded: 0,
      commentsUploaded: 0,
      rejections: [],
      httpErrors: [],
      dryRun: true,
    });
    assert.match(txt, /Dry-run/);
    assert.match(txt, /Entries on disk : 5/);
    assert.doesNotMatch(txt, /uploaded/);
  });
});
