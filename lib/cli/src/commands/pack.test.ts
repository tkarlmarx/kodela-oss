// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runPack, formatPackResult } from "./pack.js";
import { runInit } from "./init.js";
import { runAdd } from "./add.js";

describe("runPack", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-pack-test-"));
    await fs.writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "demo-pack", description: "demo" }),
    );
    await fs.mkdir(path.join(tmp, ".kodela", "dna"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".kodela", "dna", "project.json"),
      JSON.stringify({ project: "demo-pack", purpose: "Pack the why.", stack: ["TypeScript"] }),
    );
    await fs.writeFile(path.join(tmp, "auth.ts"), "export const x = 1;\n");
    await runInit(tmp);
    await runAdd({
      repoRoot: tmp,
      filePath: "auth.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Why this exists: token rotation",
      severity: "high",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("stdout mode packs DNA + captured why into one artifact", async () => {
    const result = await runPack({ repoRoot: tmp, stdout: true });
    assert.match(result.content, /# demo-pack — Kodela pack/);
    assert.match(result.content, /Pack the why\./);
    assert.match(result.content, /Captured context/);
    assert.match(result.content, /token rotation/);
    assert.equal(result.entryCount, 1);
    assert.equal(result.outPath, undefined);
  });

  test("file mode writes the artifact and reports the path", async () => {
    const result = await runPack({ repoRoot: tmp, out: "ctx.md" });
    assert.equal(result.outPath, "ctx.md");
    const written = await fs.readFile(path.join(tmp, "ctx.md"), "utf8");
    assert.match(written, /Kodela pack/);
    assert.ok(result.bytes > 0);
  });

  test("formatPackResult renders text and json", async () => {
    const result = await runPack({ repoRoot: tmp, out: "ctx.md" });
    assert.match(formatPackResult(result, "text"), /Packed →/);
    assert.doesNotThrow(() => JSON.parse(formatPackResult(result, "json")));
  });

  test("works on a cold repo with no captured context", async () => {
    const cold = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-pack-cold-"));
    try {
      await runInit(cold);
      const result = await runPack({ repoRoot: cold, stdout: true });
      assert.match(result.content, /Kodela pack/);
      assert.match(result.content, /No context captured yet/);
      assert.equal(result.entryCount, 0);
    } finally {
      await fs.rm(cold, { recursive: true, force: true });
    }
  });
});
