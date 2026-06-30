// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSensitivePath, matchingSensitivePaths } from "./sensitive-paths.js";

describe("isSensitivePath", () => {
  const patterns = [
    "auth/",
    "payments/",
    "crypto/",
    "secrets/",
    "credentials/",
    "tokens/",
  ];

  it("returns false for non-sensitive paths", () => {
    assert.equal(isSensitivePath("src/utils/logger.ts", patterns), false);
    assert.equal(isSensitivePath("lib/core/engine.ts", patterns), false);
    assert.equal(isSensitivePath("tests/unit/foo.test.ts", patterns), false);
  });

  it("matches auth/ prefix anywhere in the path", () => {
    assert.equal(isSensitivePath("src/auth/login.ts", patterns), true);
    assert.equal(isSensitivePath("auth/session.ts", patterns), true);
    assert.equal(isSensitivePath("modules/auth/jwt.ts", patterns), true);
  });

  it("matches payments/ segment", () => {
    assert.equal(isSensitivePath("src/payments/stripe.ts", patterns), true);
    assert.equal(isSensitivePath("payments/webhook.ts", patterns), true);
  });

  it("matches crypto/ segment", () => {
    assert.equal(isSensitivePath("lib/crypto/hmac.ts", patterns), true);
  });

  it("is case-insensitive", () => {
    assert.equal(isSensitivePath("src/Auth/Login.ts", patterns), true);
    assert.equal(isSensitivePath("SRC/PAYMENTS/STRIPE.TS", patterns), true);
  });

  it("handles Windows-style backslash paths", () => {
    assert.equal(isSensitivePath("src\\auth\\login.ts", patterns), true);
  });

  it("returns false with an empty patterns list", () => {
    assert.equal(isSensitivePath("src/auth/login.ts", []), false);
  });
});

describe("matchingSensitivePaths", () => {
  const patterns = ["auth/", "payments/", "crypto/"];

  it("returns matching patterns", () => {
    const matches = matchingSensitivePaths("src/auth/login.ts", patterns);
    assert.deepEqual(matches, ["auth/"]);
  });

  it("returns multiple matches", () => {
    const matches = matchingSensitivePaths("src/auth/payments/handler.ts", patterns);
    assert.deepEqual(matches, ["auth/", "payments/"]);
  });

  it("returns empty array when no match", () => {
    const matches = matchingSensitivePaths("src/utils/logger.ts", patterns);
    assert.deepEqual(matches, []);
  });
});
