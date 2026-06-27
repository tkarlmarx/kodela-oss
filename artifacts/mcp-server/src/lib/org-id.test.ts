// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveOrgId, orgIsRequired, DEFAULT_ORG, REQUIRE_ORG_ENV } from "./org-id.js";

describe("resolveOrgId", () => {
  const ORIG = process.env[REQUIRE_ORG_ENV];
  afterEach(() => {
    if (ORIG === undefined) delete process.env[REQUIRE_ORG_ENV];
    else process.env[REQUIRE_ORG_ENV] = ORIG;
  });

  test("returns an explicit org id unchanged", () => {
    assert.equal(resolveOrgId("acme-corp"), "acme-corp");
  });

  test("trims surrounding whitespace", () => {
    assert.equal(resolveOrgId("  acme  "), "acme");
  });

  test("free/local path: missing org falls back to _default", () => {
    delete process.env[REQUIRE_ORG_ENV];
    assert.equal(orgIsRequired(), false);
    assert.equal(resolveOrgId(undefined), DEFAULT_ORG);
    assert.equal(resolveOrgId(null), DEFAULT_ORG);
    assert.equal(resolveOrgId("   "), DEFAULT_ORG);
  });

  test("authenticated path: missing org throws when KODELA_REQUIRE_ORG is set", () => {
    process.env[REQUIRE_ORG_ENV] = "true";
    assert.equal(orgIsRequired(), true);
    assert.throws(() => resolveOrgId(undefined), /org_id is required/);
    assert.throws(() => resolveOrgId(""), /org_id is required/);
    assert.throws(() => resolveOrgId("  "), /_default.*disabled/s);
  });

  test("authenticated path: an explicit org still works", () => {
    process.env[REQUIRE_ORG_ENV] = "1";
    assert.equal(resolveOrgId("acme-corp"), "acme-corp");
  });
});
