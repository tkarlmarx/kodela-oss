// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { can, permissionsFor, roleAtLeast, isRole, ROLES, PERMISSIONS } from "./index.js";

describe("rbac model", () => {
  test("owner can do everything", () => {
    for (const p of PERMISSIONS) assert.ok(can("owner", p), `owner should have ${p}`);
    assert.equal(permissionsFor("owner").length, PERMISSIONS.length);
  });

  test("viewer is read-only", () => {
    assert.ok(can("viewer", "members:read"));
    assert.ok(can("viewer", "context:read"));
    assert.ok(!can("viewer", "members:invite"));
    assert.ok(!can("viewer", "policy:write"));
    assert.ok(!can("viewer", "tokens:create"));
  });

  test("member can write decisions + connect repos but not manage people", () => {
    assert.ok(can("member", "decisions:write"));
    assert.ok(can("member", "repos:connect"));
    assert.ok(can("member", "tokens:create"));
    assert.ok(!can("member", "members:invite"));
    assert.ok(!can("member", "members:role"));
    assert.ok(!can("member", "tokens:revoke"));
  });

  test("admin can manage members + governance but not billing:write", () => {
    assert.ok(can("admin", "members:invite"));
    assert.ok(can("admin", "members:role"));
    assert.ok(can("admin", "policy:write"));
    assert.ok(can("admin", "audit:export"));
    assert.ok(!can("admin", "billing:write")); // owner-only
  });

  test("tiers are supersets (member ⊇ viewer, admin ⊇ member)", () => {
    for (const p of permissionsFor("viewer")) assert.ok(can("member", p), `member missing viewer perm ${p}`);
    for (const p of permissionsFor("member")) assert.ok(can("admin", p), `admin missing member perm ${p}`);
  });

  test("roleAtLeast respects the hierarchy", () => {
    assert.ok(roleAtLeast("owner", "admin"));
    assert.ok(roleAtLeast("admin", "admin"));
    assert.ok(!roleAtLeast("member", "admin"));
    assert.ok(roleAtLeast("member", "viewer"));
  });

  test("isRole validates", () => {
    for (const r of ROLES) assert.ok(isRole(r));
    assert.ok(!isRole("superuser"));
    assert.ok(!isRole(null));
  });
});
