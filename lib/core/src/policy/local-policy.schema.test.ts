// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LocalPolicySchema,
  PolicyRuleSchema,
  SessionRuleSchema,
  LOCAL_POLICY_SCHEMA_VERSION,
} from "./local-policy.schema.js";

describe("PolicyRuleSchema", () => {
  it("accepts a minimal rule with only id and pathGlob", () => {
    const result = PolicyRuleSchema.safeParse({
      id: "rule-1",
      pathGlob: "src/auth/**",
    });
    assert.ok(result.success);
    assert.equal(result.data.id, "rule-1");
    assert.equal(result.data.pathGlob, "src/auth/**");
  });

  it("accepts a full rule with all optional fields", () => {
    const result = PolicyRuleSchema.safeParse({
      id: "rule-full",
      pathGlob: "src/**",
      minConfidence: 0.8,
      requireContext: true,
      allowedAiTools: ["copilot", "claude"],
      minSeverity: "high",
      requireReview: true,
      scope: ["auth", "payments"],
    });
    assert.ok(result.success);
    assert.equal(result.data.minConfidence, 0.8);
    assert.deepEqual(result.data.scope, ["auth", "payments"]);
  });

  it("rejects a rule with invalid scope value", () => {
    const result = PolicyRuleSchema.safeParse({
      id: "rule-bad",
      pathGlob: "src/**",
      scope: ["invalid-scope"],
    });
    assert.ok(!result.success);
  });

  it("rejects a rule with minConfidence out of range", () => {
    const result = PolicyRuleSchema.safeParse({
      id: "rule-bad",
      pathGlob: "src/**",
      minConfidence: 1.5,
    });
    assert.ok(!result.success);
  });

  it("rejects a rule missing id", () => {
    const result = PolicyRuleSchema.safeParse({
      pathGlob: "src/**",
    });
    assert.ok(!result.success);
  });

  it("rejects a rule with empty pathGlob", () => {
    const result = PolicyRuleSchema.safeParse({
      id: "rule-1",
      pathGlob: "",
    });
    assert.ok(!result.success);
  });

  it("rejects invalid minSeverity value", () => {
    const result = PolicyRuleSchema.safeParse({
      id: "rule-1",
      pathGlob: "src/**",
      minSeverity: "urgent",
    });
    assert.ok(!result.success);
  });

  it("accepts an empty allowedAiTools array", () => {
    const result = PolicyRuleSchema.safeParse({
      id: "rule-no-ai",
      pathGlob: "src/payments/**",
      allowedAiTools: [],
    });
    assert.ok(result.success);
    assert.deepEqual(result.data.allowedAiTools, []);
  });
});

describe("SessionRuleSchema", () => {
  it("accepts a session rule with only id", () => {
    const result = SessionRuleSchema.safeParse({ id: "session-rule-1" });
    assert.ok(result.success);
  });

  it("accepts a session rule with maxAiPct and requireSignoff", () => {
    const result = SessionRuleSchema.safeParse({
      id: "session-rule-2",
      maxAiPct: 75,
      requireSignoff: true,
    });
    assert.ok(result.success);
    assert.equal(result.data.maxAiPct, 75);
    assert.equal(result.data.requireSignoff, true);
  });

  it("rejects maxAiPct greater than 100", () => {
    const result = SessionRuleSchema.safeParse({
      id: "session-rule-bad",
      maxAiPct: 110,
    });
    assert.ok(!result.success);
  });

  it("rejects maxAiPct below 0", () => {
    const result = SessionRuleSchema.safeParse({
      id: "session-rule-bad",
      maxAiPct: -1,
    });
    assert.ok(!result.success);
  });
});

describe("LocalPolicySchema", () => {
  it("accepts a valid policy with schemaVersion and empty arrays", () => {
    const result = LocalPolicySchema.safeParse({
      schemaVersion: "1.0.0",
      rules: [],
      sessionRules: [],
    });
    assert.ok(result.success);
    assert.equal(result.data.schemaVersion, "1.0.0");
  });

  it("defaults rules and sessionRules to empty arrays when absent", () => {
    const result = LocalPolicySchema.safeParse({ schemaVersion: "1.0.0" });
    assert.ok(result.success);
    assert.deepEqual(result.data.rules, []);
    assert.deepEqual(result.data.sessionRules, []);
  });

  it("accepts a policy with rules and session rules", () => {
    const result = LocalPolicySchema.safeParse({
      schemaVersion: "1.0.0",
      rules: [
        {
          id: "require-auth-context",
          pathGlob: "src/auth/**",
          requireContext: true,
          scope: ["auth"],
        },
      ],
      sessionRules: [{ id: "session-ai-pct", maxAiPct: 80 }],
    });
    assert.ok(result.success);
    assert.equal(result.data.rules.length, 1);
    assert.equal(result.data.sessionRules.length, 1);
  });

  it("rejects an unsupported schemaVersion", () => {
    const result = LocalPolicySchema.safeParse({
      schemaVersion: "2.0.0",
      rules: [],
      sessionRules: [],
    });
    assert.ok(!result.success);
  });

  it("rejects missing schemaVersion", () => {
    const result = LocalPolicySchema.safeParse({ rules: [], sessionRules: [] });
    assert.ok(!result.success);
  });

  it("rejects when rules contains an invalid rule", () => {
    const result = LocalPolicySchema.safeParse({
      schemaVersion: "1.0.0",
      rules: [{ id: "", pathGlob: "src/**" }],
      sessionRules: [],
    });
    assert.ok(!result.success);
  });
});

describe("LOCAL_POLICY_SCHEMA_VERSION", () => {
  it("is 1.0.0", () => {
    assert.equal(LOCAL_POLICY_SCHEMA_VERSION, "1.0.0");
  });
});
