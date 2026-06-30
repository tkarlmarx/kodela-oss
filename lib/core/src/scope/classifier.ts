// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { z } from "zod";

export const CODE_SCOPES = [
  "auth",
  "db",
  "infra",
  "ui",
  "api",
  "payments",
  "crypto",
  "config",
  "test",
  "general",
] as const;

export type CodeScope = (typeof CODE_SCOPES)[number];

/**
 * Gap 57 — Typed Zod schema for the CodeScope enum.
 * Replaces the loose `z.string().optional()` placeholder on ContextEntry.scope.
 */
export const CodeScopeSchema = z.enum(CODE_SCOPES);

/**
 * Scopes that are considered security-sensitive for risk classification
 * and policy enforcement. Used by classify.ts and the policy engine.
 */
export const SENSITIVE_SCOPES: ReadonlySet<CodeScope> = new Set([
  "auth",
  "db",
  "crypto",
  "payments",
  "infra",
]);

const PATH_RULES: Array<{ pattern: RegExp; scope: CodeScope }> = [
  {
    pattern:
      /\/(auth(?:entication|orization)?|oauth|sso|jwt|login|logout|session|token|credential|password)/i,
    scope: "auth",
  },
  {
    pattern: /\/(payment|billing|stripe|checkout|invoice|subscription|pricing)/i,
    scope: "payments",
  },
  {
    pattern:
      /\/(crypto|encrypt(?:ion)?|decrypt|cipher|hashing|hmac|pgp|secret|security)/i,
    scope: "crypto",
  },
  {
    pattern:
      /\/(db|database|schema|migrat(?:ion)?|model|repository|dao|orm|query|sql)/i,
    scope: "db",
  },
  {
    pattern:
      /\/(api|route|handler|endpoint|controller|middleware|rest|graphql|webhook)/i,
    scope: "api",
  },
  {
    pattern: /\/(ui|component|view|page|layout|screen|modal|widget|style|theme)/i,
    scope: "ui",
  },
  {
    pattern:
      /\/(infra|deploy(?:ment)?|docker|kubernetes|k8s|terraform|helm|pipeline)/i,
    scope: "infra",
  },
  {
    pattern: /\/(config|setting|env|feature[_-]flag)/i,
    scope: "config",
  },
  {
    pattern: /\/(test|spec|__tests?__|__specs?__|fixtures?|mocks?)|\.(test|spec)\./i,
    scope: "test",
  },
];

const SYMBOL_RULES: Array<{ pattern: RegExp; scope: CodeScope }> = [
  {
    pattern:
      /^(?:verify|authenticate|authorize|login|logout|signIn|signOut|refreshToken|createSession|parseToken)/i,
    scope: "auth",
  },
  {
    pattern:
      /^(?:charge|pay|refund|createSubscription|processPayment|createInvoice|stripeWebhook)/i,
    scope: "payments",
  },
  {
    pattern:
      /^(?:encrypt|decrypt|hash|sign|verifySignature|generateKey|deriveKey|createHmac)/i,
    scope: "crypto",
  },
  {
    pattern:
      /^(?:query|insert|update|delete|upsert|findById|findAll|migrate|createTable|dropTable)/i,
    scope: "db",
  },
  {
    pattern: /^(?:handle|routeTo|controller|applyMiddleware|createEndpoint|apiClient)/i,
    scope: "api",
  },
  {
    pattern: /^(?:render|[A-Z]\w+Component|[A-Z]\w+Page|[A-Z]\w+Screen|[A-Z]\w+Modal)/,
    scope: "ui",
  },
  {
    pattern:
      /^(?:deploy|provision|scale|buildImage|runPipeline|createCluster|applyTerraform)/i,
    scope: "infra",
  },
  {
    pattern: /^(?:getConfig|loadConfig|getEnv|isFeatureEnabled|loadSettings|parseEnv)/i,
    scope: "config",
  },
  {
    pattern: /^(?:describe|it|test|expect|assert|beforeEach|afterEach|beforeAll|afterAll)/i,
    scope: "test",
  },
];

const NOTE_RULES: Array<{ keywords: string[]; scope: CodeScope }> = [
  {
    keywords: [
      "auth",
      "authentication",
      "authorization",
      "login",
      "session",
      "jwt",
      "oauth",
      "sso",
    ],
    scope: "auth",
  },
  {
    keywords: [
      "payment",
      "billing",
      "stripe",
      "checkout",
      "subscription",
      "invoice",
    ],
    scope: "payments",
  },
  {
    keywords: [
      "crypto",
      "encrypt",
      "decrypt",
      "hash",
      "cipher",
      "key derivation",
      "secret",
    ],
    scope: "crypto",
  },
  {
    keywords: ["database", "query", "sql", "migration", "schema", "orm", "db"],
    scope: "db",
  },
  {
    keywords: [
      "api",
      "endpoint",
      "route",
      "rest",
      "graphql",
      "http",
      "request",
      "response",
    ],
    scope: "api",
  },
  {
    keywords: [
      "ui",
      "component",
      "render",
      "frontend",
      "react",
      "vue",
      "angular",
      "css",
      "layout",
    ],
    scope: "ui",
  },
  {
    keywords: [
      "infra",
      "infrastructure",
      "deploy",
      "kubernetes",
      "docker",
      "terraform",
      "ci/cd",
      "pipeline",
    ],
    scope: "infra",
  },
  {
    keywords: [
      "config",
      "configuration",
      "settings",
      "environment variable",
      "feature flag",
    ],
    scope: "config",
  },
  {
    keywords: [
      "test",
      "testing",
      "spec",
      "mock",
      "fixture",
      "assertion",
      "unit test",
      "integration test",
    ],
    scope: "test",
  },
];

/**
 * Gap 57 — Scope Auto-Classification.
 *
 * Classifies a code location into one of the ten `CodeScope` categories using
 * three prioritised signals evaluated in order:
 *
 *   1. File path regex  — highest confidence; matched against the normalised path.
 *   2. Symbol name regex — matched when a symbol name (e.g. function name) is known.
 *   3. Note keyword     — lowest confidence; keyword scan of the annotation note text.
 *
 * Falls back to `"general"` when no signal matches.
 *
 * Pure function — no I/O, no side effects.
 */
export function classifyScope(
  filePath: string,
  symbolName?: string,
  note?: string,
): CodeScope {
  const normalizedPath = filePath.toLowerCase().replace(/\\/g, "/");

  for (const rule of PATH_RULES) {
    if (rule.pattern.test(normalizedPath)) {
      return rule.scope;
    }
  }

  if (symbolName) {
    for (const rule of SYMBOL_RULES) {
      if (rule.pattern.test(symbolName)) {
        return rule.scope;
      }
    }
  }

  if (note) {
    const lowerNote = note.toLowerCase();
    for (const rule of NOTE_RULES) {
      if (rule.keywords.some((kw) => lowerNote.includes(kw))) {
        return rule.scope;
      }
    }
  }

  return "general";
}
