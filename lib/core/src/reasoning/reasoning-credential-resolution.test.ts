// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Tests for session-aware AI credential resolution and provider inference.
 *
 * Covers:
 *   - inferProviderFromModel — model string → provider hint
 *   - resolveReasoningCredentials — priority order and session hint tiebreaker
 *   - extractReasoning — ANTHROPIC_API_KEY / OPENAI_API_KEY fallback paths
 *     (no network calls — all paths fall back to diff-inference because the
 *      fake keys trigger fetch errors that are absorbed by extractReasoning)
 */

import assert from "node:assert/strict";
import { describe, test, before, after, beforeEach } from "node:test";
import {
  inferProviderFromModel,
  resolveReasoningCredentials,
  extractReasoning,
} from "./index.js";

// ---------------------------------------------------------------------------
// Env var helpers
// ---------------------------------------------------------------------------

type EnvSnapshot = Record<string, string | undefined>;

const WATCHED_VARS = [
  "KODELA_AI_API_KEY",
  "KODELA_AI_PROVIDER",
  "KODELA_AI_MODEL",
  "KODELA_AI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const key of WATCHED_VARS) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const key of WATCHED_VARS) {
    if (snap[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snap[key];
    }
  }
}

function clearAll(): void {
  for (const key of WATCHED_VARS) {
    delete process.env[key];
  }
}

// ---------------------------------------------------------------------------
// inferProviderFromModel
// ---------------------------------------------------------------------------

