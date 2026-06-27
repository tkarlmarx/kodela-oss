// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { CodeGraphFunction } from "./types.js";
import {
  ensureFunctionCacheTables,
  hashFileContent,
  readCachedFunctions,
  writeCachedFunctions,
  invalidateOtherHashes,
  countCachedRows,
} from "./function-cache-store.js";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureFunctionCacheTables(db);
  return db;
}

const SAMPLE: CodeGraphFunction[] = [
  {
    name: "topLevel",
    kind: "function",
    startLine: 2,
    endLine: 4,
    language: "typescript",
    ast_anchor: "function:topLevel@2",
  },
  {
    name: "greet",
    kind: "method",
    startLine: 7,
    endLine: 9,
    language: "typescript",
    parent: "Greeter",
    ast_anchor: "method:greet@7",
  },
];

test("ensureFunctionCacheTables is idempotent — safe to call multiple times", () => {
  const db = freshDb();
  ensureFunctionCacheTables(db);
  ensureFunctionCacheTables(db);
  assert.equal(countCachedRows(db), 0);
});

test("hashFileContent is deterministic and content-sensitive", () => {
  const a = hashFileContent("function foo() {}");
  const b = hashFileContent("function foo() {}");
  const c = hashFileContent("function foo() { /* changed */ }");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
});

test("cache miss returns null", () => {
  const db = freshDb();
  assert.equal(readCachedFunctions(db, "src/foo.ts", "deadbeef"), null);
});

test("cache hit returns the exact stored functions", () => {
  const db = freshDb();
  const hash = hashFileContent("source v1");
  writeCachedFunctions(db, "src/foo.ts", hash, SAMPLE);
  const hit = readCachedFunctions(db, "src/foo.ts", hash);
  assert.ok(hit);
  assert.deepEqual(hit, SAMPLE);
});

test("cache miss for the same file under a different hash", () => {
  const db = freshDb();
  const h1 = hashFileContent("source v1");
  const h2 = hashFileContent("source v2");
  writeCachedFunctions(db, "src/foo.ts", h1, SAMPLE);
  assert.equal(readCachedFunctions(db, "src/foo.ts", h2), null);
  assert.deepEqual(readCachedFunctions(db, "src/foo.ts", h1), SAMPLE);
});

test("writing the same key twice overwrites the row, doesn't duplicate", () => {
  const db = freshDb();
  const hash = hashFileContent("source");
  writeCachedFunctions(db, "src/foo.ts", hash, SAMPLE);
  const replacement: CodeGraphFunction[] = [
    { ...SAMPLE[0]!, name: "replaced" },
  ];
  writeCachedFunctions(db, "src/foo.ts", hash, replacement);
  assert.equal(countCachedRows(db, "src/foo.ts"), 1);
  const hit = readCachedFunctions(db, "src/foo.ts", hash);
  assert.equal(hit?.[0]?.name, "replaced");
});

test("invalidateOtherHashes drops stale rows and keeps the current one", () => {
  const db = freshDb();
  writeCachedFunctions(db, "src/foo.ts", "aaa", SAMPLE);
  writeCachedFunctions(db, "src/foo.ts", "bbb", SAMPLE);
  writeCachedFunctions(db, "src/foo.ts", "ccc", SAMPLE);
  writeCachedFunctions(db, "src/bar.ts", "aaa", SAMPLE); // untouched
  assert.equal(countCachedRows(db, "src/foo.ts"), 3);
  const dropped = invalidateOtherHashes(db, "src/foo.ts", "ccc");
  assert.equal(dropped, 2);
  assert.equal(countCachedRows(db, "src/foo.ts"), 1);
  // bar.ts row untouched.
  assert.equal(countCachedRows(db, "src/bar.ts"), 1);
});

test("cache stores empty array faithfully (a file with no functions)", () => {
  const db = freshDb();
  const hash = hashFileContent("// only comments");
  writeCachedFunctions(db, "src/empty.ts", hash, []);
  const hit = readCachedFunctions(db, "src/empty.ts", hash);
  assert.deepEqual(hit, []);
});

test("malformed JSON in the row is treated as a miss, not an exception", () => {
  const db = freshDb();
  // Inject a row with bad JSON directly to simulate corruption.
  db.prepare(
    "INSERT INTO function_cache (file_path, content_hash, functions, created_at) VALUES (?, ?, ?, ?)",
  ).run("src/foo.ts", "deadbeef", "{not json}", new Date().toISOString());
  assert.equal(readCachedFunctions(db, "src/foo.ts", "deadbeef"), null);
});
