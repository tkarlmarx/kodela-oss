// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatBlameResult } from "./blame.js";
import type { BlameResult } from "./blame.js";

describe("formatBlameResult", () => {
  test("returns no data message for empty lines", () => {
    const result: BlameResult = { filePath: "auth.ts", lines: [] };
    const msg = formatBlameResult(result);
    assert.ok(msg.includes("No blame data available"));
    assert.ok(msg.includes("auth.ts"));
  });

  test("formats lines with commit, author, and content", () => {
    const result: BlameResult = {
      filePath: "auth.ts",
      lines: [
        {
          lineNum: 1,
          content: "export function login() {",
          commit: "abc12345",
          author: "alice",
          entry: undefined,
        },
      ],
    };
    const msg = formatBlameResult(result);
    assert.ok(msg.includes("abc12345"));
    assert.ok(msg.includes("alice"));
    assert.ok(msg.includes("export function login"));
  });

  test("shows annotation marker when line has context entry", () => {
    const result: BlameResult = {
      filePath: "auth.ts",
      lines: [
        {
          lineNum: 1,
          content: "const token = validateToken(input);",
          commit: "abc12345",
          author: "alice",
          entry: {
            schemaVersion: "1.1.0",
            id: "550e8400-e29b-41d4-a716-446655440000",
            filePath: "auth.ts",
            astAnchor: null,
            contentHash: "a".repeat(64),
            lineRange: { start: 1, end: 1 },
            note: "Critical auth check",
            author: "alice",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            severity: "critical",
            tags: [],
            source: "human",
            confidence: 0.95,
            status: "mapped",
            reviewRequired: false,
          },
        },
      ],
    };
    const msg = formatBlameResult(result);
    assert.ok(msg.includes("⚑"));
    assert.ok(msg.includes("Critical auth check"));
  });
});
