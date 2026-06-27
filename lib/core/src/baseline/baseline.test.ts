// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initBaseline, isBaselineInitialized, getBaseline } from "./baseline.js";
import { SCHEMA_VERSION } from "../schema/index.js";

let tmpDir: string;

describe("Baseline system", () => {
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-baseline-"));
    await fs.writeFile(path.join(tmpDir, "hello.ts"), `export function hello() { return "hi"; }`, "utf-8");
    await fs.writeFile(path.join(tmpDir, "world.ts"), `export const WORLD = "world";`, "utf-8");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("isBaselineInitialized returns false before init", async () => {
    const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-bl-"));
    try {
      const initialized = await isBaselineInitialized(freshDir);
      assert.equal(initialized, false);
    } finally {
      await fs.rm(freshDir, { recursive: true, force: true });
    }
  });

  test("initBaseline creates .kodela/ and records file hashes", async () => {
    const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-bl2-"));
    try {
      await fs.writeFile(path.join(freshDir, "index.ts"), `export const x = 1;`, "utf-8");
      const event = await initBaseline(freshDir);

      assert.equal(event.type, "BaselineCreated");
      assert.equal(event.repoRoot, freshDir);
      assert.ok(event.trackedFileCount >= 1);
      assert.ok(typeof event.createdAt === "string");

      const kodelaDir = path.join(freshDir, ".kodela");
      const stat = await fs.stat(kodelaDir);
      assert.ok(stat.isDirectory());

      const baseline = await getBaseline(freshDir);
      assert.notEqual(baseline, null);
      assert.equal(baseline!.schemaVersion, SCHEMA_VERSION);
      assert.ok(typeof baseline!.trackedFiles === "object");
    } finally {
      await fs.rm(freshDir, { recursive: true, force: true });
    }
  });

  test("isBaselineInitialized returns true after init", async () => {
    const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-bl3-"));
    try {
      await initBaseline(freshDir);
      const initialized = await isBaselineInitialized(freshDir);
      assert.equal(initialized, true);
    } finally {
      await fs.rm(freshDir, { recursive: true, force: true });
    }
  });

  test("initBaseline is idempotent with force:true", async () => {
    const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-bl4-"));
    try {
      const event1 = await initBaseline(freshDir);
      const event2 = await initBaseline(freshDir, { force: true });
      assert.equal(event1.type, "BaselineCreated");
      assert.equal(event1.alreadyExisted, false);
      assert.equal(event2.type, "BaselineCreated");
      assert.equal(event2.alreadyExisted, false);
    } finally {
      await fs.rm(freshDir, { recursive: true, force: true });
    }
  });

  test("initBaseline is idempotent on second call without force — returns alreadyExisted:true", async () => {
    const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-bl5-"));
    try {
      const event1 = await initBaseline(freshDir);
      assert.equal(event1.alreadyExisted, false);

      const event2 = await initBaseline(freshDir);
      assert.equal(event2.type, "BaselineCreated");
      assert.equal(event2.alreadyExisted, true);
      assert.equal(event2.repoRoot, freshDir);
    } finally {
      await fs.rm(freshDir, { recursive: true, force: true });
    }
  });

  test("baseline records contentHash for each tracked file", async () => {
    const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-bl6-"));
    try {
      await fs.writeFile(path.join(freshDir, "app.ts"), `const x = 1;`, "utf-8");
      await initBaseline(freshDir);
      const baseline = await getBaseline(freshDir);
      assert.notEqual(baseline, null);
      const entry = baseline!.trackedFiles["app.ts"];
      assert.ok(entry !== undefined, "app.ts should be in trackedFiles");
      assert.ok(typeof entry.contentHash === "string" && entry.contentHash.length > 0);
    } finally {
      await fs.rm(freshDir, { recursive: true, force: true });
    }
  });

  test("baseline does not include node_modules", async () => {
    const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-bl7-"));
    try {
      await fs.mkdir(path.join(freshDir, "node_modules", "pkg"), { recursive: true });
      await fs.writeFile(
        path.join(freshDir, "node_modules", "pkg", "index.js"),
        `module.exports = {};`,
        "utf-8",
      );
      await fs.writeFile(path.join(freshDir, "app.ts"), `const y = 2;`, "utf-8");
      await initBaseline(freshDir);
      const baseline = await getBaseline(freshDir);
      assert.notEqual(baseline, null);
      const hasNodeModules = Object.keys(baseline!.trackedFiles).some((k) =>
        k.includes("node_modules"),
      );
      assert.equal(hasNodeModules, false, "node_modules should not be tracked");
    } finally {
      await fs.rm(freshDir, { recursive: true, force: true });
    }
  });
});
