// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runDoctor, formatDoctorResult } from "./doctor.js";
import { writeDefaultConfig } from "../config/loader.js";

async function makeRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kodela-doctor-test-"));
}

describe("runDoctor", () => {
  let repoRoot: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    repoRoot = await makeRepo();
    originalEnv = { ...process.env };
    delete process.env["KODELA_AI_API_KEY"];
    delete process.env["CLAUDECODE"];
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  test("reports a fail-level Repository check when baseline is missing", async () => {
    const result = await runDoctor({
      repoRoot,
      env: { HOME: os.tmpdir() } as NodeJS.ProcessEnv,
    });
    const repo = result.checks.find((c) => c.name === "Repository");
    assert.ok(repo);
    assert.equal(repo!.level, "fail");
    assert.equal(result.healthy, false);
  });

  test("reports an ok Config check when _kodela block is at current version", async () => {
    await fs.mkdir(path.join(repoRoot, ".kodela"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".kodela", "baseline.json"),
      JSON.stringify({ version: 1, files: {} }),
      "utf-8",
    );
    await writeDefaultConfig(repoRoot);
    const result = await runDoctor({
      repoRoot,
      env: { HOME: os.tmpdir(), KODELA_AI_API_KEY: "x" } as NodeJS.ProcessEnv,
    });
    const config = result.checks.find((c) => c.name === "Config");
    assert.ok(config);
    assert.equal(config!.level, "ok");
  });

  test("AI provider key check passes when KODELA_AI_API_KEY is set", async () => {
    await fs.mkdir(path.join(repoRoot, ".kodela"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".kodela", "baseline.json"),
      JSON.stringify({ version: 1, files: {} }),
      "utf-8",
    );
    const result = await runDoctor({
      repoRoot,
      env: {
        HOME: os.tmpdir(),
        KODELA_AI_API_KEY: "test-key",
      } as NodeJS.ProcessEnv,
    });
    const apiKey = result.checks.find((c) => c.name === "AI provider key");
    assert.ok(apiKey);
    assert.equal(apiKey!.level, "ok");
  });

  test("Watcher check is 'not running' (warn) when no PID file exists", async () => {
    await fs.mkdir(path.join(repoRoot, ".kodela"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".kodela", "baseline.json"),
      JSON.stringify({ version: 1, files: {} }),
      "utf-8",
    );
    const result = await runDoctor({
      repoRoot,
      env: { HOME: os.tmpdir() } as NodeJS.ProcessEnv,
    });
    const watcher = result.checks.find((c) => c.name === "Watcher daemon");
    assert.ok(watcher);
    assert.equal(watcher!.level, "warn");
  });

  test("Encryption-at-rest: warn when no env var and no key file", async () => {
    await fs.mkdir(path.join(repoRoot, ".kodela"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".kodela", "baseline.json"),
      JSON.stringify({ version: 1, files: {} }),
      "utf-8",
    );
    const result = await runDoctor({
      repoRoot,
      env: { HOME: os.tmpdir() } as NodeJS.ProcessEnv,
    });
    const enc = result.checks.find((c) => c.name === "Encryption-at-rest");
    assert.ok(enc);
    assert.equal(enc!.level, "warn");
    assert.match(enc!.detail, /Disabled/);
  });

  test("Encryption-at-rest: ok when .kodela.master-key file is present", async () => {
    await fs.mkdir(path.join(repoRoot, ".kodela"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".kodela", "baseline.json"),
      JSON.stringify({ version: 1, files: {} }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(repoRoot, ".kodela.master-key"),
      Buffer.alloc(32, 0xab).toString("base64") + "\n",
      { mode: 0o600 },
    );
    const result = await runDoctor({
      repoRoot,
      env: { HOME: os.tmpdir() } as NodeJS.ProcessEnv,
    });
    const enc = result.checks.find((c) => c.name === "Encryption-at-rest");
    assert.ok(enc);
    assert.equal(enc!.level, "ok");
    assert.match(enc!.detail, /per-repo key/);
  });

  test("Encryption-at-rest: ok when KODELA_MASTER_KEY env var is set (env beats file path)", async () => {
    await fs.mkdir(path.join(repoRoot, ".kodela"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, ".kodela", "baseline.json"),
      JSON.stringify({ version: 1, files: {} }),
      "utf-8",
    );
    const result = await runDoctor({
      repoRoot,
      env: {
        HOME: os.tmpdir(),
        KODELA_MASTER_KEY: Buffer.alloc(32, 0xcd).toString("base64"),
      } as NodeJS.ProcessEnv,
    });
    const enc = result.checks.find((c) => c.name === "Encryption-at-rest");
    assert.ok(enc);
    assert.equal(enc!.level, "ok");
    assert.match(enc!.detail, /KODELA_MASTER_KEY/);
  });

  test("formatDoctorResult emits a per-check line and a summary line", () => {
    const out = formatDoctorResult({
      repoRoot: "/repo",
      checks: [
        { name: "Repository", level: "ok", detail: "ok" },
        {
          name: "Config",
          level: "warn",
          detail: "warn detail",
          remediation: "→ run `kodela doctor --fix`",
        },
      ],
      healthy: true,
      fixesApplied: [],
    });
    assert.match(out, /Kodela doctor — \/repo/);
    assert.match(out, /✔\s+Repository\s+ok/);
    assert.match(out, /⚠\s+Config\s+warn detail/);
    assert.match(out, /→ run `kodela doctor --fix`/);
    assert.match(out, /Overall: healthy/);
    // No fixes applied → no "Fixes applied:" header.
    assert.doesNotMatch(out, /Fixes applied:/);
  });

  test("formatDoctorResult renders the 'Fixes applied' block when --fix did work", () => {
    const out = formatDoctorResult({
      repoRoot: "/repo",
      checks: [
        {
          name: "Config",
          level: "ok",
          detail: "kodela.config.json _kodela block refreshed by --fix (now schema_version=1)",
        },
      ],
      healthy: true,
      fixesApplied: [
        { name: "Config", detail: "Refreshed _kodela.schema_version (0 → 1)" },
      ],
    });
    assert.match(out, /Fixes applied:/);
    assert.match(out, /✔\s+Config: Refreshed _kodela\.schema_version \(0 → 1\)/);
  });

  test("runDoctor with --fix refreshes a missing _kodela block", async () => {
    // Set up a repo that has a config WITHOUT the _kodela block, then run
    // `doctor --fix` and verify the block gets written.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-doctor-fix-"));
    try {
      await fs.mkdir(path.join(dir, ".kodela"), { recursive: true });
      await fs.writeFile(
        path.join(dir, ".kodela", "baseline.json"),
        JSON.stringify({ generatedAt: new Date().toISOString() }),
        "utf-8",
      );
      // Minimal config with no _kodela block.
      await fs.writeFile(
        path.join(dir, "kodela.config.json"),
        JSON.stringify({ version: 1 }),
        "utf-8",
      );

      const result = await runDoctor({ repoRoot: dir, fix: true });
      // The fix block must have run.
      assert.ok(
        result.fixesApplied.some((f) => f.name === "Config"),
        "expected a Config fix to be applied",
      );
      // The Config check must now be ok.
      const cfg = result.checks.find((c) => c.name === "Config");
      assert.equal(cfg?.level, "ok");

      // Verify on-disk: _kodela block is present.
      const raw = await fs.readFile(
        path.join(dir, "kodela.config.json"),
        "utf-8",
      );
      const parsed = JSON.parse(raw) as { _kodela?: { schema_version?: number } };
      assert.ok(parsed._kodela, "_kodela block should now exist on disk");
      assert.equal(typeof parsed._kodela?.schema_version, "number");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("runDoctor without --fix surfaces 'kodela doctor --fix' as the remediation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-doctor-nofix-"));
    try {
      await fs.mkdir(path.join(dir, ".kodela"), { recursive: true });
      await fs.writeFile(
        path.join(dir, ".kodela", "baseline.json"),
        JSON.stringify({ generatedAt: new Date().toISOString() }),
        "utf-8",
      );
      await fs.writeFile(
        path.join(dir, "kodela.config.json"),
        JSON.stringify({ version: 1 }),
        "utf-8",
      );

      const result = await runDoctor({ repoRoot: dir });
      const cfg = result.checks.find((c) => c.name === "Config");
      assert.equal(cfg?.level, "warn");
      assert.match(cfg!.remediation ?? "", /kodela doctor --fix/);
      assert.equal(result.fixesApplied.length, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
