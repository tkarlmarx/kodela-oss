// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runMemoryBank, formatMemoryBankResult } from "./memory-bank.js";
import { runInit } from "./init.js";
import { runAdd } from "./add.js";

const FILES = [
  "projectbrief.md",
  "productContext.md",
  "activeContext.md",
  "systemPatterns.md",
  "techContext.md",
  "progress.md",
];

describe("runMemoryBank", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-mb-test-"));
    await fs.writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "demo-app", description: "A demo project" }),
    );
    await fs.mkdir(path.join(tmp, ".kodela", "dna"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".kodela", "dna", "project.json"),
      JSON.stringify({
        project: "demo-app",
        purpose: "Capture the why behind changes.",
        stack: ["TypeScript", "Node"],
        non_goals: ["We do not generate application code."],
        technical: {
          architecture: { pattern: "modular monolith", tiers: ["core", "cli"] },
          data_stores: ["SQLite"],
          languages: { typescript: 0.9 },
          runtime: { node: "24+" },
          build: "esbuild",
          test: "node:test",
        },
      }),
    );
    await fs.writeFile(path.join(tmp, "auth.ts"), "export function login() {}\n");
    await runInit(tmp);
    await runAdd({
      repoRoot: tmp,
      filePath: "auth.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Rotate refresh tokens on use",
      severity: "high",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("creates all six standard memory-bank files with managed markers", async () => {
    const result = await runMemoryBank({ repoRoot: tmp });
    assert.equal(result.files.length, 6);
    assert.ok(result.files.every((f) => f.action === "created"));
    for (const f of FILES) {
      const content = await fs.readFile(path.join(tmp, "memory-bank", f), "utf8");
      assert.match(content, /KODELA:AUTO BEGIN/);
      assert.match(content, /KODELA:AUTO END/);
    }
  });

  test("pulls captured why + DNA into the content", async () => {
    const active = await fs.readFile(path.join(tmp, "memory-bank", "activeContext.md"), "utf8");
    assert.match(active, /Rotate refresh tokens on use/);
    const sys = await fs.readFile(path.join(tmp, "memory-bank", "systemPatterns.md"), "utf8");
    assert.match(sys, /modular monolith/);
    const tech = await fs.readFile(path.join(tmp, "memory-bank", "techContext.md"), "utf8");
    assert.match(tech, /TypeScript/);
  });

  test("--check reports up to date after a write, and is idempotent", async () => {
    const check = await runMemoryBank({ repoRoot: tmp, check: true });
    assert.equal(check.outdated, false);
    const second = await runMemoryBank({ repoRoot: tmp });
    assert.ok(second.files.every((f) => f.action === "unchanged"));
  });

  test("preserves human content outside the managed markers", async () => {
    const file = path.join(tmp, "memory-bank", "progress.md");
    const before = await fs.readFile(file, "utf8");
    await fs.writeFile(file, before + "\n## My hand-written notes\nkeep me\n");
    // force a managed-block change by adding another entry
    await runAdd({
      repoRoot: tmp,
      filePath: "auth.ts",
      lineStart: 2,
      lineEnd: 2,
      note: "Second annotation",
      severity: "low",
      source: "human",
    });
    await runMemoryBank({ repoRoot: tmp });
    const after = await fs.readFile(file, "utf8");
    assert.match(after, /My hand-written notes/);
    assert.match(after, /keep me/);
  });

  test("formatMemoryBankResult renders text and json", async () => {
    const result = await runMemoryBank({ repoRoot: tmp, check: true });
    assert.match(formatMemoryBankResult(result, "text"), /Memory Bank/);
    assert.doesNotThrow(() => JSON.parse(formatMemoryBankResult(result, "json")));
  });
});

// ── Phase 1 — standing directives are injected into the Memory Bank ──────────
import { renderMemoryBank } from "./memory-bank.js";
import { addDirective } from "@kodela/core/directives";

describe("Memory Bank — standing directives injection", () => {
  let tmp: string;
  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-mb-dir-"));
    await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "demo" }));
    await addDirective(tmp, "Always sign commits with GPG", { createdAt: "2026-06-01T00:00:00.000Z" });
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("activeContext.md leads with the standing directives", async () => {
    const { files } = await renderMemoryBank(tmp);
    const active = files.find((f) => f.file === "activeContext.md");
    assert.ok(active, "activeContext.md is rendered");
    assert.match(active!.content, /Standing directives/);
    assert.match(active!.content, /Always sign commits with GPG/);
  });

  test("no directives → no directives heading (clean)", async () => {
    const clean = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-mb-nodir-"));
    try {
      await fs.writeFile(path.join(clean, "package.json"), JSON.stringify({ name: "demo" }));
      const { files } = await renderMemoryBank(clean);
      const active = files.find((f) => f.file === "activeContext.md");
      assert.doesNotMatch(active!.content, /Standing directives/);
    } finally {
      await fs.rm(clean, { recursive: true, force: true });
    }
  });
});
