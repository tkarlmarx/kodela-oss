// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * End-to-end webhook storage tests against the real SQLite adapter
 * (internal design note). Verifies create/list/delete and event serialisation.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { SqliteStorage } from "./sqlite.js";

const ORG = "org-webhooks-001";

describe("SqliteStorage — webhooks", () => {
  let dir: string;
  let storage: SqliteStorage;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-webhooks-"));
    storage = new SqliteStorage(path.join(dir, "webhooks.db"));
  });
  after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test("create returns a row with parsed events array", async () => {
    const row = await storage.createWebhook({
      orgId: ORG,
      url: "https://hooks.example.com/kodela",
      events: ["context.captured", "session.complete"],
    });
    assert.equal(row.url, "https://hooks.example.com/kodela");
    assert.deepEqual(row.events, ["context.captured", "session.complete"]);
    assert.equal(row.active, true);
    assert.ok(row.createdAt instanceof Date);
  });

  test("list returns previously created webhooks", async () => {
    const list = await storage.listWebhooks(ORG);
    assert.ok(list.length >= 1);
    assert.ok(list.every((w) => w.orgId === ORG));
  });

  test("delete removes the webhook", async () => {
    const row = await storage.createWebhook({
      orgId: ORG,
      url: "https://delete-me.example.com",
      events: ["pr.blocked"],
    });
    const deleted = await storage.deleteWebhook(ORG, row.id);
    assert.equal(deleted, true);

    const list = await storage.listWebhooks(ORG);
    assert.ok(!list.some((w) => w.id === row.id));
  });

  test("delete non-existent webhook returns false", async () => {
    const result = await storage.deleteWebhook(ORG, "00000000-0000-0000-0000-000000000000");
    assert.equal(result, false);
  });

  test("webhooks are scoped per org", async () => {
    await storage.createWebhook({
      orgId: "org-webhooks-002",
      url: "https://other.example.com",
      events: ["member.invited"],
    });
    const a = await storage.listWebhooks(ORG);
    const b = await storage.listWebhooks("org-webhooks-002");
    assert.ok(a.every((w) => w.url !== "https://other.example.com"));
    assert.equal(b.length, 1);
  });
});
