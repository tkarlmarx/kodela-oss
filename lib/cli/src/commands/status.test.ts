// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runStatus } from "./status.js";
import { runInit } from "./init.js";
import { LICENSE_ENV_VAR, writeContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const ENFORCEMENT_CONFIG = JSON.stringify({
  ci: { enforcement: "enforcement", thresholds: { min_confidence_score: 0.8 } },
});

async function writeLowConfidenceEntry(repoRoot: string, id: string): Promise<void> {
  const entry: ContextEntry = {
    schemaVersion: "1.1.0",
    id,
    filePath: "src/breach-test.ts",
    astAnchor: null,
    contentHash: "breach001",
    lineRange: { start: 1, end: 5 },
    note: "Breach test entry.",
    author: "test",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    severity: "low",
    tags: [],
    source: "human",
    confidence: 0.1,
    status: "orphaned",
    reviewRequired: false,
  };
  await writeContextEntry(repoRoot, entry);
}

const LICENSE_WITH_CI_ENFORCEMENT = JSON.stringify({
  plan: "team",
  features: ["ci_enforcement", "dashboard"],
  orgId: "org_test",
  expiresAt: tomorrow(),
});

const LICENSE_WITHOUT_CI_ENFORCEMENT = JSON.stringify({
  plan: "team",
  features: ["dashboard"],
  orgId: "org_no_enforce",
  expiresAt: tomorrow(),
});

// ─── Basic status tests ───────────────────────────────────────────────────────

describe("runStatus", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-status-test-"));
    await runInit(tmpDir);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty status on fresh repo", async () => {
    const { result, exitCode } = await runStatus({ repoRoot: tmpDir });
    assert.equal(result.total, 0);
    assert.equal(exitCode, 0);
  });

  test("ci mode exits 0 in advisory mode even with no entries", async () => {
    const { exitCode } = await runStatus({ repoRoot: tmpDir, ci: true });
    assert.equal(exitCode, 0);
  });

  test("json output is valid JSON", async () => {
    const { output } = await runStatus({ repoRoot: tmpDir, output: "json" });
    const parsed = JSON.parse(output) as Record<string, unknown>;
    assert.ok("total" in parsed);
    assert.ok("confidence_score" in parsed);
  });

  test("junit output contains testsuites element", async () => {
    const { output } = await runStatus({ repoRoot: tmpDir, output: "junit" });
    assert.ok(output.includes("<testsuites"));
  });

  test("text output contains trust signal labels", async () => {
    const { output } = await runStatus({ repoRoot: tmpDir, output: "text" });
    assert.ok(output.includes("Confidence score"));
    assert.ok(output.includes("Orphaned"));
  });
});

// ─── License-gated CI enforcement ────────────────────────────────────────────

