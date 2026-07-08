// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteStorage } from "./sqlite.js";
import { orgConfigValueSchema } from "../schema/orgConfig.js";

describe("SqliteStorage — org config (admin-managed org plane)", () => {
  let dir: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-orgcfg-"));
    storage = new SqliteStorage(path.join(dir, "orgcfg.db"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("getOrgConfig returns null when unset", async () => {
    assert.equal(await storage.getOrgConfig("org-1"), null);
  });

  test("setOrgConfig upserts and getOrgConfig round-trips", async () => {
    const saved = await storage.setOrgConfig("org-1", {
      serverUrl: "https://kodela.yourco.com",
      readMode: "merge",
      ciEnforcement: "enforcement",
      locked: ["readMode"],
    });
    assert.equal(saved.orgId, "org-1");
    assert.equal(saved.config.readMode, "merge");

    const got = await storage.getOrgConfig("org-1");
    assert.ok(got);
    assert.equal(got!.config.serverUrl, "https://kodela.yourco.com");
    assert.deepEqual(got!.config.locked, ["readMode"]);
    assert.ok(got!.updatedAt);
  });

  test("setOrgConfig replaces the whole bag (last write wins)", async () => {
    await storage.setOrgConfig("org-1", { readMode: "remote", retentionDays: 90 });
    await storage.setOrgConfig("org-1", { readMode: "local" });
    const got = await storage.getOrgConfig("org-1");
    assert.equal(got!.config.readMode, "local");
    assert.equal(got!.config.retentionDays, undefined, "old keys are not merged");
  });

  test("configs are isolated per org", async () => {
    await storage.setOrgConfig("org-a", { readMode: "remote" });
    await storage.setOrgConfig("org-b", { readMode: "local" });
    assert.equal((await storage.getOrgConfig("org-a"))!.config.readMode, "remote");
    assert.equal((await storage.getOrgConfig("org-b"))!.config.readMode, "local");
  });

  test("orgConfigValueSchema rejects unknown keys and bad enums", () => {
    assert.equal(orgConfigValueSchema.safeParse({ readMode: "merge" }).success, true);
    assert.equal(orgConfigValueSchema.safeParse({ readMode: "bogus" }).success, false);
    assert.equal(orgConfigValueSchema.safeParse({ serverUrl: "not-a-url" }).success, false);
    assert.equal(orgConfigValueSchema.safeParse({ unknownKey: 1 }).success, false);
  });
});
