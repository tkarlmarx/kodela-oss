// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * End-to-end seat enforcement against the real SQLite adapter (internal design note).
 *
 * This runs against an actual node:sqlite database — no mocks — so it verifies
 * the users/memberships schema, seat counting, and the canAddSeat policy
 * together, the same way the API server's requireSeatAvailable middleware will.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { SqliteStorage } from "./sqlite.js";

// NB: the seat *policy* (canAddSeat) is unit-tested in
// lib/core/src/license/seats.test.ts. This file verifies the *storage* side —
// counting, idempotency, status transitions, per-org scoping — against a real
// node:sqlite DB, which is what the API server's middleware relies on.

const ORG = "org-seats-001";

describe("SqliteStorage — seats / membership", () => {
  let dir: string;
  let storage: SqliteStorage;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-seats-"));
    storage = new SqliteStorage(path.join(dir, "seats.db"));
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("a fresh org has zero active seats", async () => {
    assert.equal(await storage.countActiveSeats(ORG), 0);
  });

  test("adding active members increments the seat count", async () => {
    await storage.addMember({ orgId: ORG, email: "a@acme.com", name: "A", role: "owner" });
    await storage.addMember({ orgId: ORG, email: "b@acme.com" });
    assert.equal(await storage.countActiveSeats(ORG), 2);
  });

  test("adding the same email twice is idempotent (no double seat)", async () => {
    await storage.addMember({ orgId: ORG, email: "a@acme.com" });
    assert.equal(await storage.countActiveSeats(ORG), 2);
  });

  test("listMembers returns joined user info", async () => {
    const members = await storage.listMembers(ORG);
    assert.equal(members.length, 2);
    const emails = members.map((m) => m.email).sort();
    assert.deepEqual(emails, ["a@acme.com", "b@acme.com"]);
  });

  test("suspending a member frees a seat", async () => {
    const members = await storage.listMembers(ORG);
    const b = members.find((m) => m.email === "b@acme.com")!;
    await storage.setMemberStatus(ORG, b.userId, "suspended");
    assert.equal(await storage.countActiveSeats(ORG), 1);
  });

  test("reactivating a suspended member re-consumes the seat", async () => {
    const members = await storage.listMembers(ORG);
    const b = members.find((m) => m.email === "b@acme.com")!;
    await storage.setMemberStatus(ORG, b.userId, "active");
    assert.equal(await storage.countActiveSeats(ORG), 2);
  });

  test("seats are scoped per org", async () => {
    await storage.addMember({ orgId: "org-seats-002", email: "a@acme.com" });
    assert.equal(await storage.countActiveSeats("org-seats-002"), 1);
    assert.equal(await storage.countActiveSeats(ORG), 2); // unchanged
  });
});
