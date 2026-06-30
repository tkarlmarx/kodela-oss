// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractIdpRoles,
  effectiveAdminRoleNames,
  isAdminViaClaim,
  isAdminViaEmail,
  isAdmin,
} from "./admin.js";
import type { KodelaLicense } from "./types.js";

const BASE_LICENSE: KodelaLicense = {
  plan: "enterprise",
  features: ["dashboard", "sso"],
  orgId: "org_test",
  expiresAt: "2099-12-31",
};

// ── extractIdpRoles ─────────────────────────────────────────────────────────

test("extractIdpRoles: reads `groups` array (Okta / Google Workspace)", () => {
  assert.deepEqual(extractIdpRoles({ groups: ["admin", "engineering"] }), ["admin", "engineering"]);
});

test("extractIdpRoles: reads `roles` array (generic OIDC)", () => {
  assert.deepEqual(extractIdpRoles({ roles: ["admin"] }), ["admin"]);
});

test("extractIdpRoles: reads `cognito:groups` (AWS Cognito)", () => {
  assert.deepEqual(extractIdpRoles({ "cognito:groups": ["Admin"] }), ["Admin"]);
});

test("extractIdpRoles: reads Keycloak `realm_access.roles`", () => {
  assert.deepEqual(
    extractIdpRoles({ realm_access: { roles: ["admin", "user"] } }),
    ["admin", "user"],
  );
});

test("extractIdpRoles: merges multiple sources without de-dup (caller normalises)", () => {
  const claims = {
    groups: ["g1"],
    roles: ["r1"],
    "cognito:groups": ["c1"],
    realm_access: { roles: ["k1"] },
  };
  assert.deepEqual(extractIdpRoles(claims), ["g1", "r1", "c1", "k1"]);
});

test("extractIdpRoles: ignores non-array shapes and empty strings", () => {
  assert.deepEqual(extractIdpRoles({ groups: "admin" }), [], "string groups ignored");
  assert.deepEqual(extractIdpRoles({ groups: null }), []);
  assert.deepEqual(extractIdpRoles({ groups: [42, "admin"] }), ["admin"], "non-string entries skipped");
  assert.deepEqual(extractIdpRoles({ groups: [""] }), [], "empty strings skipped");
  assert.deepEqual(extractIdpRoles({}), []);
});

test("extractIdpRoles: ignores realm_access when shape is wrong", () => {
  assert.deepEqual(extractIdpRoles({ realm_access: "wrong" }), []);
  assert.deepEqual(extractIdpRoles({ realm_access: { roles: "string" } }), []);
});

// ── effectiveAdminRoleNames ─────────────────────────────────────────────────

test("effectiveAdminRoleNames: defaults when license doesn't override", () => {
  assert.deepEqual([...effectiveAdminRoleNames(BASE_LICENSE)], ["admin", "kodela-admin"]);
  assert.deepEqual([...effectiveAdminRoleNames(null)], ["admin", "kodela-admin"]);
});

test("effectiveAdminRoleNames: license override replaces defaults", () => {
  const lic: KodelaLicense = { ...BASE_LICENSE, adminRoleNames: ["org-admin", "platform-staff"] };
  assert.deepEqual([...effectiveAdminRoleNames(lic)], ["org-admin", "platform-staff"]);
});

test("effectiveAdminRoleNames: empty array falls back to defaults", () => {
  const lic: KodelaLicense = { ...BASE_LICENSE, adminRoleNames: [] };
  assert.deepEqual([...effectiveAdminRoleNames(lic)], ["admin", "kodela-admin"]);
});

// ── isAdminViaClaim ─────────────────────────────────────────────────────────

test("isAdminViaClaim: 'admin' role grants by default", () => {
  assert.equal(isAdminViaClaim(BASE_LICENSE, ["admin"]), true);
  assert.equal(isAdminViaClaim(BASE_LICENSE, ["kodela-admin"]), true);
});

test("isAdminViaClaim: case-insensitive comparison", () => {
  assert.equal(isAdminViaClaim(BASE_LICENSE, ["ADMIN"]), true);
  assert.equal(isAdminViaClaim(BASE_LICENSE, ["Kodela-Admin"]), true);
});

