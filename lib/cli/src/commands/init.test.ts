// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runInit, formatInitResult } from "./init.js";

describe("runInit", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-init-test-"));
    await fs.writeFile(path.join(tmpDir, "hello.ts"), "export const x = 1;\n");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("creates .kodela/ directory and returns trackedFiles count", async () => {
    const result = await runInit(tmpDir);
    assert.equal(result.repoRoot, tmpDir);
    assert.equal(result.alreadyExisted, false);
    assert.ok(result.trackedFiles >= 0);

    const kodelaStat = await fs.stat(path.join(tmpDir, ".kodela"));
    assert.ok(kodelaStat.isDirectory());
  });

  test("second call without force returns alreadyExisted: true", async () => {
    const result = await runInit(tmpDir);
    assert.equal(result.alreadyExisted, true);
  });

  test("force reinitializes successfully", async () => {
    const result = await runInit(tmpDir, { force: true });
    assert.equal(result.alreadyExisted, false);
  });

  test("always writes kodela.config.json and .kodelaignore on first init", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-init-cfg-"));
    try {
      const result = await runInit(dir);
      assert.equal(result.configWritten, true);
      assert.equal(result.kodelaignoreWritten, true);
      const configStat = await fs.stat(path.join(dir, "kodela.config.json"));
      assert.ok(configStat.isFile());
      const ignoreStat = await fs.stat(path.join(dir, ".kodelaignore"));
      assert.ok(ignoreStat.isFile());
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("does not overwrite existing kodela.config.json or .kodelaignore", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-init-nooverwrite-"));
    try {
      const sentinelConfig = '{"_sentinel":true}\n';
      const sentinelIgnore = "# sentinel\n";
      await fs.writeFile(path.join(dir, "kodela.config.json"), sentinelConfig);
      await fs.writeFile(path.join(dir, ".kodelaignore"), sentinelIgnore);
      const result = await runInit(dir);
      assert.equal(result.configWritten, false);
      assert.equal(result.kodelaignoreWritten, false);
      assert.equal(
        await fs.readFile(path.join(dir, "kodela.config.json"), "utf-8"),
        sentinelConfig,
      );
      assert.equal(
        await fs.readFile(path.join(dir, ".kodelaignore"), "utf-8"),
        sentinelIgnore,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("formatInitResult", () => {
  test("shows initialization message on fresh init", () => {
    const msg = formatInitResult({
      repoRoot: "/repo",
      alreadyExisted: false,
      configWritten: false,
      kodelaignoreWritten: false,
      gettingStartedWritten: false,
      trackedFiles: 42,
      hooksInstalled: false,
      hooksSkipped: false,
    });
    assert.ok(msg.includes("✓ Kodela initialized"));
    assert.ok(msg.includes("42 files"));
  });

  test("shows already exists message on second call", () => {
    const msg = formatInitResult({
      repoRoot: "/repo",
      alreadyExisted: true,
      configWritten: false,
      kodelaignoreWritten: false,
      gettingStartedWritten: false,
      trackedFiles: 0,
      hooksInstalled: false,
      hooksSkipped: false,
    });
    assert.ok(msg.includes("already exists"));
    assert.ok(msg.includes("--force"));
  });

  test("shows config and kodelaignore written messages", () => {
    const msg = formatInitResult({
      repoRoot: "/repo",
      alreadyExisted: false,
      configWritten: true,
      kodelaignoreWritten: true,
      gettingStartedWritten: true,
      trackedFiles: 1,
      hooksInstalled: false,
      hooksSkipped: false,
    });
    assert.ok(msg.includes("kodela.config.json"));
    assert.ok(msg.includes(".kodelaignore"));
  });
});
