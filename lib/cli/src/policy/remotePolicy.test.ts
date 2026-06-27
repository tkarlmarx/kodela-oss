// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkPolicyViolations,
  applyRemotePolicyToConfig,
  fetchRemotePolicy,
  type RemotePolicy,
  type RemotePolicyRule,
} from "./remotePolicy.js";
import type { ContextEntry } from "@kodela/core";
import type { KodelaConfig } from "../config/schema.js";

function makeRule(overrides: Partial<RemotePolicyRule> = {}): RemotePolicyRule {
  return {
    id: "rule-1",
    pathGlob: "**/*.ts",
    minConfidence: null,
    requireContext: false,
    allowedAiTools: null,
    minSeverity: null,
    requireReview: false,
    ...overrides,
  };
}

function makePolicy(rules: RemotePolicyRule[]): RemotePolicy {
  return { policyId: "policy-1", name: "test", rules };
}

function makeEntry(overrides: Partial<ContextEntry> = {}): ContextEntry {
  return {
    id: "entry-1",
    filePath: "src/auth/login.ts",
    source: "human",
    confidence: 0.9,
    severity: "medium",
    reviewRequired: false,
    aiTool: null,
    summary: "Login handler",
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as ContextEntry;
}

function makeConfig(minConfidence = 0.0): KodelaConfig {
  return {
    ci: {
      thresholds: {
        min_confidence_score: minConfidence,
        max_unresolved_critical_pct: 0,
        max_orphaned_pct: 0,
        max_ai_generated_pct: 100,
      },
    },
  } as unknown as KodelaConfig;
}

describe("checkPolicyViolations — requireContext", () => {
  it("raises violation when requireContext is true and no entries match the glob", () => {
    const rule = makeRule({ requireContext: true, pathGlob: "payments/**" });
    const entries = [makeEntry({ filePath: "src/auth/login.ts" })];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.field, "requireContext");
    assert.equal(violations[0]!.ruleId, "rule-1");
    assert.match(violations[0]!.message, /payments\//);
  });

  it("does not raise violation when requireContext is true and entries match", () => {
    const rule = makeRule({ requireContext: true, pathGlob: "src/**" });
    const entries = [makeEntry({ filePath: "src/auth/login.ts" })];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.filter((v) => v.field === "requireContext").length, 0);
  });

  it("does not raise violation when requireContext is false and no entries match", () => {
    const rule = makeRule({ requireContext: false, pathGlob: "payments/**" });
    const entries = [makeEntry({ filePath: "src/auth/login.ts" })];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.length, 0);
  });
});

describe("checkPolicyViolations — minConfidence", () => {
  it("raises violation when entry confidence is below rule minimum", () => {
    const rule = makeRule({ minConfidence: 0.8, pathGlob: "**/*.ts" });
    const entries = [makeEntry({ filePath: "src/auth/login.ts", confidence: 0.6 })];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.field, "minConfidence");
    assert.match(violations[0]!.message, /60\.0%.*80\.0%/);
  });

  it("does not raise violation when entry confidence meets rule minimum", () => {
    const rule = makeRule({ minConfidence: 0.8, pathGlob: "**/*.ts" });
    const entries = [makeEntry({ filePath: "src/auth/login.ts", confidence: 0.85 })];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.filter((v) => v.field === "minConfidence").length, 0);
  });

  it("does not raise violation when minConfidence is null", () => {
    const rule = makeRule({ minConfidence: null, pathGlob: "**/*.ts" });
    const entries = [makeEntry({ filePath: "src/auth/login.ts", confidence: 0.1 })];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.filter((v) => v.field === "minConfidence").length, 0);
  });
});

