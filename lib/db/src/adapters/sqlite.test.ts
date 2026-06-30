// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { SqliteStorage } from "./sqlite.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kodela-sqlite-test-"));
}

function makeStorage(dir: string): SqliteStorage {
  return new SqliteStorage(path.join(dir, "test.db"));
}

const ORG = "org-test-001";
const ORG2 = "org-test-002";

// ---------------------------------------------------------------------------
// Gitignore auto-creation
// ---------------------------------------------------------------------------

describe("SqliteStorage — .gitignore management", () => {
  test("creates .gitignore with server.db entry in a fresh directory", async () => {
    const dir = await makeTempDir();
    try {
      makeStorage(dir);
      const content = readFileSync(path.join(dir, ".gitignore"), "utf8");
      assert.ok(content.includes("server.db"), ".gitignore should contain 'server.db'");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("appends server.db to an existing .gitignore that does not include it", async () => {
    const dir = await makeTempDir();
    try {
      await fs.writeFile(path.join(dir, ".gitignore"), "*.log\n");
      makeStorage(dir);
      const content = readFileSync(path.join(dir, ".gitignore"), "utf8");
      assert.ok(content.includes("*.log"), "existing entry should be preserved");
      assert.ok(content.includes("server.db"), "server.db should be appended");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("does not duplicate server.db when it is already in .gitignore", async () => {
    const dir = await makeTempDir();
    try {
      await fs.writeFile(path.join(dir, ".gitignore"), "server.db\n");
      makeStorage(dir);
      const content = readFileSync(path.join(dir, ".gitignore"), "utf8");
      const count = (content.match(/server\.db/g) ?? []).length;
      assert.equal(count, 1, "server.db should appear exactly once");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Org domain
// ---------------------------------------------------------------------------

describe("SqliteStorage — org", () => {
  let storage: SqliteStorage;
  let dir: string;

  before(async () => {
    dir = await makeTempDir();
    storage = makeStorage(dir);
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("upsertOrg creates a new org without error", async () => {
    await assert.doesNotReject(() => storage.upsertOrg(ORG));
  });

  test("upsertOrg is idempotent — calling twice does not throw", async () => {
    await storage.upsertOrg(ORG);
    await assert.doesNotReject(() => storage.upsertOrg(ORG));
  });
});

// ---------------------------------------------------------------------------
// Audit events domain
// ---------------------------------------------------------------------------

describe("SqliteStorage — audit events", () => {
  let storage: SqliteStorage;
  let dir: string;

  before(async () => {
    dir = await makeTempDir();
    storage = makeStorage(dir);
    await storage.upsertOrg(ORG);
    await storage.upsertOrg(ORG2);
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("insertAuditEvent stores a basic event", async () => {
    await storage.insertAuditEvent({
      orgId: ORG,
      eventType: "context_added",
      actor: "alice",
    });

    const results = await storage.queryAuditEvents(ORG, { page: 1, pageSize: 50 });
    assert.ok(results.length >= 1, "should have at least one event");
    const ev = results.find((e) => e.actor === "alice" && e.eventType === "context_added");
    assert.ok(ev, "inserted event should be retrievable");
    assert.equal(ev!.filePath, null);
    assert.equal(ev!.entryId, null);
    assert.equal(ev!.metadata, null);
    assert.ok(ev!.createdAt instanceof Date, "createdAt should be a Date");
  });

  test("insertAuditEvent stores optional fields and JSON metadata", async () => {
    await storage.insertAuditEvent({
      orgId: ORG,
      eventType: "context_updated",
      actor: "bob",
      filePath: "src/foo.ts",
      entryId: "entry-abc",
      metadata: { reason: "heal", confidence: 0.9 },
    });

    const results = await storage.queryAuditEvents(ORG, { page: 1, pageSize: 50 });
    const ev = results.find((e) => e.actor === "bob");
    assert.ok(ev, "event should be found");
    assert.equal(ev!.filePath, "src/foo.ts");
    assert.equal(ev!.entryId, "entry-abc");
    assert.deepEqual(ev!.metadata, { reason: "heal", confidence: 0.9 });
  });

  test("queryAuditEvents filters by actor", async () => {
    await storage.insertAuditEvent({ orgId: ORG, eventType: "context_archived", actor: "carol" });

    const results = await storage.queryAuditEvents(ORG, { actor: "carol", page: 1, pageSize: 50 });
    assert.ok(results.every((e) => e.actor === "carol"), "all results should be from carol");
    assert.ok(results.length >= 1);
  });

  test("queryAuditEvents filters by filePath", async () => {
    await storage.insertAuditEvent({
      orgId: ORG,
      eventType: "context_added",
      actor: "dave",
      filePath: "lib/special.ts",
    });

    const results = await storage.queryAuditEvents(ORG, { filePath: "lib/special.ts", page: 1, pageSize: 50 });
    assert.ok(results.length >= 1);
    assert.ok(results.every((e) => e.filePath === "lib/special.ts"));
  });

  test("queryAuditEvents filters by eventType", async () => {
    await storage.insertAuditEvent({ orgId: ORG, eventType: "exception_approved", actor: "eve" });

    const results = await storage.queryAuditEvents(ORG, {
      eventType: "exception_approved",
      page: 1,
      pageSize: 50,
    });
    assert.ok(results.length >= 1);
    assert.ok(results.every((e) => e.eventType === "exception_approved"));
  });

  test("queryAuditEvents respects from/to date filters", async () => {
    const past = new Date(Date.now() - 10_000);
    const future = new Date(Date.now() + 10_000);

    await storage.insertAuditEvent({ orgId: ORG, eventType: "context_added", actor: "filter-test" });

    const inRange = await storage.queryAuditEvents(ORG, { from: past, to: future, page: 1, pageSize: 50 });
    assert.ok(inRange.some((e) => e.actor === "filter-test"), "event should be in range");

    const beforeAll = await storage.queryAuditEvents(ORG, { to: past, page: 1, pageSize: 50 });
    assert.ok(!beforeAll.some((e) => e.actor === "filter-test"), "event should be excluded by 'to' filter");
  });

  test("queryAuditEvents respects pageSize and page offset", async () => {
    for (let i = 0; i < 5; i++) {
      await storage.insertAuditEvent({ orgId: ORG, eventType: "context_added", actor: `pager-${i}` });
    }

    const page1 = await storage.queryAuditEvents(ORG, { page: 1, pageSize: 2 });
    const page2 = await storage.queryAuditEvents(ORG, { page: 2, pageSize: 2 });
    assert.equal(page1.length, 2);
    assert.equal(page2.length, 2);
    assert.notEqual(page1[0]!.id, page2[0]!.id, "pages should not overlap");
  });

  test("queryAuditEvents does not return events for a different org", async () => {
    await storage.insertAuditEvent({ orgId: ORG2, eventType: "context_added", actor: "other-org-user" });

    const results = await storage.queryAuditEvents(ORG, { actor: "other-org-user", page: 1, pageSize: 50 });
    assert.equal(results.length, 0, "events from other org should not be visible");
  });

  test("exportAuditEvents returns all events without pagination cap", async () => {
    const all = await storage.exportAuditEvents(ORG, {});
    assert.ok(all.length >= 5, "export should return all events without page limit");
  });

  test("exportAuditEvents filters are applied correctly", async () => {
    const filtered = await storage.exportAuditEvents(ORG, { actor: "carol" });
    assert.ok(filtered.every((e) => e.actor === "carol"));
  });
});

// ---------------------------------------------------------------------------
// Policy domain
// ---------------------------------------------------------------------------

describe("SqliteStorage — policy", () => {
  let storage: SqliteStorage;
  let dir: string;

  before(async () => {
    dir = await makeTempDir();
    storage = makeStorage(dir);
    await storage.upsertOrg(ORG);
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("getOrCreateActivePolicy creates a default policy when none exists", async () => {
    const policy = await storage.getOrCreateActivePolicy(ORG);
    assert.equal(typeof policy.id, "string");
    assert.equal(policy.orgId, ORG);
    assert.equal(policy.name, "default");
    assert.equal(policy.isActive, true);
    assert.ok(policy.createdAt instanceof Date);
  });

  test("getOrCreateActivePolicy is idempotent — returns the same policy on repeat calls", async () => {
    const first = await storage.getOrCreateActivePolicy(ORG);
    const second = await storage.getOrCreateActivePolicy(ORG);
    assert.equal(first.id, second.id, "should return the same policy ID");
  });

  test("getOrCreateActivePolicy implicitly upserts the org (no prior upsertOrg needed)", async () => {
    const freshOrg = "org-auto-created";
    const policy = await storage.getOrCreateActivePolicy(freshOrg);
    assert.equal(policy.orgId, freshOrg);
  });

  test("getPolicyRules returns empty array for a new policy", async () => {
    const policy = await storage.getOrCreateActivePolicy(ORG);
    const rules = await storage.getPolicyRules(policy.id);
    assert.deepEqual(rules, []);
  });

  test("insertPolicyRule stores a rule and returns the created row", async () => {
    const policy = await storage.getOrCreateActivePolicy(ORG);
    const rule = await storage.insertPolicyRule({
      policyId: policy.id,
      pathGlob: "src/**",
      requireContext: true,
      minConfidence: 0.85,
      minSeverity: "high",
    });

    assert.equal(typeof rule.id, "string");
    assert.equal(rule.policyId, policy.id);
    assert.equal(rule.pathGlob, "src/**");
    assert.equal(rule.requireContext, true);
    assert.equal(rule.minConfidence, 0.85);
    assert.equal(rule.minSeverity, "high");
    assert.equal(rule.allowedAiTools, null);
  });

  test("insertPolicyRule serialises allowedAiTools as a JSON array", async () => {
    const policy = await storage.getOrCreateActivePolicy(ORG);
    const rule = await storage.insertPolicyRule({
      policyId: policy.id,
      pathGlob: "auth/**",
      requireContext: false,
      allowedAiTools: ["copilot", "cursor"],
    });

    assert.deepEqual(rule.allowedAiTools, ["copilot", "cursor"]);
  });

  test("getPolicyRules returns all inserted rules for a policy", async () => {
    const policy = await storage.getOrCreateActivePolicy(ORG);
    const rules = await storage.getPolicyRules(policy.id);
    assert.ok(rules.length >= 2, "should have at least the two rules inserted above");
  });

  test("updatePolicyRule updates the rule and returns the updated row", async () => {
    const policy = await storage.getOrCreateActivePolicy(ORG);
    const rule = await storage.insertPolicyRule({
      policyId: policy.id,
      pathGlob: "lib/**",
      requireContext: false,
    });

    const updated = await storage.updatePolicyRule(rule.id, policy.id, {
      pathGlob: "lib/core/**",
      requireContext: true,
      minConfidence: 0.75,
      allowedAiTools: ["claude"],
      minSeverity: "medium",
    });

    assert.ok(updated !== null);
    assert.equal(updated!.pathGlob, "lib/core/**");
    assert.equal(updated!.requireContext, true);
    assert.equal(updated!.minConfidence, 0.75);
    assert.deepEqual(updated!.allowedAiTools, ["claude"]);
    assert.equal(updated!.minSeverity, "medium");
  });

  test("updatePolicyRule returns null when the rule does not exist", async () => {
    const policy = await storage.getOrCreateActivePolicy(ORG);
    const result = await storage.updatePolicyRule("non-existent-id", policy.id, {
      pathGlob: "x/**",
      requireContext: false,
    });
    assert.equal(result, null);
  });

  test("updatePolicyRule returns null when policyId does not match", async () => {
    const policy = await storage.getOrCreateActivePolicy(ORG);
    const rule = await storage.insertPolicyRule({
      policyId: policy.id,
      pathGlob: "mismatch/**",
      requireContext: false,
    });
    const result = await storage.updatePolicyRule(rule.id, "wrong-policy-id", {
      pathGlob: "mismatch/**",
      requireContext: false,
    });
    assert.equal(result, null);
  });

  test("deletePolicyRule removes the rule and returns true", async () => {
    const policy = await storage.getOrCreateActivePolicy(ORG);
    const rule = await storage.insertPolicyRule({
      policyId: policy.id,
      pathGlob: "delete-me/**",
      requireContext: false,
    });

    const deleted = await storage.deletePolicyRule(rule.id, policy.id);
    assert.equal(deleted, true);

    const rules = await storage.getPolicyRules(policy.id);
    assert.ok(!rules.some((r) => r.id === rule.id), "deleted rule should not appear");
  });

  test("deletePolicyRule returns false when the rule does not exist", async () => {
    const policy = await storage.getOrCreateActivePolicy(ORG);
    const result = await storage.deletePolicyRule("ghost-id", policy.id);
    assert.equal(result, false);
  });

  test("deletePolicyRule returns false when policyId does not match", async () => {
    const policy = await storage.getOrCreateActivePolicy(ORG);
    const rule = await storage.insertPolicyRule({
      policyId: policy.id,
      pathGlob: "nomatch/**",
      requireContext: false,
    });
    const result = await storage.deletePolicyRule(rule.id, "wrong-policy-id");
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// Repo links domain
// ---------------------------------------------------------------------------

describe("SqliteStorage — repo links", () => {
  let storage: SqliteStorage;
  let dir: string;

  before(async () => {
    dir = await makeTempDir();
    storage = makeStorage(dir);
    await storage.upsertOrg(ORG);
    await storage.upsertOrg(ORG2);
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("insertRepoLink creates a repo and returns the full row", async () => {
    const row = await storage.insertRepoLink({
      orgId: ORG,
      provider: "github",
      repoFullName: "acme/frontend",
      encryptedToken: "tok-encrypted",
    });

    assert.equal(typeof row.id, "string");
    assert.equal(row.orgId, ORG);
    assert.equal(row.provider, "github");
    assert.equal(row.repoFullName, "acme/frontend");
    assert.equal(row.encryptedToken, "tok-encrypted");
    assert.equal(row.installationId, null);
    assert.ok(row.createdAt instanceof Date);
    assert.ok(row.updatedAt instanceof Date);
  });

  test("insertRepoLink stores optional installationId", async () => {
    const row = await storage.insertRepoLink({
      orgId: ORG,
      provider: "gitlab",
      repoFullName: "acme/backend",
      encryptedToken: "tok2",
      installationId: "inst-123",
    });
    assert.equal(row.installationId, "inst-123");
    assert.equal(row.provider, "gitlab");
  });

  test("getRepoLinks returns all repos for the given org", async () => {
    await storage.insertRepoLink({
      orgId: ORG2,
      provider: "github",
      repoFullName: "other-org/repo",
      encryptedToken: "tok3",
    });

    const links = await storage.getRepoLinks(ORG);
    assert.ok(links.length >= 2, "should have the two repos inserted for ORG");
    assert.ok(links.every((r) => r.orgId === ORG), "only repos for ORG should be returned");
  });

  test("getRepoLinkById returns the correct row", async () => {
    const inserted = await storage.insertRepoLink({
      orgId: ORG,
      provider: "github",
      repoFullName: "acme/cli",
      encryptedToken: "tok4",
    });

    const found = await storage.getRepoLinkById(inserted.id);
    assert.ok(found !== null);
    assert.equal(found!.id, inserted.id);
    assert.equal(found!.repoFullName, "acme/cli");
  });

  test("getRepoLinkById returns null for an unknown id", async () => {
    const result = await storage.getRepoLinkById("does-not-exist");
    assert.equal(result, null);
  });

  test("getRepoLinkByFullName returns the correct row", async () => {
    await storage.insertRepoLink({
      orgId: ORG,
      provider: "github",
      repoFullName: "acme/special",
      encryptedToken: "tok5",
    });

    const found = await storage.getRepoLinkByFullName("acme/special");
    assert.ok(found !== null);
    assert.equal(found!.repoFullName, "acme/special");
  });

  test("getRepoLinkByFullName returns null for an unknown full name", async () => {
    const result = await storage.getRepoLinkByFullName("nobody/nothing");
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Snapshots domain
// ---------------------------------------------------------------------------

describe("SqliteStorage — snapshots", () => {
  let storage: SqliteStorage;
  let dir: string;
  let repoId: string;
  let repoId2: string;

  before(async () => {
    dir = await makeTempDir();
    storage = makeStorage(dir);
    await storage.upsertOrg(ORG);

    const repo1 = await storage.insertRepoLink({
      orgId: ORG,
      provider: "github",
      repoFullName: "snap/repo-a",
      encryptedToken: "t1",
    });
    repoId = repo1.id;

    const repo2 = await storage.insertRepoLink({
      orgId: ORG,
      provider: "github",
      repoFullName: "snap/repo-b",
      encryptedToken: "t2",
    });
    repoId2 = repo2.id;
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("getSnapshotsByRepoLink returns empty array when no snapshots exist", async () => {
    const results = await storage.getSnapshotsByRepoLink(repoId);
    assert.deepEqual(results, []);
  });

  test("getLatestSnapshotByRepoLinkId returns null when no snapshots exist", async () => {
    const result = await storage.getLatestSnapshotByRepoLinkId(repoId);
    assert.equal(result, null);
  });

  test("insertSnapshot stores a snapshot and getSnapshotsByRepoLink returns it", async () => {
    await storage.insertSnapshot({
      repoLinkId: repoId,
      totalEntries: 100,
      mappedEntries: 80,
      aiGeneratedPct: 60.5,
      unresolvedCriticalPct: 5.0,
      orphanedPct: 10.0,
      confidenceScore: 0.87,
    });

    const results = await storage.getSnapshotsByRepoLink(repoId);
    assert.equal(results.length, 1);

    const snap = results[0]!;
    assert.equal(snap.repoLinkId, repoId);
    assert.equal(snap.totalEntries, 100);
    assert.equal(snap.mappedEntries, 80);
    assert.equal(snap.aiGeneratedPct, 60.5);
    assert.equal(snap.unresolvedCriticalPct, 5.0);
    assert.equal(snap.orphanedPct, 10.0);
    assert.equal(snap.confidenceScore, 0.87);
    assert.ok(snap.capturedAt instanceof Date);
  });

  test("insertSnapshot respects explicit capturedAt", async () => {
    const fixedDate = new Date("2025-01-15T12:00:00.000Z");
    await storage.insertSnapshot({
      repoLinkId: repoId,
      capturedAt: fixedDate,
      totalEntries: 50,
      mappedEntries: 40,
      aiGeneratedPct: 30,
      unresolvedCriticalPct: 0,
      orphanedPct: 2,
      confidenceScore: 0.92,
    });

    const results = await storage.getSnapshotsByRepoLink(repoId);
    const snap = results.find((s) => s.totalEntries === 50);
    assert.ok(snap, "snapshot with totalEntries=50 should be found");
    assert.equal(snap!.capturedAt.toISOString(), fixedDate.toISOString());
  });

  test("getSnapshotsByRepoLink returns snapshots in ascending capturedAt order", async () => {
    const older = new Date("2025-03-01T00:00:00.000Z");
    const newer = new Date("2025-06-01T00:00:00.000Z");

    await storage.insertSnapshot({
      repoLinkId: repoId2,
      capturedAt: newer,
      totalEntries: 200,
      mappedEntries: 180,
      aiGeneratedPct: 55,
      unresolvedCriticalPct: 3,
      orphanedPct: 5,
      confidenceScore: 0.9,
    });
    await storage.insertSnapshot({
      repoLinkId: repoId2,
      capturedAt: older,
      totalEntries: 150,
      mappedEntries: 120,
      aiGeneratedPct: 40,
      unresolvedCriticalPct: 8,
      orphanedPct: 12,
      confidenceScore: 0.8,
    });

    const results = await storage.getSnapshotsByRepoLink(repoId2);
    assert.equal(results.length, 2);
    assert.ok(
      results[0]!.capturedAt <= results[1]!.capturedAt,
      "snapshots should be in ascending order",
    );
  });

  test("getLatestSnapshotByRepoLinkId returns the most recently captured snapshot", async () => {
    const latest = await storage.getLatestSnapshotByRepoLinkId(repoId2);
    assert.ok(latest !== null);
    assert.equal(latest!.totalEntries, 200, "should return the snapshot with newer capturedAt");
  });

  test("getSnapshotsByRepoIds returns snapshots from all provided repo IDs", async () => {
    const results = await storage.getSnapshotsByRepoIds([repoId, repoId2]);
    const ids = new Set(results.map((s) => s.repoLinkId));
    assert.ok(ids.has(repoId), "should include snapshots for repoId");
    assert.ok(ids.has(repoId2), "should include snapshots for repoId2");
  });

  test("getSnapshotsByRepoIds with empty array returns empty result immediately", async () => {
    const results = await storage.getSnapshotsByRepoIds([]);
    assert.deepEqual(results, []);
  });

  test("getSnapshotsByRepoIds ignores unknown repo IDs gracefully", async () => {
    const results = await storage.getSnapshotsByRepoIds(["no-such-repo"]);
    assert.deepEqual(results, []);
  });
});
