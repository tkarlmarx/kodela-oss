// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyRisk } from "./summarize.js";

// classifyRisk is the default risk scorer the MCP annotate_file tool falls back
// to when an agent omits `risk`. It must never silently score a sensitive path
// as "low", so these cases pin the path- and size-driven behavior.
describe("classifyRisk", () => {
  test("sensitive paths score high regardless of size", () => {
    assert.equal(classifyRisk("src/auth/session.ts", 1, 0), "high");
    assert.equal(classifyRisk("lib/payment/checkout.ts", 3, 2), "high");
    assert.equal(classifyRisk("services/oauth/token.ts", 0, 1), "high");
  });

  test("infra/db/schema paths score medium", () => {
    assert.equal(classifyRisk("db/migrations/001_init.ts", 5, 0), "medium");
    assert.equal(classifyRisk("config/deploy.ts", 2, 1), "medium");
    assert.equal(classifyRisk("src/schema/users.ts", 4, 0), "medium");
  });

  test("large diffs on plain source escalate to medium", () => {
    assert.equal(classifyRisk("src/utils/format.ts", 150, 60), "medium");
  });

  test("small changes on plain source stay low", () => {
    assert.equal(classifyRisk("src/utils/format.ts", 4, 2), "low");
    assert.equal(classifyRisk("README.md", 10, 0), "low");
  });
});