describe("runStatus — license-gated CI enforcement", () => {
  let tmpDir: string;
  let origEnv: string | undefined;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-status-license-"));
    await runInit(tmpDir);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    origEnv = process.env[LICENSE_ENV_VAR];
    delete process.env[LICENSE_ENV_VAR];
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env[LICENSE_ENV_VAR];
    } else {
      process.env[LICENSE_ENV_VAR] = origEnv;
    }
  });

  test("no license, advisory config, ci mode — exits 0", async () => {
    const { exitCode } = await runStatus({ repoRoot: tmpDir, ci: true });
    assert.equal(exitCode, 0);
  });

  test("no license, enforcement config in file, ci mode — exits 0 (advisory fallback)", async () => {
    const configPath = path.join(tmpDir, "kodela.config.json");
    await fs.writeFile(configPath, ENFORCEMENT_CONFIG, "utf-8");
    try {
      const { exitCode } = await runStatus({ repoRoot: tmpDir, ci: true });
      assert.equal(exitCode, 0);
    } finally {
      await fs.rm(configPath, { force: true });
    }
  });

  test("license with ci_enforcement via env var, advisory config, ci mode — exits 0", async () => {
    process.env[LICENSE_ENV_VAR] = LICENSE_WITH_CI_ENFORCEMENT;
    const { exitCode } = await runStatus({ repoRoot: tmpDir, ci: true });
    assert.equal(exitCode, 0);
  });

  test("license with ci_enforcement via env var, enforcement config, ci mode — exits 0 on empty repo", async () => {
    process.env[LICENSE_ENV_VAR] = LICENSE_WITH_CI_ENFORCEMENT;
    const configPath = path.join(tmpDir, "kodela.config.json");
    await fs.writeFile(configPath, ENFORCEMENT_CONFIG, "utf-8");
    try {
      const { exitCode } = await runStatus({ repoRoot: tmpDir, ci: true });
      assert.equal(exitCode, 0);
    } finally {
      await fs.rm(configPath, { force: true });
    }
  });

  test("license without ci_enforcement feature, enforcement config, ci mode — exits 0 (unlicensed feature)", async () => {
    process.env[LICENSE_ENV_VAR] = LICENSE_WITHOUT_CI_ENFORCEMENT;
    const configPath = path.join(tmpDir, "kodela.config.json");
    await fs.writeFile(configPath, ENFORCEMENT_CONFIG, "utf-8");
    try {
      const { exitCode } = await runStatus({ repoRoot: tmpDir, ci: true });
      assert.equal(exitCode, 0);
    } finally {
      await fs.rm(configPath, { force: true });
    }
  });

  test("license from a file on disk is resolved correctly", async () => {
    const licPath = path.join(tmpDir, "kodela.license.json");
    await fs.writeFile(licPath, LICENSE_WITH_CI_ENFORCEMENT, "utf-8");
    try {
      const { exitCode } = await runStatus({ repoRoot: tmpDir, ci: true });
      assert.equal(exitCode, 0);
    } finally {
      await fs.rm(licPath, { force: true });
    }
  });

  test("expired license env var — exits 0 even with enforcement config", async () => {
    const expired = JSON.stringify({
      plan: "team",
      features: ["ci_enforcement"],
      orgId: "org_expired",
      expiresAt: "2000-01-01",
    });
    process.env[LICENSE_ENV_VAR] = expired;
    const configPath = path.join(tmpDir, "kodela.config.json");
    await fs.writeFile(configPath, ENFORCEMENT_CONFIG, "utf-8");
    try {
      const { exitCode } = await runStatus({ repoRoot: tmpDir, ci: true });
      assert.equal(exitCode, 0);
    } finally {
      await fs.rm(configPath, { force: true });
    }
  });

  test("json output is not modified when no advisory needed", async () => {
    const { output } = await runStatus({ repoRoot: tmpDir, ci: true, output: "json" });
    const parsed = JSON.parse(output) as Record<string, unknown>;
    assert.ok("total" in parsed);
  });

  test("text output does not contain advisory when enforcement config but all metrics pass", async () => {
    process.env[LICENSE_ENV_VAR] = LICENSE_WITH_CI_ENFORCEMENT;
    const configPath = path.join(tmpDir, "kodela.config.json");
    await fs.writeFile(configPath, ENFORCEMENT_CONFIG, "utf-8");
    try {
      const { output } = await runStatus({ repoRoot: tmpDir, ci: true, output: "text" });
      assert.ok(
        !output.includes("[Kodela] CI enforcement is configured"),
        "Advisory should not appear when metrics pass",
      );
    } finally {
      await fs.rm(configPath, { force: true });
    }
  });

  test("config.license path loads license from explicit file path", async () => {
    const licPath = path.join(tmpDir, "custom-license.json");
    await fs.writeFile(licPath, LICENSE_WITH_CI_ENFORCEMENT, "utf-8");
    const configWithLicense = JSON.stringify({ license: licPath });
    const configPath = path.join(tmpDir, "kodela.config.json");
    await fs.writeFile(configPath, configWithLicense, "utf-8");
    try {
      const { exitCode } = await runStatus({ repoRoot: tmpDir, ci: true });
      assert.equal(exitCode, 0);
    } finally {
      await fs.rm(configPath, { force: true });
      await fs.rm(licPath, { force: true });
    }
  });

  test("config.license relative path is resolved against repoRoot", async () => {
    const licPath = path.join(tmpDir, "relative-license.json");
    await fs.writeFile(licPath, LICENSE_WITH_CI_ENFORCEMENT, "utf-8");
    const configWithLicense = JSON.stringify({ license: "relative-license.json" });
    const configPath = path.join(tmpDir, "kodela.config.json");
    await fs.writeFile(configPath, configWithLicense, "utf-8");
    try {
      const { exitCode } = await runStatus({ repoRoot: tmpDir, ci: true });
      assert.equal(exitCode, 0);
    } finally {
      await fs.rm(configPath, { force: true });
      await fs.rm(licPath, { force: true });
    }
  });

  test("licensed with ci_enforcement + breached thresholds — exits 1", async () => {
    process.env[LICENSE_ENV_VAR] = LICENSE_WITH_CI_ENFORCEMENT;
    const breachDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-breach-licensed-"));
    try {
      await runInit(breachDir);
      await writeLowConfidenceEntry(breachDir, "aaaaaaaa-0000-0000-0000-000000000001");
      const configPath = path.join(breachDir, "kodela.config.json");
      await fs.writeFile(configPath, ENFORCEMENT_CONFIG, "utf-8");
      const { exitCode } = await runStatus({ repoRoot: breachDir, ci: true });
      assert.equal(exitCode, 1);
    } finally {
      await fs.rm(breachDir, { recursive: true, force: true });
    }
  });

  test("unlicensed + enforcement + breached thresholds — exits 0 with advisory text", async () => {
    const breachDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-breach-unlicensed-"));
    try {
      await runInit(breachDir);
      await writeLowConfidenceEntry(breachDir, "aaaaaaaa-0000-0000-0000-000000000002");
      const configPath = path.join(breachDir, "kodela.config.json");
      await fs.writeFile(configPath, ENFORCEMENT_CONFIG, "utf-8");
      const { exitCode, output } = await runStatus({
        repoRoot: breachDir,
        ci: true,
        output: "text",
      });
      assert.equal(exitCode, 0);
      assert.ok(
        output.includes("[Kodela] CI enforcement is configured"),
        "Advisory must appear for unlicensed enforcement with breached thresholds",
      );
    } finally {
      await fs.rm(breachDir, { recursive: true, force: true });
    }
  });

  test("unlicensed + enforcement + passing thresholds — exits 0 with advisory text", async () => {
    const configPath = path.join(tmpDir, "kodela.config.json");
    await fs.writeFile(configPath, ENFORCEMENT_CONFIG, "utf-8");
    try {
      const { exitCode, output } = await runStatus({
        repoRoot: tmpDir,
        ci: true,
        output: "text",
      });
      assert.equal(exitCode, 0);
      assert.ok(
        output.includes("[Kodela] CI enforcement is configured"),
        "Advisory must appear for unlicensed enforcement even when thresholds pass",
      );
    } finally {
      await fs.rm(configPath, { force: true });
    }
  });

  test("env var takes priority over config.license path", async () => {
    const diskLicPath = path.join(tmpDir, "disk-license.json");
    const diskLicense = JSON.stringify({
      plan: "free",
      features: [],
      orgId: "org_disk",
      expiresAt: tomorrow(),
    });
    await fs.writeFile(diskLicPath, diskLicense, "utf-8");
    const configWithLicense = JSON.stringify({ license: diskLicPath });
    const configPath = path.join(tmpDir, "kodela.config.json");
    await fs.writeFile(configPath, configWithLicense, "utf-8");
    process.env[LICENSE_ENV_VAR] = LICENSE_WITH_CI_ENFORCEMENT;
    try {
      const { exitCode } = await runStatus({ repoRoot: tmpDir, ci: true });
      assert.equal(exitCode, 0);
    } finally {
      await fs.rm(configPath, { force: true });
      await fs.rm(diskLicPath, { force: true });
    }
  });
});