describe("checkPolicyViolations — minSeverity", () => {
  it("raises violation when entry severity is below rule minimum", () => {
    const rule = makeRule({ minSeverity: "high", pathGlob: "**/*.ts" });
    const entries = [makeEntry({ filePath: "src/auth/login.ts", severity: "low" })];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.field, "minSeverity");
    assert.match(violations[0]!.message, /"low".*"high"/);
  });

  it("does not raise violation when entry severity meets or exceeds minimum", () => {
    const rule = makeRule({ minSeverity: "medium", pathGlob: "**/*.ts" });
    const entries = [makeEntry({ filePath: "src/auth/login.ts", severity: "critical" })];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.filter((v) => v.field === "minSeverity").length, 0);
  });

  it("does not raise violation when minSeverity is null", () => {
    const rule = makeRule({ minSeverity: null, pathGlob: "**/*.ts" });
    const entries = [makeEntry({ filePath: "src/auth/login.ts", severity: "low" })];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.filter((v) => v.field === "minSeverity").length, 0);
  });
});

describe("checkPolicyViolations — allowedAiTools", () => {
  it("raises violation when allowedAiTools is empty and entry source is ai", () => {
    const rule = makeRule({ allowedAiTools: [], pathGlob: "**/*.ts" });
    const entries = [makeEntry({ filePath: "src/auth/login.ts", source: "ai", aiTool: "copilot" })];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.field, "allowedAiTools");
    assert.match(violations[0]!.message, /disallows all AI/);
  });

  it("raises violation when aiTool is not in allowedAiTools list", () => {
    const rule = makeRule({ allowedAiTools: ["copilot", "cursor"], pathGlob: "**/*.ts" });
    const entries = [makeEntry({ filePath: "src/auth/login.ts", source: "ai", aiTool: "tabnine" })];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.field, "allowedAiTools");
    assert.match(violations[0]!.message, /tabnine/);
  });

  it("does not raise violation when aiTool is in allowedAiTools list", () => {
    const rule = makeRule({ allowedAiTools: ["copilot", "cursor"], pathGlob: "**/*.ts" });
    const entries = [makeEntry({ filePath: "src/auth/login.ts", source: "ai", aiTool: "copilot" })];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.filter((v) => v.field === "allowedAiTools").length, 0);
  });

  it("does not raise violation for non-ai entries regardless of allowedAiTools", () => {
    const rule = makeRule({ allowedAiTools: [], pathGlob: "**/*.ts" });
    const entries = [makeEntry({ filePath: "src/auth/login.ts", source: "human" })];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.filter((v) => v.field === "allowedAiTools").length, 0);
  });

  it("does not raise violation when allowedAiTools is null (unconstrained)", () => {
    const rule = makeRule({ allowedAiTools: null, pathGlob: "**/*.ts" });
    const entries = [makeEntry({ filePath: "src/auth/login.ts", source: "ai", aiTool: "anything" })];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.filter((v) => v.field === "allowedAiTools").length, 0);
  });
});

