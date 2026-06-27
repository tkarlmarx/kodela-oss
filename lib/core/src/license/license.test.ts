// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  KodelaLicenseSchema,
  KodelaFeatureSchema,
  KODELA_FEATURES,
} from "./types.js";
import {
  loadLicense,
  licenseHasFeature,
  hasFeature,
  isLicenseExpired,
  LICENSE_FILE_NAME,
  LICENSE_ENV_VAR,
} from "./resolver.js";
import type { KodelaLicense, KodelaFeature } from "./types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function yesterday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const VALID_LICENSE: KodelaLicense = {
  plan: "enterprise",
  features: ["dashboard", "policy_engine", "ci_enforcement", "sso", "audit_logs"],
  orgId: "org_acme",
  expiresAt: tomorrow(),
};

// ─── Zod schema validation ────────────────────────────────────────────────────

describe("KodelaLicenseSchema", () => {
  test("accepts a fully valid enterprise license", () => {
    const result = KodelaLicenseSchema.safeParse(VALID_LICENSE);
    assert.ok(result.success);
  });

  test("accepts a valid team license with minimal features", () => {
    const result = KodelaLicenseSchema.safeParse({
      plan: "team",
      features: ["ci_enforcement", "dashboard"],
      orgId: "org_beta",
      expiresAt: "2099-01-01",
    });
    assert.ok(result.success);
  });

  test("accepts free plan with empty features array", () => {
    const result = KodelaLicenseSchema.safeParse({
      plan: "free",
      features: [],
      orgId: "org_free",
      expiresAt: tomorrow(),
    });
    assert.ok(result.success);
  });

  test("rejects unknown plan value", () => {
    const result = KodelaLicenseSchema.safeParse({ ...VALID_LICENSE, plan: "starter" });
    assert.ok(!result.success);
  });

  test("rejects unknown feature in features array", () => {
    const result = KodelaLicenseSchema.safeParse({
      ...VALID_LICENSE,
      features: ["ci_enforcement", "unknown_feature"],
    });
    assert.ok(!result.success);
  });

  test("rejects empty orgId", () => {
    const result = KodelaLicenseSchema.safeParse({ ...VALID_LICENSE, orgId: "" });
    assert.ok(!result.success);
  });

  test("rejects expiresAt not in YYYY-MM-DD format", () => {
    const bad = ["2025/12/31", "31-12-2025", "2025-1-1", "not-a-date", ""];
    for (const expiresAt of bad) {
      const result = KodelaLicenseSchema.safeParse({ ...VALID_LICENSE, expiresAt });
      assert.ok(!result.success, `Expected failure for expiresAt="${expiresAt}"`);
    }
  });

  test("KODELA_FEATURES constant matches schema enum options", () => {
    const schemaOptions = KodelaFeatureSchema.options as string[];
    assert.deepStrictEqual([...KODELA_FEATURES].sort(), [...schemaOptions].sort());
  });
});

// ─── isLicenseExpired ─────────────────────────────────────────────────────────

describe("isLicenseExpired", () => {
  test("tomorrow's expiry is not expired", () => {
    assert.strictEqual(isLicenseExpired({ ...VALID_LICENSE, expiresAt: tomorrow() }), false);
  });

  test("yesterday's expiry is expired", () => {
    assert.strictEqual(isLicenseExpired({ ...VALID_LICENSE, expiresAt: yesterday() }), true);
  });

  test("today's expiry is not expired (inclusive)", () => {
    assert.strictEqual(isLicenseExpired({ ...VALID_LICENSE, expiresAt: today() }), false);
  });

  test("far-future expiry is not expired", () => {
    assert.strictEqual(isLicenseExpired({ ...VALID_LICENSE, expiresAt: "2099-12-31" }), false);
  });
});

// ─── licenseHasFeature ────────────────────────────────────────────────────────

describe("licenseHasFeature", () => {
  test("returns false for null license (free tier)", () => {
    for (const feature of KODELA_FEATURES) {
      assert.strictEqual(licenseHasFeature(null, feature), false, `Expected false for ${feature}`);
    }
  });

  test("returns true for a feature that is in the license", () => {
    assert.strictEqual(licenseHasFeature(VALID_LICENSE, "ci_enforcement"), true);
    assert.strictEqual(licenseHasFeature(VALID_LICENSE, "dashboard"), true);
    assert.strictEqual(licenseHasFeature(VALID_LICENSE, "sso"), true);
  });

  test("returns false for a feature not in the license", () => {
    assert.strictEqual(licenseHasFeature(VALID_LICENSE, "search"), false);
    assert.strictEqual(licenseHasFeature(VALID_LICENSE, "pr_checks"), false);
    assert.strictEqual(licenseHasFeature(VALID_LICENSE, "retroactive_scan"), false);
  });

  test("returns false for all features when license is expired", () => {
    const expired: KodelaLicense = { ...VALID_LICENSE, expiresAt: yesterday() };
    for (const feature of VALID_LICENSE.features) {
      assert.strictEqual(licenseHasFeature(expired, feature as KodelaFeature), false);
    }
  });

  test("returns true on the day of expiry (inclusive)", () => {
    const expiresAtToday: KodelaLicense = { ...VALID_LICENSE, expiresAt: today() };
    assert.strictEqual(licenseHasFeature(expiresAtToday, "ci_enforcement"), true);
  });
});

// ─── loadLicense — env var ────────────────────────────────────────────────────

