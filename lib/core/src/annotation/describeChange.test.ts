// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { describeChange, extractSymbols, fileRole } from "./describeChange.js";

describe("fileRole", () => {
  test("classifies by path", () => {
    assert.equal(fileRole("src/auth/session.test.ts"), "test");
    assert.equal(fileRole("package.json"), "config");
    assert.equal(fileRole("tsconfig.json"), "config");
    assert.equal(fileRole("vite.config.ts"), "config");
    assert.equal(fileRole("README.md"), "docs");
    assert.equal(fileRole(".github/workflows/ci.yml"), "ci");
    assert.equal(fileRole("lib/core/dist/index.d.ts"), "types");
    assert.equal(fileRole("app.css"), "styles");
    assert.equal(fileRole("db/migrations/001_init.sql"), "schema");
    assert.equal(fileRole("src/auth/session.ts"), "source");
  });
});

describe("extractSymbols", () => {
  test("pulls function/class/const/type names from added lines", () => {
    const lines = [
      "export function rotateToken(id: string) {",
      "  const next = mint();",
      "}",
      "export class SessionManager {}",
      "type Verdict = { ok: boolean };",
    ];
    const syms = extractSymbols(lines);
    assert.ok(syms.includes("rotateToken"));
    assert.ok(syms.includes("SessionManager"));
    assert.equal(syms.length <= 3, true);
  });

  test("returns [] when no definitions", () => {
    assert.deepEqual(extractSymbols(["  x += 1;", "  return y;"]), []);
  });
});

describe("describeChange", () => {
  test("names added symbols in a source file", () => {
    const out = describeChange({ filePath: "src/auth/session.ts", addedSymbols: ["rotateToken"], hunkCount: 2 });
    assert.equal(out, "Added `rotateToken` in session.ts");
  });

  test("test files get a test-specific phrase", () => {
    const out = describeChange({ filePath: "src/auth/session.test.ts", addedSymbols: [], hunkCount: 1 });
    assert.match(out, /Adjusted tests in session\.test\.ts/);
  });

  test("config / docs / schema get role phrases", () => {
    assert.match(describeChange({ filePath: "package.json", hunkCount: 1 }), /Updated configuration in package\.json/);
    assert.match(describeChange({ filePath: "README.md", hunkCount: 3 }), /Edited documentation in README\.md \(3 hunks\)/);
    assert.match(describeChange({ filePath: "db/schema/users.ts", hunkCount: 1 }), /Changed the schema in users\.ts/);
  });

  test("source file with a nearest heading names it", () => {
    const out = describeChange({ filePath: "src/x.ts", hunkCount: 1, nearestHeading: "processBatch" });
    assert.equal(out, "Modified `processBatch` in x.ts");
  });

  test("source file with no signals still describes size", () => {
    assert.equal(describeChange({ filePath: "src/x.ts", hunkCount: 2 }), "Modified x.ts — 2 hunks");
  });
});
