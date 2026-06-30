// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parsePatchHunks, findAnnotationsInDiff } from "./index.js";
import type { ParsedDiff } from "./index.js";
import type { ContextEntry } from "../schema/index.js";

const SCHEMA_VERSION = "1.1.0";

function makeEntry(overrides: Partial<ContextEntry> & {
  id: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
}): ContextEntry {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: overrides.id,
    filePath: overrides.filePath,
    astAnchor: null,
    contentHash: "abc123",
    lineRange: { start: overrides.lineStart, end: overrides.lineEnd },
    note: overrides.note ?? "Test annotation",
    author: overrides.author ?? "alice",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    severity: overrides.severity ?? "low",
    tags: [],
    source: overrides.source ?? "human",
    confidence: overrides.confidence ?? 0.9,
    status: overrides.status ?? "mapped",
    reviewRequired: overrides.reviewRequired ?? false,
  };
}

describe("parsePatchHunks", () => {
  test("parses a standard hunk header", () => {
    const patch = "@@ -10,5 +12,8 @@ function foo() {";
    const hunks = parsePatchHunks(patch);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newStart, 12);
    assert.equal(hunks[0].newLines, 8);
  });

  test("defaults newLines to 1 when omitted from header", () => {
    const patch = "@@ -0,0 +1 @@";
    const hunks = parsePatchHunks(patch);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newStart, 1);
    assert.equal(hunks[0].newLines, 1);
  });

  test("parses multiple hunk headers from a single patch", () => {
    const patch = [
      "@@ -1,3 +1,4 @@ some context",
      " unchanged",
      "+new line",
      " unchanged",
      "@@ -20,5 +21,3 @@",
      " more context",
    ].join("\n");
    const hunks = parsePatchHunks(patch);
    assert.equal(hunks.length, 2);
    assert.equal(hunks[0].newStart, 1);
    assert.equal(hunks[0].newLines, 4);
    assert.equal(hunks[1].newStart, 21);
    assert.equal(hunks[1].newLines, 3);
  });

  test("returns empty array for empty patch", () => {
    assert.deepEqual(parsePatchHunks(""), []);
  });

  test("returns empty array for patch with no hunk headers", () => {
    const patch = "diff --git a/foo.ts b/foo.ts\nindex abc..def 100644";
    assert.deepEqual(parsePatchHunks(patch), []);
  });

  test("handles +0,0 hunk (file deletion / empty addition)", () => {
    const patch = "@@ -5,3 +5,0 @@";
    const hunks = parsePatchHunks(patch);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].newStart, 5);
    assert.equal(hunks[0].newLines, 0);
  });
});

describe("findAnnotationsInDiff", () => {
  const DIFF: ParsedDiff[] = [
    {
      filePath: "src/auth/login.ts",
      hunks: [
        { newStart: 10, newLines: 8 },  // lines 10–17
        { newStart: 30, newLines: 5 },  // lines 30–34
      ],
    },
    {
      filePath: "src/utils/helpers.ts",
      hunks: [
        { newStart: 1, newLines: 20 }, // lines 1–20
      ],
    },
  ];

  test("returns empty array when entries is empty", () => {
    assert.deepEqual(findAnnotationsInDiff(DIFF, []), []);
  });

  test("returns empty array when diff is empty", () => {
    const entry = makeEntry({
      id: "11111111-1111-1111-1111-111111111111",
      filePath: "src/auth/login.ts",
      lineStart: 10,
      lineEnd: 12,
    });
    assert.deepEqual(findAnnotationsInDiff([], [entry]), []);
  });

  test("matches entry whose lineRange overlaps a hunk", () => {
    const entry = makeEntry({
      id: "11111111-1111-1111-1111-111111111111",
      filePath: "src/auth/login.ts",
      lineStart: 12,
      lineEnd: 15,
    });
    const result = findAnnotationsInDiff(DIFF, [entry]);
    assert.equal(result.length, 1);
    assert.equal(result[0].entry.id, entry.id);
    assert.equal(result[0].filePath, "src/auth/login.ts");
    assert.equal(result[0].hunkLine, 12);
  });

  test("matches entry that starts before the hunk but overlaps", () => {
    const entry = makeEntry({
      id: "22222222-2222-2222-2222-222222222222",
      filePath: "src/auth/login.ts",
      lineStart: 8,
      lineEnd: 11,
    });
    const result = findAnnotationsInDiff(DIFF, [entry]);
    assert.equal(result.length, 1);
    assert.equal(result[0].hunkLine, 10); // clamped to hunk start
  });

  test("does not match entry whose lineRange is entirely before the hunk", () => {
    const entry = makeEntry({
      id: "33333333-3333-3333-3333-333333333333",
      filePath: "src/auth/login.ts",
      lineStart: 1,
      lineEnd: 9,
    });
    assert.deepEqual(findAnnotationsInDiff(DIFF, [entry]), []);
  });

  test("does not match entry whose lineRange is entirely after all hunks", () => {
    const entry = makeEntry({
      id: "44444444-4444-4444-4444-444444444444",
      filePath: "src/auth/login.ts",
      lineStart: 40,
      lineEnd: 50,
    });
    assert.deepEqual(findAnnotationsInDiff(DIFF, [entry]), []);
  });

  test("does not match entry in a file not in the diff", () => {
    const entry = makeEntry({
      id: "55555555-5555-5555-5555-555555555555",
      filePath: "src/payments/processor.ts",
      lineStart: 1,
      lineEnd: 10,
    });
    assert.deepEqual(findAnnotationsInDiff(DIFF, [entry]), []);
  });

  test("each entry appears at most once even if it overlaps multiple hunks", () => {
    const entry = makeEntry({
      id: "66666666-6666-6666-6666-666666666666",
      filePath: "src/auth/login.ts",
      lineStart: 10,
      lineEnd: 35,  // spans both hunks (10-17 and 30-34)
    });
    const result = findAnnotationsInDiff(DIFF, [entry]);
    assert.equal(result.length, 1);
  });

  test("matches entries in different diff files independently", () => {
    const e1 = makeEntry({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      filePath: "src/auth/login.ts",
      lineStart: 10,
      lineEnd: 12,
    });
    const e2 = makeEntry({
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      filePath: "src/utils/helpers.ts",
      lineStart: 5,
      lineEnd: 10,
    });
    const result = findAnnotationsInDiff(DIFF, [e1, e2]);
    assert.equal(result.length, 2);
  });

  test("skips zero-line hunks (deletions with newLines=0)", () => {
    const diffWithDeletion: ParsedDiff[] = [
      {
        filePath: "src/auth/login.ts",
        hunks: [{ newStart: 10, newLines: 0 }],
      },
    ];
    const entry = makeEntry({
      id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      filePath: "src/auth/login.ts",
      lineStart: 10,
      lineEnd: 10,
    });
    assert.deepEqual(findAnnotationsInDiff(diffWithDeletion, [entry]), []);
  });

  test("entry touching exactly the first hunk line is matched", () => {
    const entry = makeEntry({
      id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      filePath: "src/auth/login.ts",
      lineStart: 17,
      lineEnd: 17,
    });
    const result = findAnnotationsInDiff(DIFF, [entry]);
    assert.equal(result.length, 1);
    assert.equal(result[0].hunkLine, 17);
  });
});
