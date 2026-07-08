// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  mergeOrgConfig,
  runConfigPull,
  ConfigPullError,
  type OrgConfigValue,
} from "./config-pull.js";

describe("mergeOrgConfig (org → repo inheritance)", () => {
  test("fills fields the repo has not set", () => {
    const { config, changes } = mergeOrgConfig({}, { serverUrl: "https://s.co", storageMode: "central" });
    assert.equal((config.storage as any).server.url, "https://s.co");
    assert.equal((config.storage as any).server.api_key_env, "KODELA_API_KEY");
    assert.equal((config.storage as any).mode, "central");
    assert.ok(changes.every((c) => c.outcome === "applied"));
  });

  test("keeps the repo value for a non-locked key the repo already set", () => {
    const repo = { storage: { mode: "local" } };
    const { config, changes } = mergeOrgConfig(repo, { storageMode: "central" });
    assert.equal((config.storage as any).mode, "local", "repo override kept");
    assert.equal(changes.find((c) => c.key === "storageMode")?.outcome, "kept-repo-value");
  });

  test("a locked key overrides the repo value", () => {
    const repo = { storage: { readMode: "local" } };
    const org: OrgConfigValue = { readMode: "merge", locked: ["readMode"] };
    const { config, changes } = mergeOrgConfig(repo, org);
    assert.equal((config.storage as any).readMode, "merge", "locked org value wins");
    assert.equal(changes.find((c) => c.key === "readMode")?.outcome, "locked-override");
  });

  test("maps ciEnforcement and records the full org policy", () => {
    const { config } = mergeOrgConfig({}, { ciEnforcement: "enforcement", retentionDays: 90 });
    assert.equal((config.ci as any).enforcement, "enforcement");
    assert.equal((config.orgPolicy as any).retentionDays, 90);
  });

  test("does not mutate the input", () => {
    const repo = { storage: { mode: "local" } };
    const snapshot = JSON.stringify(repo);
    mergeOrgConfig(repo, { storageMode: "central" });
    assert.equal(JSON.stringify(repo), snapshot);
  });
});

describe("runConfigPull", () => {
  let repoRoot: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-config-pull-"));
    originalFetch = globalThis.fetch;
    process.env.KODELA_API_KEY = "k";
    process.env.KODELA_ORG_ID = "org-1";
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.KODELA_API_KEY;
    delete process.env.KODELA_ORG_ID;
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  function stubFetch(body: unknown, status = 200) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }) as typeof globalThis.fetch;
    return calls;
  }

  test("fetches with auth + org header and writes the merged config", async () => {
    const calls = stubFetch({
      orgId: "org-1",
      config: { serverUrl: "https://s.co", readMode: "merge", locked: ["readMode"] },
      updatedAt: "2026-07-02T00:00:00Z",
    });

    const result = await runConfigPull({ repoRoot, serverUrl: "https://s.co" });

    assert.equal(calls[0]!.url, "https://s.co/api/admin/org-config");
    assert.equal(calls[0]!.headers["Authorization"], "Bearer k");
    assert.equal(calls[0]!.headers["X-Kodela-Org-Id"], "org-1");

    const written = JSON.parse(await fs.readFile(path.join(repoRoot, "kodela.config.json"), "utf8"));
    assert.equal(written.storage.readMode, "merge");
    assert.equal(written.storage.server.url, "https://s.co");
    assert.equal(result.changes.find((c) => c.key === "readMode")?.outcome, "locked-override");
  });

  test("dry-run does not write the file", async () => {
    stubFetch({ orgId: "org-1", config: { storageMode: "central" }, updatedAt: null });
    await runConfigPull({ repoRoot, serverUrl: "https://s.co", dryRun: true });
    await assert.rejects(() => fs.access(path.join(repoRoot, "kodela.config.json")));
  });

  test("throws a clear error when no server URL is resolvable", async () => {
    delete process.env.KODELA_API_KEY;
    await assert.rejects(
      () => runConfigPull({ repoRoot }),
      (e) => e instanceof ConfigPullError,
    );
  });
});
