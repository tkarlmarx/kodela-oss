// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyScope, SENSITIVE_SCOPES, CODE_SCOPES } from "./classifier.js";
import type { CodeScope } from "./classifier.js";

describe("classifyScope — Signal 1: file path", () => {
  it("classifies auth paths", () => {
    assert.equal(classifyScope("src/auth/login.ts"), "auth");
    assert.equal(classifyScope("lib/authentication/session.ts"), "auth");
    assert.equal(classifyScope("services/oauth/callback.ts"), "auth");
    assert.equal(classifyScope("api/jwt/verify.ts"), "auth");
  });

  it("classifies payments paths", () => {
    assert.equal(classifyScope("src/payments/processor.ts"), "payments");
    assert.equal(classifyScope("lib/billing/invoice.ts"), "payments");
    assert.equal(classifyScope("services/stripe/webhook.ts"), "payments");
  });

  it("classifies crypto paths", () => {
    assert.equal(classifyScope("src/crypto/cipher.ts"), "crypto");
    assert.equal(classifyScope("lib/security/hash.ts"), "crypto");
    assert.equal(classifyScope("utils/encryption/aes.ts"), "crypto");
  });

  it("classifies db paths", () => {
    assert.equal(classifyScope("src/db/connection.ts"), "db");
    assert.equal(classifyScope("lib/database/schema.ts"), "db");
    assert.equal(classifyScope("src/migrations/001_create_users.ts"), "db");
    assert.equal(classifyScope("src/models/user.ts"), "db");
  });

  it("classifies api paths", () => {
    assert.equal(classifyScope("src/api/users.ts"), "api");
    assert.equal(classifyScope("lib/routes/index.ts"), "api");
    assert.equal(classifyScope("handlers/webhook.ts"), "api");
  });

  it("classifies ui paths", () => {
    assert.equal(classifyScope("src/ui/Button.tsx"), "ui");
    assert.equal(classifyScope("src/components/Modal.tsx"), "ui");
    assert.equal(classifyScope("src/pages/home.tsx"), "ui");
  });

  it("classifies infra paths", () => {
    assert.equal(classifyScope("infra/terraform/main.tf"), "infra");
    assert.equal(classifyScope("deploy/kubernetes/deployment.yaml"), "infra");
    assert.equal(classifyScope("docker/Dockerfile"), "infra");
  });

  it("classifies config paths", () => {
    assert.equal(classifyScope("src/config/app.ts"), "config");
    assert.equal(classifyScope("lib/settings/feature_flag.ts"), "config");
  });

  it("classifies test paths", () => {
    assert.equal(classifyScope("src/utils/string.test.ts"), "test");
    assert.equal(classifyScope("src/__tests__/user.ts"), "test");
    assert.equal(classifyScope("src/spec/user.spec.ts"), "test");
  });

  it("falls back to general for unrecognised paths", () => {
    assert.equal(classifyScope("src/utils/string.ts"), "general");
    assert.equal(classifyScope("lib/helpers/math.ts"), "general");
    assert.equal(classifyScope("index.ts"), "general");
  });

  it("is case-insensitive for paths", () => {
    assert.equal(classifyScope("SRC/AUTH/LOGIN.TS"), "auth");
    assert.equal(classifyScope("Lib/Payments/Processor.ts"), "payments");
  });
});

describe("classifyScope — Signal 2: symbol name", () => {
  it("classifies auth symbols when path does not match", () => {
    assert.equal(classifyScope("src/utils/helpers.ts", "authenticate"), "auth");
    assert.equal(classifyScope("src/utils/helpers.ts", "refreshToken"), "auth");
    assert.equal(classifyScope("src/utils/helpers.ts", "signIn"), "auth");
  });

  it("classifies payments symbols when path does not match", () => {
    assert.equal(classifyScope("src/utils/helpers.ts", "processPayment"), "payments");
    assert.equal(classifyScope("src/utils/helpers.ts", "createSubscription"), "payments");
  });

  it("classifies crypto symbols when path does not match", () => {
    assert.equal(classifyScope("src/utils/helpers.ts", "encrypt"), "crypto");
    assert.equal(classifyScope("src/utils/helpers.ts", "deriveKey"), "crypto");
  });

  it("classifies db symbols when path does not match", () => {
    assert.equal(classifyScope("src/utils/helpers.ts", "findById"), "db");
    assert.equal(classifyScope("src/utils/helpers.ts", "migrate"), "db");
  });

  it("path signal takes precedence over symbol when both match", () => {
    assert.equal(classifyScope("src/auth/login.ts", "findById"), "auth");
  });

  it("symbol fallback is ignored when undefined", () => {
    assert.equal(classifyScope("src/utils/string.ts", undefined), "general");
  });
});

describe("classifyScope — Signal 3: note keyword", () => {
  it("classifies auth notes when path and symbol do not match", () => {
    assert.equal(
      classifyScope("src/utils/helpers.ts", undefined, "This handles the jwt token renewal"),
      "auth",
    );
    assert.equal(
      classifyScope("src/utils/helpers.ts", undefined, "OAuth2 callback handler"),
      "auth",
    );
  });

  it("classifies payments notes when path and symbol do not match", () => {
    assert.equal(
      classifyScope("src/utils/helpers.ts", undefined, "Creates a Stripe subscription"),
      "payments",
    );
  });

  it("classifies db notes when path and symbol do not match", () => {
    assert.equal(
      classifyScope("src/utils/helpers.ts", undefined, "Runs a database migration"),
      "db",
    );
  });

  it("classifies ui notes when path and symbol do not match", () => {
    assert.equal(
      classifyScope("src/utils/helpers.ts", undefined, "Renders a React component"),
      "ui",
    );
  });

  it("falls back to general when no note keyword matches", () => {
    assert.equal(
      classifyScope("src/utils/helpers.ts", undefined, "Utility function for sorting"),
      "general",
    );
  });

  it("path signal takes precedence over note", () => {
    assert.equal(
      classifyScope("src/auth/login.ts", undefined, "Runs a database migration"),
      "auth",
    );
  });
});

describe("SENSITIVE_SCOPES", () => {
  it("includes auth, db, crypto, payments, infra", () => {
    assert.ok(SENSITIVE_SCOPES.has("auth"));
    assert.ok(SENSITIVE_SCOPES.has("db"));
    assert.ok(SENSITIVE_SCOPES.has("crypto"));
    assert.ok(SENSITIVE_SCOPES.has("payments"));
    assert.ok(SENSITIVE_SCOPES.has("infra"));
  });

  it("does not include general, ui, api, config, test", () => {
    const nonSensitive: CodeScope[] = ["general", "ui", "api", "config", "test"];
    for (const s of nonSensitive) {
      assert.ok(!SENSITIVE_SCOPES.has(s), `Expected ${s} not to be sensitive`);
    }
  });
});

describe("CODE_SCOPES", () => {
  it("contains exactly 10 scopes", () => {
    assert.equal(CODE_SCOPES.length, 10);
  });

  it("all scopes are lowercase strings", () => {
    for (const scope of CODE_SCOPES) {
      assert.equal(scope, scope.toLowerCase());
    }
  });

  it("includes all expected values", () => {
    const expected: CodeScope[] = [
      "auth", "db", "infra", "ui", "api", "payments", "crypto", "config", "test", "general",
    ];
    for (const e of expected) {
      assert.ok((CODE_SCOPES as readonly string[]).includes(e), `Missing scope: ${e}`);
    }
  });
});