describe("checkPolicyViolations — requireReview", () => {
  it("raises violation when requireReview is true and AI entry has reviewRequired=true", () => {
    const rule = makeRule({ requireReview: true, pathGlob: "**/*.ts" });
    const entries = [
      makeEntry({ filePath: "src/auth/login.ts", source: "ai", reviewRequired: true }),
    ];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.field, "requireReview");
    assert.match(violations[0]!.message, /not been reviewed/);
  });

  it("does not raise violation when requireReview is true but entry is already reviewed (reviewRequired=false)", () => {
    const rule = makeRule({ requireReview: true, pathGlob: "**/*.ts" });
    const entries = [
      makeEntry({ filePath: "src/auth/login.ts", source: "ai", reviewRequired: false }),
    ];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.filter((v) => v.field === "requireReview").length, 0);
  });

  it("does not raise violation when requireReview is true but entry source is human", () => {
    const rule = makeRule({ requireReview: true, pathGlob: "**/*.ts" });
    const entries = [
      makeEntry({ filePath: "src/auth/login.ts", source: "human", reviewRequired: true }),
    ];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.filter((v) => v.field === "requireReview").length, 0);
  });

  it("does not raise violation when requireReview is false even if entry has reviewRequired=true", () => {
    const rule = makeRule({ requireReview: false, pathGlob: "**/*.ts" });
    const entries = [
      makeEntry({ filePath: "src/auth/login.ts", source: "ai", reviewRequired: true }),
    ];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.filter((v) => v.field === "requireReview").length, 0);
  });

  it("raises one violation per non-reviewed AI entry when requireReview is true", () => {
    const rule = makeRule({ requireReview: true, pathGlob: "src/**" });
    const entries = [
      makeEntry({ id: "e1", filePath: "src/auth/login.ts", source: "ai", reviewRequired: true }),
      makeEntry({ id: "e2", filePath: "src/payments/charge.ts", source: "ai", reviewRequired: true }),
      makeEntry({ id: "e3", filePath: "src/utils/format.ts", source: "ai", reviewRequired: false }),
    ];
    const violations = checkPolicyViolations(entries, makePolicy([rule])).filter(
      (v) => v.field === "requireReview",
    );
    assert.equal(violations.length, 2);
    assert.ok(violations.some((v) => v.message.includes("e1")));
    assert.ok(violations.some((v) => v.message.includes("e2")));
  });
});

describe("checkPolicyViolations — pathGlob matching", () => {
  it("only applies rule violations to entries whose filePath matches the glob", () => {
    const rule = makeRule({ minConfidence: 0.9, pathGlob: "src/auth/**" });
    const entries = [
      makeEntry({ id: "e1", filePath: "src/auth/login.ts", confidence: 0.5 }),
      makeEntry({ id: "e2", filePath: "src/payments/charge.ts", confidence: 0.5 }),
    ];
    const violations = checkPolicyViolations(entries, makePolicy([rule]));
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.message, /e1/);
  });

  it("returns no violations when no entries exist and requireContext is false", () => {
    const rule = makeRule({ pathGlob: "**/*.ts" });
    const violations = checkPolicyViolations([], makePolicy([rule]));
    assert.equal(violations.length, 0);
  });
});

describe("checkPolicyViolations — multiple rules", () => {
  it("collects violations from multiple rules independently", () => {
    const rules = [
      makeRule({ id: "r1", pathGlob: "src/auth/**", minConfidence: 0.9 }),
      makeRule({ id: "r2", pathGlob: "src/payments/**", requireReview: true }),
    ];
    const entries = [
      makeEntry({ id: "e1", filePath: "src/auth/login.ts", confidence: 0.5, source: "human" }),
      makeEntry({ id: "e2", filePath: "src/payments/charge.ts", source: "ai", reviewRequired: true }),
    ];
    const violations = checkPolicyViolations(entries, makePolicy(rules));
    assert.equal(violations.length, 2);
    assert.ok(violations.some((v) => v.ruleId === "r1" && v.field === "minConfidence"));
    assert.ok(violations.some((v) => v.ruleId === "r2" && v.field === "requireReview"));
  });
});

describe("applyRemotePolicyToConfig", () => {
  it("returns localConfig unchanged when no rule has minConfidence", () => {
    const policy = makePolicy([makeRule({ minConfidence: null })]);
    const config = makeConfig(0.5);
    const result = applyRemotePolicyToConfig(policy, config);
    assert.equal(result.ci.thresholds.min_confidence_score, 0.5);
  });

  it("uses the most restrictive (highest) remote minConfidence across all rules", () => {
    const policy = makePolicy([
      makeRule({ id: "r1", minConfidence: 0.7 }),
      makeRule({ id: "r2", minConfidence: 0.9 }),
      makeRule({ id: "r3", minConfidence: 0.6 }),
    ]);
    const config = makeConfig(0.0);
    const result = applyRemotePolicyToConfig(policy, config);
    assert.equal(result.ci.thresholds.min_confidence_score, 0.9);
  });

  it("takes the higher of local and remote minConfidence", () => {
    const policy = makePolicy([makeRule({ minConfidence: 0.6 })]);
    const config = makeConfig(0.8);
    const result = applyRemotePolicyToConfig(policy, config);
    assert.equal(result.ci.thresholds.min_confidence_score, 0.8);
  });

  it("preserves other config fields unchanged", () => {
    const policy = makePolicy([makeRule({ minConfidence: 0.9 })]);
    const config = makeConfig(0.0);
    const result = applyRemotePolicyToConfig(policy, config);
    assert.equal(
      result.ci.thresholds.max_unresolved_critical_pct,
      config.ci.thresholds.max_unresolved_critical_pct,
    );
  });
});

