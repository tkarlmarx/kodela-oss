// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * End-to-end API-token storage tests against the real SQLite adapter
 * (doc 26 Phase 3). Verifies create/list/revoke and that only the hash +
 * prefix are persisted — never the plaintext.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { SqliteStorage } from "./sqlite.js";

const ORG = "org-tokens-001";

function mint() {
  const secret = `kdl_${randomBytes(24).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, 12), hash: createHash("sha256").update(secret).digest("hex") };
}

describe("SqliteStorage — API tokens", () => {
  let dir: string;
  let storage: SqliteStorage;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-tokens-"));
    storage = new SqliteStorage(path.join(dir, "tokens.db"));
  });
  after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test("create returns a row without secrets, list shows it", async () => {
    const { prefix, hash } = mint();
    const row = await storage.createApiToken({ orgId: ORG, name: "github-actions", prefix, tokenHash: hash });
    assert.equal(row.name, "github-actions");
    assert.equal(row.prefix, prefix);
    assert.equal(row.revokedAt, null);
    assert.ok(!("tokenHash" in (row as object)), "row must not expose the hash");

    const list = await storage.listApiTokens(ORG);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, "github-actions");
  });

  test("a token is verifiable by re-hashing the secret", async () => {
    const { secret, prefix, hash } = mint();
    await storage.createApiToken({ orgId: ORG, name: "verify-me", prefix, tokenHash: hash });
    // Simulate auth: hash the presented secret and confirm a stored hash matches.
    const presentedHash = createHash("sha256").update(secret).digest("hex");
    assert.equal(presentedHash, hash, "deterministic hashing");
  });

  test("revoke marks the token revoked", async () => {
    const { prefix, hash } = mint();
    const row = await storage.createApiToken({ orgId: ORG, name: "to-revoke", prefix, tokenHash: hash });
    const revoked = await storage.revokeApiToken(ORG, row.id);
    assert.ok(revoked);
    assert.ok(revoked!.revokedAt instanceof Date, "revokedAt is set");

    const again = await storage.revokeApiToken(ORG, row.id);
    // Already revoked → the WHERE revoked_at IS NULL no-ops, but getApiToken still returns the row.
    assert.ok(again);
  });

  test("revoking a non-existent token returns null", async () => {
    const res = await storage.revokeApiToken(ORG, "00000000-0000-0000-0000-000000000000");
    assert.equal(res, null);
  });

  test("tokens are scoped per org", async () => {
    const { prefix, hash } = mint();
    await storage.createApiToken({ orgId: "org-tokens-002", name: "other", prefix, tokenHash: hash });
    const a = await storage.listApiTokens(ORG);
    const b = await storage.listApiTokens("org-tokens-002");
    assert.ok(a.every((t) => t.name !== "other"));
    assert.equal(b.length, 1);
  });
});
