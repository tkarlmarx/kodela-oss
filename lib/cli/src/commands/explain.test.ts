// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runExplain, formatExplainResult, formatExplainShare } from "./explain.js";
import { runInit } from "./init.js";
import { runAdd } from "./add.js";

describe("runExplain", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-explain-test-"));
    await fs.writeFile(path.join(tmpDir, "auth.ts"), "export function login() {}\n");
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "auth.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Login function",
      severity: "high",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns entries for a specific file", async () => {
    const result = await runExplain({ repoRoot: tmpDir, filePath: "auth.ts" });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.note, "Login function");
  });

  test("returns empty array for unknown file", async () => {
    const result = await runExplain({ repoRoot: tmpDir, filePath: "notexist.ts" });
    assert.equal(result.entries.length, 0);
  });

  test("filters by line number when provided", async () => {
    const result = await runExplain({ repoRoot: tmpDir, filePath: "auth.ts", line: 1 });
    assert.equal(result.entries.length, 1);

    const noMatch = await runExplain({ repoRoot: tmpDir, filePath: "auth.ts", line: 99 });
    assert.equal(noMatch.entries.length, 0);
  });

  test("normalizes file path with leading ./", async () => {
    const result = await runExplain({ repoRoot: tmpDir, filePath: "./auth.ts" });
    assert.equal(result.entries.length, 1);
  });
});

describe("formatExplainResult", () => {
  test("shows no entries message when empty", () => {
    const msg = formatExplainResult({ entries: [], filePath: "auth.ts" }, "text");
    assert.ok(msg.includes("No context entries found"));
  });
});

describe("formatExplainShare", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-share-test-"));
    await fs.writeFile(path.join(tmpDir, "auth.ts"), "export function login() {}\n");
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "auth.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Login function — token rotation lives here",
      severity: "high",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("renders a pasteable markdown snippet with heading, note and footer", async () => {
    const result = await runExplain({ repoRoot: tmpDir, filePath: "auth.ts" });
    const md = formatExplainShare(result);
    assert.match(md, /## Why this changed — `auth\.ts`/);
    assert.match(md, /token rotation lives here/);
    assert.match(md, /high · human/);
    assert.match(md, /Captured with \[Kodela\]/);
    assert.match(md, /1 note\./);
  });

  test("is safe to paste even with no captured context", () => {
    const md = formatExplainShare({ entries: [], filePath: "empty.ts" });
    assert.match(md, /## Why this changed — `empty\.ts`/);
    assert.match(md, /No captured context yet/);
  });
});
