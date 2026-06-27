// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ContextEntrySchema,
  IndexFileSchema,
  SCHEMA_VERSION,
} from "./context-entry.schema.js";

const VALID_ENTRY = {
  schemaVersion: "1.1.0" as const,
  id: "550e8400-e29b-41d4-a716-446655440000",
  filePath: "src/auth/login.ts",
  astAnchor: {
    kind: "function" as const,
    name: "validateToken",
    blockHash: "abc123def456",
  },
  contentHash: "sha256hashvalue",
  lineRange: { start: 10, end: 25 },
  note: "AI-generated JWT validation — reviewed and approved by @alice.",
  author: "alice",
  createdAt: "2024-01-15T10:30:00.000Z",
  updatedAt: "2024-01-15T10:30:00.000Z",
  severity: "high" as const,
  tags: ["ai-generated", "auth", "security"],
  source: "ai" as const,
  confidence: 0.92,
  status: "mapped" as const,
  reviewRequired: true,
};

describe("ContextEntrySchema", () => {
  test("accepts a fully valid entry", () => {
    const result = ContextEntrySchema.safeParse(VALID_ENTRY);
    assert.equal(result.success, true);
  });

  test("accepts a null astAnchor", () => {
    const entry = { ...VALID_ENTRY, astAnchor: null };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, true);
  });

  test("rejects wrong schemaVersion", () => {
    const entry = { ...VALID_ENTRY, schemaVersion: "2.0.0" };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("rejects missing schemaVersion", () => {
    const { schemaVersion: _, ...entry } = VALID_ENTRY;
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("rejects invalid UUID", () => {
    const entry = { ...VALID_ENTRY, id: "not-a-uuid" };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("rejects filePath with '..' traversal", () => {
    const entry = { ...VALID_ENTRY, filePath: "../../etc/passwd" };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("rejects empty filePath", () => {
    const entry = { ...VALID_ENTRY, filePath: "" };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("rejects confidence > 1", () => {
    const entry = { ...VALID_ENTRY, confidence: 1.5 };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("rejects confidence < 0", () => {
    const entry = { ...VALID_ENTRY, confidence: -0.1 };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("rejects invalid severity", () => {
    const entry = { ...VALID_ENTRY, severity: "extreme" };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("rejects invalid source", () => {
    const entry = { ...VALID_ENTRY, source: "copilot" };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("rejects invalid status", () => {
    const entry = { ...VALID_ENTRY, status: "lost" };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("rejects lineRange where end < start", () => {
    const entry = { ...VALID_ENTRY, lineRange: { start: 20, end: 10 } };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("rejects lineRange with line number 0", () => {
    const entry = { ...VALID_ENTRY, lineRange: { start: 0, end: 5 } };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("rejects empty note", () => {
    const entry = { ...VALID_ENTRY, note: "" };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("rejects empty author", () => {
    const entry = { ...VALID_ENTRY, author: "" };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("rejects tags array with empty string element", () => {
    const entry = { ...VALID_ENTRY, tags: ["valid", ""] };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, false);
  });

  test("accepts tags as empty array", () => {
    const entry = { ...VALID_ENTRY, tags: [] };
    const result = ContextEntrySchema.safeParse(entry);
    assert.equal(result.success, true);
  });
});

describe("IndexFileSchema", () => {
  test("accepts a valid index with entries", () => {
    const index = {
      schemaVersion: SCHEMA_VERSION,
      entries: ["550e8400-e29b-41d4-a716-446655440000"],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const result = IndexFileSchema.safeParse(index);
    assert.equal(result.success, true);
  });

  test("accepts a valid empty index", () => {
    const index = {
      schemaVersion: SCHEMA_VERSION,
      entries: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const result = IndexFileSchema.safeParse(index);
    assert.equal(result.success, true);
  });

  test("rejects wrong schemaVersion", () => {
    const index = {
      schemaVersion: "0.9.0",
      entries: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const result = IndexFileSchema.safeParse(index);
    assert.equal(result.success, false);
  });
});
