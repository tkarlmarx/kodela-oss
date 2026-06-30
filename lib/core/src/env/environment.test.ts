// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { detectEnvironment, environmentLabel } from "./environment.js";

describe("detectEnvironment", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const KEYS = ["REPL_ID", "REPLIT_DEV_DOMAIN", "REPL_SLUG", "CI", "GITHUB_ACTIONS"];

  beforeEach(() => {
    for (const key of KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("returns isReplit=false and isCI=false in clean environment", () => {
    const env = detectEnvironment();
    assert.equal(env.isReplit, false);
    assert.equal(env.isCI, false);
    assert.equal(env.replId, undefined);
    assert.equal(env.replitDomain, undefined);
    assert.equal(env.replSlug, undefined);
  });

  it("detects Replit via REPL_ID", () => {
    process.env["REPL_ID"] = "abc-123";
    const env = detectEnvironment();
    assert.equal(env.isReplit, true);
    assert.equal(env.replId, "abc-123");
  });

  it("detects Replit via REPLIT_DEV_DOMAIN", () => {
    process.env["REPLIT_DEV_DOMAIN"] = "myapp.replit.dev";
    const env = detectEnvironment();
    assert.equal(env.isReplit, true);
    assert.equal(env.replitDomain, "myapp.replit.dev");
  });

  it("detects Replit via REPL_SLUG", () => {
    process.env["REPL_SLUG"] = "my-repl";
    const env = detectEnvironment();
    assert.equal(env.isReplit, true);
    assert.equal(env.replSlug, "my-repl");
  });

  it("detects CI via CI env var", () => {
    process.env["CI"] = "true";
    const env = detectEnvironment();
    assert.equal(env.isCI, true);
    assert.equal(env.isReplit, false);
  });

  it("detects CI via GITHUB_ACTIONS", () => {
    process.env["GITHUB_ACTIONS"] = "true";
    const env = detectEnvironment();
    assert.equal(env.isCI, true);
  });

  it("can be both Replit and CI", () => {
    process.env["REPL_ID"] = "xyz";
    process.env["CI"] = "1";
    const env = detectEnvironment();
    assert.equal(env.isReplit, true);
    assert.equal(env.isCI, true);
  });
});

describe("environmentLabel", () => {
  it("returns 'Replit' for Replit env", () => {
    assert.equal(environmentLabel({ isReplit: true, isCI: false }), "Replit");
  });

  it("returns 'CI' for CI env", () => {
    assert.equal(environmentLabel({ isReplit: false, isCI: true }), "CI");
  });

  it("returns 'local' for plain env", () => {
    assert.equal(environmentLabel({ isReplit: false, isCI: false }), "local");
  });

  it("prioritises Replit over CI when both true", () => {
    assert.equal(environmentLabel({ isReplit: true, isCI: true }), "Replit");
  });
});