test("isAdminViaClaim: returns false when no matching role", () => {
  assert.equal(isAdminViaClaim(BASE_LICENSE, ["engineering", "user"]), false);
});

test("isAdminViaClaim: license override hides default 'admin'", () => {
  const lic: KodelaLicense = { ...BASE_LICENSE, adminRoleNames: ["org-admin"] };
  assert.equal(isAdminViaClaim(lic, ["admin"]), false, "old default no longer counts");
  assert.equal(isAdminViaClaim(lic, ["org-admin"]), true);
});

// ── isAdminViaEmail ─────────────────────────────────────────────────────────

test("isAdminViaEmail: matches email in license adminEmails (case-insensitive)", () => {
  const lic: KodelaLicense = { ...BASE_LICENSE, adminEmails: ["alice@example.com"] };
  assert.equal(isAdminViaEmail(lic, "alice@example.com"), true);
  assert.equal(isAdminViaEmail(lic, "ALICE@example.com"), true);
});

test("isAdminViaEmail: rejects unknown email", () => {
  const lic: KodelaLicense = { ...BASE_LICENSE, adminEmails: ["alice@example.com"] };
  assert.equal(isAdminViaEmail(lic, "bob@example.com"), false);
});

test("isAdminViaEmail: returns false when adminEmails is missing/empty", () => {
  assert.equal(isAdminViaEmail(BASE_LICENSE, "alice@example.com"), false);
  const empty: KodelaLicense = { ...BASE_LICENSE, adminEmails: [] };
  assert.equal(isAdminViaEmail(empty, "alice@example.com"), false);
});

test("isAdminViaEmail: returns false when user has no email", () => {
  const lic: KodelaLicense = { ...BASE_LICENSE, adminEmails: ["alice@example.com"] };
  assert.equal(isAdminViaEmail(lic, undefined), false);
});

// ── isAdmin (combined) ──────────────────────────────────────────────────────

test("isAdmin: IdP claim wins (returns 'idp_claim')", () => {
  const lic: KodelaLicense = { ...BASE_LICENSE, adminEmails: ["alice@example.com"] };
  assert.equal(
    isAdmin({ license: lic, userEmail: "alice@example.com", userRoles: ["admin"] }),
    "idp_claim",
  );
});

test("isAdmin: license-email fallback when no IdP claim matches", () => {
  const lic: KodelaLicense = { ...BASE_LICENSE, adminEmails: ["alice@example.com"] };
  assert.equal(
    isAdmin({ license: lic, userEmail: "alice@example.com", userRoles: ["user"] }),
    "license_email",
  );
});

test("isAdmin: null when neither path grants", () => {
  const lic: KodelaLicense = { ...BASE_LICENSE, adminEmails: ["alice@example.com"] };
  assert.equal(
    isAdmin({ license: lic, userEmail: "bob@example.com", userRoles: ["user"] }),
    null,
  );
});

test("isAdmin: null when no license is configured", () => {
  // Without a license, only the IdP-claim path can grant admin.
  assert.equal(
    isAdmin({ license: null, userEmail: "alice@example.com", userRoles: ["admin"] }),
    "idp_claim",
    "IdP claim still works without a license (uses default role names)",
  );
  assert.equal(
    isAdmin({ license: null, userEmail: "alice@example.com", userRoles: ["user"] }),
    null,
    "no license + no IdP grant → not admin",
  );
});

test("isAdmin: when license overrides role names, only those names grant", () => {
  const lic: KodelaLicense = {
    ...BASE_LICENSE,
    adminRoleNames: ["platform-staff"],
    adminEmails: [],
  };
  assert.equal(
    isAdmin({ license: lic, userEmail: undefined, userRoles: ["admin"] }),
    null,
    "default 'admin' role does NOT match a custom-named license",
  );
  assert.equal(
    isAdmin({ license: lic, userEmail: undefined, userRoles: ["platform-staff"] }),
    "idp_claim",
  );
});
