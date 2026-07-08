// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteStorage } from "./sqlite.js";

describe("SqliteStorage — ensureRepoLink / getRepoLinkByOrgAndFullName", () => {
  let dir: string;
  let storage: SqliteStorage;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-repolink-"));
    storage = new SqliteStorage(path.join(dir, "rl.db"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("getRepoLinkByOrgAndFullName returns null when absent", async () => {
    assert.equal(
      await storage.getRepoLinkByOrgAndFullName("org-1", "acme/widgets"),
      null,
    );
  });

  test("ensureRepoLink creates once then returns the same row (idempotent)", async () => {
    const a = await storage.ensureRepoLink({
      orgId: "org-1",
      provider: "github",
      repoFullName: "acme/widgets",
      encryptedToken: "",
    });
    assert.ok(a.id);
    assert.equal(a.repoFullName, "acme/widgets");

    const b = await storage.ensureRepoLink({
      orgId: "org-1",
      provider: "github",
      repoFullName: "acme/widgets",
      encryptedToken: "",
    });
    assert.equal(b.id, a.id, "second call returns the existing row, no duplicate");

    const found = await storage.getRepoLinkByOrgAndFullName("org-1", "acme/widgets");
    assert.equal(found?.id, a.id);
  });

  test("scopes by org — same full name in two orgs yields distinct links", async () => {
    const one = await storage.ensureRepoLink({
      orgId: "org-1",
      provider: "github",
      repoFullName: "acme/widgets",
      encryptedToken: "",
    });
    const two = await storage.ensureRepoLink({
      orgId: "org-2",
      provider: "github",
      repoFullName: "acme/widgets",
      encryptedToken: "",
    });
    assert.notEqual(one.id, two.id, "each org gets its own repo link");
    assert.equal(
      (await storage.getRepoLinkByOrgAndFullName("org-1", "acme/widgets"))?.id,
      one.id,
    );
    assert.equal(
      (await storage.getRepoLinkByOrgAndFullName("org-2", "acme/widgets"))?.id,
      two.id,
    );
  });
});