describe("loadLicense — KODELA_LICENSE env var", () => {
  const ORIG = process.env[LICENSE_ENV_VAR];

  afterEach(() => {
    if (ORIG === undefined) {
      delete process.env[LICENSE_ENV_VAR];
    } else {
      process.env[LICENSE_ENV_VAR] = ORIG;
    }
  });

  test("returns license from inline JSON env var", async () => {
    process.env[LICENSE_ENV_VAR] = JSON.stringify(VALID_LICENSE);
    const license = await loadLicense();
    assert.ok(license !== null);
    assert.strictEqual(license.orgId, "org_acme");
    assert.strictEqual(license.plan, "enterprise");
  });

  test("returns null for malformed inline JSON env var", async () => {
    process.env[LICENSE_ENV_VAR] = "{ not valid json }";
    const license = await loadLicense();
    assert.strictEqual(license, null);
  });

  test("returns null for inline JSON that fails schema validation", async () => {
    process.env[LICENSE_ENV_VAR] = JSON.stringify({ ...VALID_LICENSE, plan: "unknown_plan" });
    const license = await loadLicense();
    assert.strictEqual(license, null);
  });

  test("returns license from env var pointing to a file path", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-license-test-"));
    try {
      const filePath = path.join(tmp, LICENSE_FILE_NAME);
      await fs.writeFile(filePath, JSON.stringify(VALID_LICENSE), "utf-8");
      process.env[LICENSE_ENV_VAR] = filePath;
      const license = await loadLicense();
      assert.ok(license !== null);
      assert.strictEqual(license.orgId, "org_acme");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("returns null for env var file path that does not exist", async () => {
    process.env[LICENSE_ENV_VAR] = "/no/such/path/kodela.license.json";
    const license = await loadLicense();
    assert.strictEqual(license, null);
  });
});

// ─── loadLicense — file walk ──────────────────────────────────────────────────

describe("loadLicense — file walk", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-license-walk-"));
    delete process.env[LICENSE_ENV_VAR];
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env[LICENSE_ENV_VAR];
  });

  test("finds license in the repoRoot directory", async () => {
    await fs.writeFile(
      path.join(tmpDir, LICENSE_FILE_NAME),
      JSON.stringify(VALID_LICENSE),
      "utf-8",
    );
    const license = await loadLicense(tmpDir);
    assert.ok(license !== null);
    assert.strictEqual(license.plan, "enterprise");
  });

  test("finds license in a parent directory when called from a subdirectory", async () => {
    const sub = path.join(tmpDir, "src", "auth");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, LICENSE_FILE_NAME),
      JSON.stringify(VALID_LICENSE),
      "utf-8",
    );
    const license = await loadLicense(sub);
    assert.ok(license !== null);
    assert.strictEqual(license.orgId, "org_acme");
  });

  test("returns null when no license file exists anywhere in the tree", async () => {
    const sub = path.join(tmpDir, "src");
    await fs.mkdir(sub, { recursive: true });
    const license = await loadLicense(sub);
    assert.strictEqual(license, null);
  });

  test("returns null when license file has invalid JSON", async () => {
    await fs.writeFile(
      path.join(tmpDir, LICENSE_FILE_NAME),
      "this is not json",
      "utf-8",
    );
    const license = await loadLicense(tmpDir);
    assert.strictEqual(license, null);
  });

  test("returns null when license file fails schema validation", async () => {
    await fs.writeFile(
      path.join(tmpDir, LICENSE_FILE_NAME),
      JSON.stringify({ plan: "enterprise", orgId: "", features: [], expiresAt: "bad" }),
      "utf-8",
    );
    const license = await loadLicense(tmpDir);
    assert.strictEqual(license, null);
  });
});

// ─── hasFeature — async end-to-end ───────────────────────────────────────────

describe("hasFeature", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-has-feature-"));
    delete process.env[LICENSE_ENV_VAR];
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env[LICENSE_ENV_VAR];
  });

  test("returns false for any feature when no license exists", async () => {
    for (const feature of KODELA_FEATURES) {
      assert.strictEqual(await hasFeature(feature, tmpDir), false);
    }
  });

  test("returns true for a licensed feature", async () => {
    await fs.writeFile(
      path.join(tmpDir, LICENSE_FILE_NAME),
      JSON.stringify(VALID_LICENSE),
      "utf-8",
    );
    assert.strictEqual(await hasFeature("ci_enforcement", tmpDir), true);
    assert.strictEqual(await hasFeature("dashboard", tmpDir), true);
  });

  test("returns false for an unlicensed feature", async () => {
    await fs.writeFile(
      path.join(tmpDir, LICENSE_FILE_NAME),
      JSON.stringify(VALID_LICENSE),
      "utf-8",
    );
    assert.strictEqual(await hasFeature("search", tmpDir), false);
    assert.strictEqual(await hasFeature("pr_checks", tmpDir), false);
  });

  test("returns false for all features when license is expired", async () => {
    const expired: KodelaLicense = { ...VALID_LICENSE, expiresAt: yesterday() };
    await fs.writeFile(
      path.join(tmpDir, LICENSE_FILE_NAME),
      JSON.stringify(expired),
      "utf-8",
    );
    for (const feature of VALID_LICENSE.features) {
      assert.strictEqual(await hasFeature(feature as KodelaFeature, tmpDir), false);
    }
  });

  test("env var inline JSON takes priority over file on disk", async () => {
    const diskLicense: KodelaLicense = {
      ...VALID_LICENSE,
      features: [],
      orgId: "org_disk",
    };
    await fs.writeFile(
      path.join(tmpDir, LICENSE_FILE_NAME),
      JSON.stringify(diskLicense),
      "utf-8",
    );
    const envLicense: KodelaLicense = { ...VALID_LICENSE, orgId: "org_env" };
    process.env[LICENSE_ENV_VAR] = JSON.stringify(envLicense);

    assert.strictEqual(await hasFeature("ci_enforcement", tmpDir), true);
  });
});
