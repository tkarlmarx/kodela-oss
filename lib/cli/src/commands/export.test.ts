// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runExport, formatExportResult } from "./export.js";
import { runInit } from "./init.js";
import { runAdd } from "./add.js";

describe("runExport — repo scope", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-export-test-"));
    await fs.writeFile(path.join(tmpDir, "auth.ts"), "export function login() {}\n");
    await fs.mkdir(path.join(tmpDir, "lib"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "lib", "utils.ts"), "export function noop() {}\n");
    await runInit(tmpDir);

    await runAdd({
      repoRoot: tmpDir,
      filePath: "auth.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Login function — high risk",
      severity: "high",
      source: "human",
    });

    await runAdd({
      repoRoot: tmpDir,
      filePath: "lib/utils.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Low severity utility",
      severity: "low",
      source: "human",
    });

    await runAdd({
      repoRoot: tmpDir,
      filePath: "auth.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Critical auth bypass risk",
      severity: "critical",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns all entries for repo scope", async () => {
    const result = await runExport({ repoRoot: tmpDir, repo: true });
    assert.equal(result.scope, "repo");
    assert.equal(result.totalEntries, 3);
    assert.equal(result.entries.length, 3);
    assert.equal(result.truncated, false);
  });

  test("defaults to repo scope when no target given", async () => {
    const result = await runExport({ repoRoot: tmpDir });
    assert.equal(result.scope, "repo");
    assert.equal(result.totalEntries, 3);
  });

  test("priority-ranks entries: critical before high before low", async () => {
    const result = await runExport({ repoRoot: tmpDir, repo: true });
    const severities = result.entries.map((e) => e.severity);
    assert.equal(severities[0], "critical");
    assert.equal(severities[1], "high");
    assert.equal(severities[2], "low");
  });

  test("token budget truncates lower-priority entries", async () => {
    const result = await runExport({ repoRoot: tmpDir, repo: true, maxTokens: 30 });
    assert.ok(result.truncated, "expected truncation with tight token budget");
    assert.ok(result.entries.length < result.totalEntries, "fewer entries than total");
    assert.ok(result.tokenEstimate <= 30, "token estimate within budget");
  });

  test("tokenEstimate is zero when nothing fits the budget", async () => {
    const result = await runExport({ repoRoot: tmpDir, repo: true, maxTokens: 1 });
    assert.equal(result.entries.length, 0);
    assert.equal(result.tokenEstimate, 0);
  });

  test("returns correct tokenEstimate without budget cap", async () => {
    const result = await runExport({ repoRoot: tmpDir, repo: true });
    assert.ok(typeof result.tokenEstimate === "number");
    assert.ok(result.tokenEstimate > 0);
  });
});

describe("runExport — file scope", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-export-file-"));
    await fs.writeFile(path.join(tmpDir, "auth.ts"), "export function login() {}\n");
    await fs.mkdir(path.join(tmpDir, "lib"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "lib", "utils.ts"), "export function noop() {}\n");
    await runInit(tmpDir);

    await runAdd({
      repoRoot: tmpDir,
      filePath: "auth.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Auth entry",
      severity: "high",
      source: "human",
    });

    await runAdd({
      repoRoot: tmpDir,
      filePath: "lib/utils.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Util entry",
      severity: "low",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("filters to a single file", async () => {
    const result = await runExport({ repoRoot: tmpDir, target: "auth.ts" });
    assert.equal(result.scope, "file");
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.note, "Auth entry");
  });

  test("returns empty for unknown file", async () => {
    const result = await runExport({ repoRoot: tmpDir, target: "missing.ts" });
    assert.equal(result.entries.length, 0);
    assert.equal(result.totalEntries, 0);
    assert.equal(result.truncated, false);
  });

  test("filters to a directory", async () => {
    const result = await runExport({ repoRoot: tmpDir, target: "lib" });
    assert.equal(result.scope, "directory");
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.note, "Util entry");
  });
});

describe("formatExportResult", () => {
  test("empty result returns no-entries message", () => {
    const msg = formatExportResult(
      { entries: [], totalEntries: 0, truncated: false, tokenEstimate: 0, scope: "file", scopePath: "auth.ts" },
      "text",
    );
    assert.ok(msg.includes("No context annotations found"));
  });

  test("text output contains header and entry note", () => {
    const entry = {
      schemaVersion: "1.1.0" as const,
      id: "abc123",
      filePath: "auth.ts",
      lineRange: { start: 1, end: 1 },
      astAnchor: null,
      contentHash: "a".repeat(64),
      author: "alice",
      note: "Login function",
      severity: "high" as const,
      source: "human" as const,
      confidence: 1,
      status: "mapped" as const,
      reviewRequired: false,
      tags: [],
      aiTool: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const msg = formatExportResult(
      { entries: [entry], totalEntries: 1, truncated: false, tokenEstimate: 20, scope: "repo", scopePath: undefined },
      "text",
    );
    assert.ok(msg.includes("Kodela Context Export"), "expected header");
    assert.ok(msg.includes("Login function"), "expected entry note");
  });

  test("json output is valid JSON with expected keys", () => {
    const msg = formatExportResult(
      { entries: [], totalEntries: 0, truncated: false, tokenEstimate: 0, scope: "repo", scopePath: undefined },
      "json",
    );
    const parsed = JSON.parse(msg) as Record<string, unknown>;
    assert.ok("scope" in parsed);
    assert.ok("entries" in parsed);
    assert.ok("truncated" in parsed);
    assert.ok("tokenEstimate" in parsed);
  });

  test("truncated text output includes truncation warning", () => {
    const entry = {
      schemaVersion: "1.1.0" as const,
      id: "x1",
      filePath: "f.ts",
      lineRange: { start: 1, end: 2 },
      astAnchor: null,
      contentHash: "b".repeat(64),
      author: "bob",
      note: "something",
      severity: "medium" as const,
      source: "ai" as const,
      confidence: 0.9,
      status: "mapped" as const,
      reviewRequired: false,
      tags: [],
      aiTool: "gpt-4" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const msg = formatExportResult(
      { entries: [entry], totalEntries: 5, truncated: true, tokenEstimate: 50, scope: "repo", scopePath: undefined },
      "text",
    );
    assert.ok(msg.includes("truncated"), "expected truncation notice");
    assert.ok(msg.includes("4 entries omitted") || msg.includes("omitted"), "expected omitted count");
  });
});
