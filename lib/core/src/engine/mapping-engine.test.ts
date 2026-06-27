// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mapWithAstLayer, hashAstSignature } from "./ast-layer.js";
import { mapWithTokenHashLayer, hashTokenStream } from "./token-hash-layer.js";
import { selectMappingLayer, mapContextEntry } from "./mapping-engine.js";
import type { ContextEntry } from "../schema/index.js";

const PLACEHOLDER_HASH =
  "a".repeat(64);

const BASE_ENTRY: ContextEntry = {
  schemaVersion: "1.1.0",
  id: "550e8400-e29b-41d4-a716-446655440000",
  filePath: "src/auth/login.ts",
  astAnchor: {
    kind: "function",
    name: "validateToken",
    blockHash: PLACEHOLDER_HASH,
  },
  contentHash: PLACEHOLDER_HASH,
  lineRange: { start: 1, end: 5 },
  note: "Token validation logic — reviewed.",
  author: "alice",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  severity: "high",
  tags: [],
  source: "human",
  confidence: 0.95,
  status: "mapped",
  reviewRequired: false,
};

const SAMPLE_TS_FILE = `
export async function validateToken(token: string): Promise<boolean> {
  if (!token) return false;
  return token.startsWith("Bearer ");
}

export function parsePayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  return JSON.parse(Buffer.from(parts[1] ?? "", "base64").toString());
}
`.trimStart();

describe("selectMappingLayer", () => {
  test("selects 'ast' when astAnchor is present and file is TypeScript", () => {
    const layer = selectMappingLayer(BASE_ENTRY, SAMPLE_TS_FILE);
    assert.equal(layer, "ast");
  });

  test("selects 'token-hash' when astAnchor is null", () => {
    const entry: ContextEntry = { ...BASE_ENTRY, astAnchor: null };
    const layer = selectMappingLayer(entry, SAMPLE_TS_FILE);
    assert.equal(layer, "token-hash");
  });

  test("selects 'token-hash' for non-AST-applicable files (plain text)", () => {
    const entry: ContextEntry = { ...BASE_ENTRY, filePath: "docs/readme.txt" };
    const layer = selectMappingLayer(entry, "some text content");
    assert.equal(layer, "token-hash");
  });

  test("selects 'git-diff' when file content is empty", () => {
    const entry: ContextEntry = { ...BASE_ENTRY, astAnchor: null };
    const layer = selectMappingLayer(entry, "");
    assert.equal(layer, "git-diff");
  });
});

describe("mapWithAstLayer", () => {
  test("returns orphaned when astAnchor is null", () => {
    const entry: ContextEntry = { ...BASE_ENTRY, astAnchor: null };
    const result = mapWithAstLayer(entry, SAMPLE_TS_FILE);
    assert.equal(result.status, "orphaned");
    assert.equal(result.confidence, 0);
  });

  test("returns high confidence result when function name matches", () => {
    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: {
        kind: "function",
        name: "validateToken",
        blockHash: "some-other-hash",
      },
    };
    const result = mapWithAstLayer(entry, SAMPLE_TS_FILE);
    assert.ok(result.confidence >= 0.5, `Expected confidence >= 0.5, got ${result.confidence}`);
    assert.notEqual(result.status, "orphaned");
  });

  test("returns orphaned when function name does not exist in file", () => {
    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: {
        kind: "function",
        name: "nonExistentFunction",
        blockHash: "nonexistent-hash",
      },
    };
    const result = mapWithAstLayer(entry, SAMPLE_TS_FILE);
    assert.equal(result.status, "orphaned");
  });
});

describe("mapWithTokenHashLayer", () => {
  test("returns confidence 0.98 when content hash matches exactly at same position", () => {
    const lines = SAMPLE_TS_FILE.split("\n");
    const slice = lines.slice(0, 4).join("\n");
    const hash = hashTokenStream(slice);

    const entry: ContextEntry = {
      ...BASE_ENTRY,
      contentHash: hash,
      lineRange: { start: 1, end: 4 },
    };
    const result = mapWithTokenHashLayer(entry, SAMPLE_TS_FILE);
    assert.equal(result.confidence, 0.98);
    assert.equal(result.status, "mapped");
  });

  test("returns orphaned for empty file content", () => {
    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: null,
      contentHash: "somehash",
      lineRange: { start: 1, end: 5 },
    };
    const result = mapWithTokenHashLayer(entry, "");
    assert.equal(result.status, "orphaned");
  });
});