describe("fetchRemotePolicy", () => {
  it("returns null when fetch throws (network error / timeout)", async () => {
    const result = await fetchRemotePolicy("http://127.0.0.1:1", "org-x");
    assert.equal(result, null);
  });

  it("returns null when server responds with 4xx status", async () => {
    const { createServer } = await import("node:http");
    await new Promise<void>((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
      });
      server.listen(0, "127.0.0.1", async () => {
        const addr = server.address() as { port: number };
        try {
          const result = await fetchRemotePolicy(
            `http://127.0.0.1:${addr.port}`,
            "org-x",
          );
          assert.equal(result, null);
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          server.close();
        }
      });
    });
  });

  it("returns null when server responds with 5xx status", async () => {
    const { createServer } = await import("node:http");
    await new Promise<void>((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Service unavailable" }));
      });
      server.listen(0, "127.0.0.1", async () => {
        const addr = server.address() as { port: number };
        try {
          const result = await fetchRemotePolicy(
            `http://127.0.0.1:${addr.port}`,
            "org-x",
          );
          assert.equal(result, null);
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          server.close();
        }
      });
    });
  });

  it("returns parsed RemotePolicy on 200 response", async () => {
    const { createServer } = await import("node:http");
    const expected: RemotePolicy = {
      policyId: "p-1",
      name: "prod-policy",
      rules: [
        {
          id: "r-1",
          pathGlob: "src/**",
          minConfidence: 0.8,
          requireContext: true,
          allowedAiTools: ["copilot"],
          minSeverity: "medium",
          requireReview: true,
        },
      ],
    };
    await new Promise<void>((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(expected));
      });
      server.listen(0, "127.0.0.1", async () => {
        const addr = server.address() as { port: number };
        try {
          const result = await fetchRemotePolicy(
            `http://127.0.0.1:${addr.port}`,
            "org-x",
          );
          assert.deepEqual(result, expected);
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          server.close();
        }
      });
    });
  });

  it("sends X-Kodela-Org-Id header in the request", async () => {
    const { createServer } = await import("node:http");
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        const orgHeader = req.headers["x-kodela-org-id"];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ policyId: "p-1", name: "test", rules: [], _orgHeader: orgHeader }),
        );
      });
      server.listen(0, "127.0.0.1", async () => {
        const addr = server.address() as { port: number };
        try {
          const result = await fetchRemotePolicy(
            `http://127.0.0.1:${addr.port}`,
            "my-org",
          );
          assert.equal((result as unknown as Record<string, unknown>)["_orgHeader"], "my-org");
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          server.close();
        }
      });
    });
  });

  it("sends Authorization Bearer header when apiSecret is provided", async () => {
    const { createServer } = await import("node:http");
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        const authHeader = req.headers["authorization"];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ policyId: "p-1", name: "test", rules: [], _auth: authHeader }),
        );
      });
      server.listen(0, "127.0.0.1", async () => {
        const addr = server.address() as { port: number };
        try {
          const result = await fetchRemotePolicy(
            `http://127.0.0.1:${addr.port}`,
            "org-x",
            "my-secret",
          );
          assert.equal(
            (result as unknown as Record<string, unknown>)["_auth"],
            "Bearer my-secret",
          );
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          server.close();
        }
      });
    });
  });
});
