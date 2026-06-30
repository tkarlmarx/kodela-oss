// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ContextEntry } from "@kodela/core";
import { resolveEntry } from "./resolve-entry.js";

const ENTRY: ContextEntry = {
  schemaVersion: "1.1.0",
  id: "e1",
  filePath: "src/index.ts",
  lineRange: { start: 10, end: 20 },
  astAnchor: null,
  contentHash: "abc123",
  note: "A test note",
  severity: "high",
  status: "mapped",
  source: "human",
  confidence: 0.9,
  author: "tester",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  tags: [],
  reviewRequired: false,
};

describe("resolveEntry", () => {
  test("returns ContextEntry when passed directly", () => {
    const result = resolveEntry(ENTRY);
    assert.strictEqual(result?.id, "e1");
    assert.strictEqual(result?.note, "A test note");
  });

  test("extracts entry from an EntryNode-like object (.entry property)", () => {
    const entryNode = { entry: ENTRY, label: "✓ L10-20", contextValue: "kodelaEntry" };
    const result = resolveEntry(entryNode);
    assert.strictEqual(result?.id, "e1");
    assert.strictEqual(result?.filePath, "src/index.ts");
  });

  test("returns undefined for null", () => {
    assert.strictEqual(resolveEntry(null), undefined);
  });

  test("returns undefined for undefined", () => {
    assert.strictEqual(resolveEntry(undefined), undefined);
  });

  test("returns undefined for unrelated object", () => {
    assert.strictEqual(resolveEntry({ foo: "bar" }), undefined);
  });

  test("returns undefined for EntryNode-like object whose .entry is not a ContextEntry shape", () => {
    assert.strictEqual(resolveEntry({ entry: { foo: "bar" } }), undefined);
  });

  test("handles the entry field correctly when .entry has all required ContextEntry keys", () => {
    const wrapped = { entry: ENTRY, collapsibleState: 0 };
    const result = resolveEntry(wrapped);
    assert.strictEqual(result?.id, ENTRY.id);
  });
});