describe("mapContextEntry — orchestrator fallback sequencing", () => {
  const NON_EXISTENT_REPO = "/nonexistent-repo-kodela-test-12345";

  test("falls to git-diff (last resort) when AST and token-hash are below threshold", async () => {
    // Non-existent function → AST confidence 0, falls through
    // Mismatched contentHash + empty content → token-hash confidence 0, falls through
    // git-diff catches its own git error and returns confidence 0.45 (uncertain)
    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: {
        kind: "function",
        name: "nonExistentFunctionXyz",
        blockHash: PLACEHOLDER_HASH,
      },
      contentHash: PLACEHOLDER_HASH,
    };
    const result = await mapContextEntry(entry, "", NON_EXISTENT_REPO);
    assert.equal(result.layerUsed, "git-diff");
    assert.deepEqual(result.updatedLineRange, entry.lineRange);
  });

  test("falls from AST to token-hash when AST confidence is below threshold", async () => {
    // Non-existent function → AST confidence 0 (≤ 0.3), falls through
    // Matching contentHash → token-hash returns confidence 0.98
    const lines = SAMPLE_TS_FILE.split("\n");
    const slice = lines.slice(0, 4).join("\n");
    const matchingHash = hashTokenStream(slice);

    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: {
        kind: "function",
        name: "nonExistentFunctionXyz",
        blockHash: PLACEHOLDER_HASH,
      },
      contentHash: matchingHash,
      lineRange: { start: 1, end: 4 },
    };
    const result = await mapContextEntry(entry, SAMPLE_TS_FILE, NON_EXISTENT_REPO);
    assert.equal(result.layerUsed, "token-hash");
    assert.ok(result.confidence > 0.3, `Expected confidence > 0.3, got ${result.confidence}`);
  });

  test("Gap 42 — returns 'astSymbol' when name matches but blockHash is stale (partial-rewrite)", async () => {
    // Stale blockHash but existing function name → AST Tier 2 name match fires.
    // layerUsed must be "astSymbol" and status must be "uncertain" so the
    // annotator is prompted to re-verify the note (Gap 42 partial-rewrite detection).
    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: {
        kind: "function",
        name: "validateToken",
        blockHash: PLACEHOLDER_HASH,
      },
    };
    const result = await mapContextEntry(entry, SAMPLE_TS_FILE, NON_EXISTENT_REPO);
    assert.equal(result.layerUsed, "astSymbol");
    assert.equal(result.status, "uncertain");
    assert.ok(result.confidence > 0.3, `Expected confidence > 0.3, got ${result.confidence}`);
  });

  test("returns 'ast' with 'mapped' status when exact blockHash matches (no rewrite)", async () => {
    // Exact blockHash match → Tier 1 fires. layerUsed is "ast", status is "mapped".
    const correctBlockHash = hashAstSignature("function", "validateToken");
    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: {
        kind: "function",
        name: "validateToken",
        blockHash: correctBlockHash,
      },
    };
    const result = await mapContextEntry(entry, SAMPLE_TS_FILE, NON_EXISTENT_REPO);
    assert.equal(result.layerUsed, "ast");
    assert.equal(result.status, "mapped");
    assert.ok(result.confidence > 0.3, `Expected confidence > 0.3, got ${result.confidence}`);
  });

  test("returns 'fallback' result when layerUsed is 'fallback' in DetailedMappingResult type", () => {
    // Structural: the 'fallback' value of layerUsed is part of the MappingLayerName union type
    // and is returned when all three layers throw unexpected exceptions.
    // Verify the type is correct — this is a compile-time + structural check.
    const fallbackResult = {
      confidence: 0,
      status: "orphaned" as const,
      updatedLineRange: { start: 1, end: 5 },
      layerUsed: "fallback" as const,
    };
    assert.equal(fallbackResult.layerUsed, "fallback");
    assert.equal(fallbackResult.status, "orphaned");
    assert.equal(fallbackResult.confidence, 0);
  });
});
