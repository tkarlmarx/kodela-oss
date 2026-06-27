// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * End-to-end repo-permission storage tests against the real SQLite adapter
 * (doc 26 Phase 3 remainder). Verifies upsert/list/delete/effective-access.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { SqliteStorage } from "./sqlite.js";

const ORG = "org-repoperm-001";
const REPO = "repo-abc";

describe("SqliteStorage — repo permissions", () => {
  let dir: string;
  let storage: SqliteStorage;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-repoperm-"));
    storage = new SqliteStorage(path.join(dir, "repoperm.db"));
  });
  after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test("setRepoPermission creates a grant row", async () => {
    const row = await storage.setRepoPermission({ orgId: ORG, repoId: REPO, principalId: "user-1", access: "read" });
    assert.equal(row.orgId, ORG);
    assert.equal(row.repoId, REPO);
    assert.equal(row.principalId, "user-1");
    assert.equal(row.access, "read");
    assert.ok(row.id);
    assert.ok(row.createdAt instanceof Date);
  });

  test("listRepoPermissions returns all grants for a repo", async () => {
    await storage.setRepoPermission({ orgId: ORG, repoId: REPO, principalId: "user-2", access: "write" });
    const list = await storage.listRepoPermissions(ORG, REPO);
    assert.ok(list.length >= 2);
    assert.ok(list.every((p) => p.repoId === REPO));
  });

  test("setRepoPermission upserts — second call updates access", async () => {
    await storage.setRepoPermission({ orgId: ORG, repoId: REPO, principalId: "user-1", access: "none" });
    const list = await storage.listRepoPermissions(ORG, REPO);
    const u1 = list.find((p) => p.principalId === "user-1");
    assert.ok(u1, "user-1 grant must exist");
    assert.equal(u1.access, "none");
    assert.equal(list.filter((p) => p.principalId === "user-1").length, 1);
  });

  test("deleteRepoPermission removes the grant and returns true", async () => {
    await storage.setRepoPermission({ orgId: ORG, repoId: REPO, principalId: "user-delete", access: "read" });
    const deleted = await storage.deleteRepoPermission(ORG, REPO, "user-delete");
    assert.equal(deleted, true);
    const list = await storage.listRepoPermissions(ORG, REPO);
    assert.ok(!list.some((p) => p.principalId === "user-delete"));
  });

  test("deleteRepoPermission returns false for non-existent grant", async () => {
    const result = await storage.deleteRepoPermission(ORG, REPO, "no-such-user");
    assert.equal(result, false);
  });

  test("getEffectiveAccess: user-specific grant wins over wildcard", async () => {
    const repo2 = "repo-effective";
    await storage.setRepoPermission({ orgId: ORG, repoId: repo2, principalId: "*", access: "read" });
    await storage.setRepoPermission({ orgId: ORG, repoId: repo2, principalId: "user-x", access: "write" });
    const acc = await storage.getEffectiveAccess(ORG, repo2, "user-x");
    assert.equal(acc, "write");
  });

  test("getEffectiveAccess: falls back to wildcard when no user-specific grant", async () => {
    const repo3 = "repo-wildcard";
    await storage.setRepoPermission({ orgId: ORG, repoId: repo3, principalId: "*", access: "none" });
    const acc = await storage.getEffectiveAccess(ORG, repo3, "user-no-grant");
    assert.equal(acc, "none");
  });

  test("getEffectiveAccess: defaults to write when no grants exist", async () => {
    const acc = await storage.getEffectiveAccess(ORG, "repo-no-grants", "user-y");
    assert.equal(acc, "write");
  });

  test("permissions are scoped per org", async () => {
    const otherOrg = "org-repoperm-002";
    await storage.setRepoPermission({ orgId: otherOrg, repoId: REPO, principalId: "user-other", access: "read" });
    const listOrg1 = await storage.listRepoPermissions(ORG, REPO);
    assert.ok(!listOrg1.some((p) => p.principalId === "user-other"), "other org's grant must not appear");
  });
});
