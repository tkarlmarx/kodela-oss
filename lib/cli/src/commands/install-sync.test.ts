// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInstallCi } from "./install-ci.js";
import { runInstallHooks } from "./install-hooks.js";
import type { KodelaConfig } from "../config/schema.js";

const CONFIG = { ci: { enforcement: "advisory" } } as unknown as KodelaConfig;

describe("install --sync (central-sync turnkey, B)", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-sync-setup-"));
  });
  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  test("install-ci --sync writes the GitHub sync workflow", async () => {
    const result = await runInstallCi({ repoRoot, platform: "github", config: CONFIG, sync: true });
    assert.equal(result.sync, true);
    assert.equal(result.installed, true);
    assert.equal(result.outputPath, ".github/workflows/kodela-sync.yml");
    const content = await fs.readFile(path.join(repoRoot, result.outputPath), "utf-8");
    assert.match(content, /name: Kodela Sync/);
    assert.match(content, /kodela\/cli sync/);
    assert.match(content, /KODELA_API_KEY/);
  });

  test("install-ci --sync rejects non-GitHub platforms with a clear error", async () => {
    await assert.rejects(
      () => runInstallCi({ repoRoot, platform: "gitlab", config: CONFIG, sync: true }),
      /--sync currently supports GitHub Actions only/,
    );
  });

  test("install-ci (no --sync) still writes the coverage-check workflow", async () => {
    const result = await runInstallCi({ repoRoot, platform: "github", config: CONFIG });
    assert.equal(result.sync, false);
    assert.equal(result.outputPath, ".github/workflows/kodela.yml");
  });

  test("install-hooks --sync installs an executable post-merge hook", async () => {
    await fs.mkdir(path.join(repoRoot, ".git", "hooks"), { recursive: true });
    const result = await runInstallHooks({ repoRoot, sync: true });
    assert.equal(result.postMergeInstalled, true);
    const hookPath = path.join(repoRoot, ".git", "hooks", "post-merge");
    const content = await fs.readFile(hookPath, "utf-8");
    assert.match(content, /kodela sync|@kodela\/cli/);
    const mode = (await fs.stat(hookPath)).mode & 0o111;
    assert.ok(mode !== 0, "post-merge hook must be executable");
  });

  test("install-hooks without --sync installs no post-merge hook", async () => {
    await fs.mkdir(path.join(repoRoot, ".git", "hooks"), { recursive: true });
    const result = await runInstallHooks({ repoRoot });
    assert.equal(result.postMergeInstalled, undefined);
    await assert.rejects(() => fs.access(path.join(repoRoot, ".git", "hooks", "post-merge")));
  });
});
