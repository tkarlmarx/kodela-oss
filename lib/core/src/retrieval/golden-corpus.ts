// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * A small seeded golden corpus for the retrieval eval harness (Phase 0).
 *
 * It is deliberately built with "trap" queries: for several queries a distractor
 * doc contains the query terms in its *body* (and sorts earlier by id), while the
 * genuinely relevant doc carries them in a high-signal field (intent/title) or as
 * an exact phrase. A naive lexical baseline that only counts distinct term hits
 * mis-ranks the distractor above the answer; the field-aware feature reranker
 * corrects it. So `retrieval.eval.test.ts` can assert the reranker measurably
 * improves MRR / nDCG — this corpus is the ground truth for that claim.
 *
 * Ids are prefixed so distractors ("a…") sort before the answers ("z…"), which
 * is exactly the tie-break that trips the lexical baseline.
 */
import type { RerankCandidate } from "./rerank.js";
import type { EvalCorpus } from "./eval.js";

const OLD = "2026-01-01T00:00:00.000Z";
const NEW = "2026-06-01T00:00:00.000Z";

const documents: RerankCandidate[] = [
  // ── query: "cache product catalog" ─────────────────────────────────────────
  {
    id: "a-catalog-images",
    text: "cache the product images in the catalog page header for faster paint",
    fields: { tags: ["ui"], filePath: "src/ui/catalog.tsx" },
    kind: "entry",
    createdAt: NEW,
  },
  {
    id: "z-catalog-cache",
    text: "reduce db load by caching catalog lookups for five minutes",
    fields: { title: "Product catalog cache", intent: "Cache the product catalog responses", tags: ["perf"] },
    kind: "decision",
    severity: "medium",
    createdAt: OLD,
  },

  // ── query: "rotate refresh token" ──────────────────────────────────────────
  {
    id: "a-token-logging",
    text: "log every refresh token and rotate the log file daily to keep audit size bounded",
    fields: { tags: ["logging"], filePath: "src/log/rotate.ts" },
    kind: "entry",
    createdAt: NEW,
  },
  {
    id: "z-token-rotation",
    text: "invalidate the previous token id after refresh so a captured token cannot be replayed",
    fields: {
      title: "Rotate refresh token on use",
      intent: "Rotate the refresh token on every refresh",
      tags: ["auth", "security"],
      filePath: "src/auth/session.ts",
    },
    kind: "entry",
    severity: "high",
    createdAt: NEW,
  },

  // ── query: "postgres multi tenant" ─────────────────────────────────────────
  {
    id: "a-tenant-ui",
    text: "show the tenant name in the header for multi workspace users on the postgres status page",
    fields: { tags: ["ui"] },
    kind: "entry",
    createdAt: NEW,
  },
  {
    id: "z-postgres-migration",
    text: "move the store from sqlite to postgres so many tenants share one database safely",
    fields: { title: "Postgres migration", intent: "Migrate to Postgres for multi tenant hosting", tags: ["db"] },
    kind: "decision",
    severity: "high",
    createdAt: OLD,
  },

  // ── query: "tax rounding per line" ─────────────────────────────────────────
  {
    id: "a-rounding-charts",
    text: "round the tax chart axis per tick so the line stays readable on small screens",
    fields: { tags: ["ui"] },
    kind: "entry",
    createdAt: NEW,
  },
  {
    id: "z-tax-rounding",
    text: "avoid sub-cent drift by rounding each line item before summing the tax",
    fields: { title: "Tax rounding per line item", intent: "Round tax per line item", tags: ["billing"] },
    kind: "decision",
    severity: "medium",
    createdAt: OLD,
  },

  // ── unambiguous / filler docs (both retrievers should handle) ──────────────
  {
    id: "z-ed25519",
    text: "chose ed25519 over rsa for signing because of performance on the auth path and smaller keys",
    fields: { title: "ed25519 signing", intent: "Choose ed25519 over RSA for signing", tags: ["auth", "crypto"] },
    kind: "decision",
    severity: "medium",
    createdAt: OLD,
  },
  {
    id: "z-redis-sessions",
    text: "store sessions in redis to share session state across many app instances",
    fields: { intent: "Store sessions in Redis", tags: ["infra", "session"] },
    kind: "entry",
    createdAt: NEW,
  },
  {
    id: "z-flaky-checkout",
    text: "the checkout test intermittently failed due to a timing race in the payment mock",
    fields: { intent: "Fix flaky checkout test", tags: ["test", "checkout"] },
    kind: "entry",
    createdAt: NEW,
  },
  {
    id: "z-lazy-charts",
    text: "lazy load the dashboard charts to improve initial load time",
    fields: { intent: "Improve dashboard load time", tags: ["perf", "ui"] },
    kind: "entry",
    createdAt: NEW,
  },
];

export const GOLDEN_CORPUS: EvalCorpus = {
  name: "kodela-why-golden-v1",
  documents,
  queries: [
    { id: "q-catalog", query: "cache product catalog", relevant: { "z-catalog-cache": 3 } },
    { id: "q-token", query: "rotate refresh token", relevant: { "z-token-rotation": 3 } },
    { id: "q-postgres", query: "postgres multi tenant", relevant: { "z-postgres-migration": 3 } },
    { id: "q-tax", query: "tax rounding per line", relevant: { "z-tax-rounding": 3 } },
    { id: "q-signing", query: "ed25519 signing decision", relevant: { "z-ed25519": 3 } },
    { id: "q-sessions", query: "redis session sharing", relevant: { "z-redis-sessions": 3 } },
  ],
};