describe("inferProviderFromModel", () => {
  test("claude- prefix → anthropic", () => {
    assert.equal(inferProviderFromModel("claude-3-5-sonnet-20241022"), "anthropic");
    assert.equal(inferProviderFromModel("claude-3-opus-20240229"), "anthropic");
    assert.equal(inferProviderFromModel("claude-haiku"), "anthropic");
  });

  test("gpt- prefix → openai", () => {
    assert.equal(inferProviderFromModel("gpt-4o"), "openai");
    assert.equal(inferProviderFromModel("gpt-4o-mini"), "openai");
    assert.equal(inferProviderFromModel("gpt-3.5-turbo"), "openai");
  });

  test("o1 prefix → openai", () => {
    assert.equal(inferProviderFromModel("o1-mini"), "openai");
    assert.equal(inferProviderFromModel("o1-preview"), "openai");
    assert.equal(inferProviderFromModel("o1"), "openai");
  });

  test("o3 prefix → openai", () => {
    assert.equal(inferProviderFromModel("o3-mini"), "openai");
    assert.equal(inferProviderFromModel("o3"), "openai");
  });

  test("gemini- prefix → google", () => {
    assert.equal(inferProviderFromModel("gemini-2.0-flash"), "google");
    assert.equal(inferProviderFromModel("gemini-pro"), "google");
    assert.equal(inferProviderFromModel("gemini-1.5-pro"), "google");
  });

  test("unknown model → undefined", () => {
    assert.equal(inferProviderFromModel("mistral-7b"), undefined);
    assert.equal(inferProviderFromModel("llama3"), undefined);
    assert.equal(inferProviderFromModel("deepseek-r1"), undefined);
  });

  test("undefined model → undefined", () => {
    assert.equal(inferProviderFromModel(undefined), undefined);
    assert.equal(inferProviderFromModel(""), undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveReasoningCredentials
// ---------------------------------------------------------------------------

describe("resolveReasoningCredentials — explicit config wins", () => {
  let snap: EnvSnapshot;
  before(() => {
    snap = snapshotEnv();
    clearAll();
    process.env["KODELA_AI_API_KEY"] = "kodela-key";
    process.env["ANTHROPIC_API_KEY"] = "anthropic-key";
    process.env["OPENAI_API_KEY"] = "openai-key";
  });
  after(() => restoreEnv(snap));

  test("explicit apiKey takes priority over all env vars", () => {
    const result = resolveReasoningCredentials({ apiKey: "explicit-key", provider: "anthropic" });
    assert.equal(result.apiKey, "explicit-key");
    assert.equal(result.provider, "anthropic");
    assert.equal(result.credentialSource, "explicit-config");
  });

  test("explicit apiKey with no provider defaults to openai via env", () => {
    process.env["KODELA_AI_PROVIDER"] = "anthropic";
    const result = resolveReasoningCredentials({ apiKey: "explicit-key" });
    assert.equal(result.apiKey, "explicit-key");
    assert.equal(result.credentialSource, "explicit-config");
    delete process.env["KODELA_AI_PROVIDER"];
  });
});

describe("resolveReasoningCredentials — KODELA_AI_API_KEY wins over native vars", () => {
  let snap: EnvSnapshot;
  before(() => {
    snap = snapshotEnv();
    clearAll();
    process.env["KODELA_AI_API_KEY"] = "kodela-key";
    process.env["ANTHROPIC_API_KEY"] = "anthropic-key";
    process.env["OPENAI_API_KEY"] = "openai-key";
  });
  after(() => restoreEnv(snap));

  test("KODELA_AI_API_KEY wins over ANTHROPIC_API_KEY and OPENAI_API_KEY", () => {
    const result = resolveReasoningCredentials();
    assert.equal(result.apiKey, "kodela-key");
    assert.equal(result.credentialSource, "KODELA_AI_API_KEY");
  });

  test("KODELA_AI_API_KEY wins even when session hint is set", () => {
    const result = resolveReasoningCredentials(undefined, "anthropic");
    assert.equal(result.apiKey, "kodela-key");
    assert.equal(result.credentialSource, "KODELA_AI_API_KEY");
  });
});

describe("resolveReasoningCredentials — ANTHROPIC_API_KEY fallback", () => {
  let snap: EnvSnapshot;
  before(() => {
    snap = snapshotEnv();
    clearAll();
    process.env["ANTHROPIC_API_KEY"] = "anthropic-key";
  });
  after(() => restoreEnv(snap));

  test("uses ANTHROPIC_API_KEY when no KODELA_AI_API_KEY is set", () => {
    const result = resolveReasoningCredentials();
    assert.equal(result.apiKey, "anthropic-key");
    assert.equal(result.provider, "anthropic");
    assert.equal(result.credentialSource, "ANTHROPIC_API_KEY");
  });

  test("adopts session model when using ANTHROPIC_API_KEY", () => {
    const result = resolveReasoningCredentials(undefined, "anthropic", "claude-3-5-sonnet-20241022");
    assert.equal(result.model, "claude-3-5-sonnet-20241022");
    assert.equal(result.credentialSource, "ANTHROPIC_API_KEY");
  });
});

describe("resolveReasoningCredentials — OPENAI_API_KEY fallback", () => {
  let snap: EnvSnapshot;
  before(() => {
    snap = snapshotEnv();
    clearAll();
    process.env["OPENAI_API_KEY"] = "openai-key";
  });
  after(() => restoreEnv(snap));

  test("uses OPENAI_API_KEY when no KODELA_AI_API_KEY or ANTHROPIC_API_KEY", () => {
    const result = resolveReasoningCredentials();
    assert.equal(result.apiKey, "openai-key");
    assert.equal(result.provider, "openai");
    assert.equal(result.credentialSource, "OPENAI_API_KEY");
  });

  test("adopts session model when using OPENAI_API_KEY", () => {
    const result = resolveReasoningCredentials(undefined, "openai", "gpt-4o");
    assert.equal(result.model, "gpt-4o");
    assert.equal(result.credentialSource, "OPENAI_API_KEY");
  });
});

describe("resolveReasoningCredentials — session model hint tiebreaker", () => {
  let snap: EnvSnapshot;
  before(() => {
    snap = snapshotEnv();
    clearAll();
    process.env["ANTHROPIC_API_KEY"] = "anthropic-key";
    process.env["OPENAI_API_KEY"] = "openai-key";
  });
  after(() => restoreEnv(snap));

  test("anthropic hint prefers ANTHROPIC_API_KEY when both keys are set", () => {
    const result = resolveReasoningCredentials(undefined, "anthropic");
    assert.equal(result.apiKey, "anthropic-key");
    assert.equal(result.provider, "anthropic");
    assert.equal(result.credentialSource, "ANTHROPIC_API_KEY");
  });

  test("openai hint prefers OPENAI_API_KEY when both keys are set", () => {
    const result = resolveReasoningCredentials(undefined, "openai");
    assert.equal(result.apiKey, "openai-key");
    assert.equal(result.provider, "openai");
    assert.equal(result.credentialSource, "OPENAI_API_KEY");
  });

  test("no hint defaults to ANTHROPIC_API_KEY first (stable ordering)", () => {
    const result = resolveReasoningCredentials();
    assert.equal(result.apiKey, "anthropic-key");
    assert.equal(result.provider, "anthropic");
    assert.equal(result.credentialSource, "ANTHROPIC_API_KEY");
  });

  test("session model is adopted under the hinted provider", () => {
    const result = resolveReasoningCredentials(
      undefined,
      "anthropic",
      "claude-3-5-sonnet-20241022",
    );
    assert.equal(result.model, "claude-3-5-sonnet-20241022");
    assert.equal(result.credentialSource, "ANTHROPIC_API_KEY");
  });

  test("unrecognised hint falls back to ANTHROPIC_API_KEY (stable order)", () => {
    const result = resolveReasoningCredentials(undefined, "unknown-tool");
    assert.equal(result.credentialSource, "ANTHROPIC_API_KEY");
  });
});

describe("resolveReasoningCredentials — GEMINI_API_KEY fallback", () => {
  let snap: EnvSnapshot;
  before(() => {
    snap = snapshotEnv();
    clearAll();
    process.env["GEMINI_API_KEY"] = "gemini-key";
  });
  after(() => restoreEnv(snap));

  test("picks up GEMINI_API_KEY when no other keys are set", () => {
    const result = resolveReasoningCredentials();
    assert.equal(result.apiKey, "gemini-key");
    assert.equal(result.provider, "google");
    assert.equal(result.credentialSource, "GEMINI_API_KEY");
  });

  test("google hint prefers GEMINI_API_KEY", () => {
    const result = resolveReasoningCredentials(undefined, "google");
    assert.equal(result.apiKey, "gemini-key");
    assert.equal(result.provider, "google");
    assert.equal(result.credentialSource, "GEMINI_API_KEY");
  });

  test("adopts session model under google hint", () => {
    const result = resolveReasoningCredentials(
      undefined,
      "google",
      "gemini-2.0-flash",
    );
    assert.equal(result.model, "gemini-2.0-flash");
    assert.equal(result.credentialSource, "GEMINI_API_KEY");
  });
});

describe("resolveReasoningCredentials — GOOGLE_API_KEY fallback (alias)", () => {
  let snap: EnvSnapshot;
  before(() => {
    snap = snapshotEnv();
    clearAll();
    process.env["GOOGLE_API_KEY"] = "google-key";
  });
  after(() => restoreEnv(snap));

  test("picks up GOOGLE_API_KEY when GEMINI_API_KEY is absent", () => {
    const result = resolveReasoningCredentials();
    assert.equal(result.apiKey, "google-key");
    assert.equal(result.provider, "google");
    assert.equal(result.credentialSource, "GOOGLE_API_KEY");
  });
});

describe("resolveReasoningCredentials — google hint tiebreaker (all three keys set)", () => {
  let snap: EnvSnapshot;
  before(() => {
    snap = snapshotEnv();
    clearAll();
    process.env["ANTHROPIC_API_KEY"] = "anthropic-key";
    process.env["OPENAI_API_KEY"] = "openai-key";
    process.env["GEMINI_API_KEY"] = "gemini-key";
  });
  after(() => restoreEnv(snap));

  test("google hint selects GEMINI_API_KEY over Anthropic and OpenAI", () => {
    const result = resolveReasoningCredentials(undefined, "google");
    assert.equal(result.apiKey, "gemini-key");
    assert.equal(result.provider, "google");
    assert.equal(result.credentialSource, "GEMINI_API_KEY");
  });

  test("no hint still defaults to ANTHROPIC_API_KEY first", () => {
    const result = resolveReasoningCredentials();
    assert.equal(result.credentialSource, "ANTHROPIC_API_KEY");
  });
});

describe("resolveReasoningCredentials — no credentials", () => {
  let snap: EnvSnapshot;
  before(() => {
    snap = snapshotEnv();
    clearAll();
  });
  after(() => restoreEnv(snap));

  test("returns empty apiKey and source none when no credentials are available", () => {
    const result = resolveReasoningCredentials();
    assert.equal(result.apiKey, "");
    assert.equal(result.credentialSource, "none");
  });
});

// ---------------------------------------------------------------------------
// extractReasoning — ANTHROPIC_API_KEY and OPENAI_API_KEY fallback paths
//
// We cannot make real network calls in tests, so we verify that:
//   a) A key is picked up (not falling back to diff-inference immediately)
//   b) The network call fails (fake key) → extractReasoning absorbs it and
//      returns the diff-inference fallback
//
// This confirms the end-to-end wiring without requiring a real API key.
// ---------------------------------------------------------------------------

describe("extractReasoning — picks up ANTHROPIC_API_KEY (network error → fallback)", () => {
  let snap: EnvSnapshot;
  before(() => {
    snap = snapshotEnv();
    clearAll();
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-fake-key";
  });
  after(() => restoreEnv(snap));

  test("absorbs fetch error and returns diff-inference fallback", async () => {
    const result = await extractReasoning("src/auth/login.ts", {
      note: "Checks JWT expiry",
    });
    assert.equal(result.extractionMethod, "diff-inference");
    assert.equal(result.intent, "Checks JWT expiry");
  });
});

describe("extractReasoning — picks up OPENAI_API_KEY (network error → fallback)", () => {
  let snap: EnvSnapshot;
  before(() => {
    snap = snapshotEnv();
    clearAll();
    process.env["OPENAI_API_KEY"] = "sk-test-fake-openai-key";
  });
  after(() => restoreEnv(snap));

  test("absorbs fetch error and returns diff-inference fallback", async () => {
    const result = await extractReasoning("src/payments/stripe.ts", {
      note: "Processes Stripe webhook",
    });
    assert.equal(result.extractionMethod, "diff-inference");
    assert.equal(result.intent, "Processes Stripe webhook");
  });
});

describe("extractReasoning — session hint biases provider (network error → fallback)", () => {
  let snap: EnvSnapshot;
  before(() => {
    snap = snapshotEnv();
    clearAll();
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test-fake";
    process.env["OPENAI_API_KEY"] = "sk-test-fake-openai";
  });
  after(() => restoreEnv(snap));

  test("openai session hint picks OPENAI_API_KEY (absorbs network error)", async () => {
    const result = await extractReasoning("src/db/query.ts", {
      sessionProviderHint: "openai",
      sessionModel: "gpt-4o",
      note: "Runs a parameterised SQL query",
    });
    assert.equal(result.extractionMethod, "diff-inference");
    assert.equal(result.intent, "Runs a parameterised SQL query");
  });

  test("anthropic session hint picks ANTHROPIC_API_KEY (absorbs network error)", async () => {
    const result = await extractReasoning("src/db/query.ts", {
      sessionProviderHint: "anthropic",
      sessionModel: "claude-3-5-sonnet-20241022",
      note: "Runs a parameterised SQL query",
    });
    assert.equal(result.extractionMethod, "diff-inference");
    assert.equal(result.intent, "Runs a parameterised SQL query");
  });
});
