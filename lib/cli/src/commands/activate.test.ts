// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runActivate, runLicenseStatus } from "./activate.js";
import type { KodelaLicense } from "@kodela/core";

const LICENSE: KodelaLicense = {
  plan: "pro",
  features: ["search", "dashboard"],
  orgId: "org_fixed",
  expiresAt: "2099-01-01",
  apiSecret: "x".repeat(32),
  keyId: "test-key-1",
  signature: "ZmFrZS1zaWduYXR1cmU=",
};

function fakeFetch(body: object, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kodela-activate-"));
}

describe("runActivate", () => {
  test("installs a signature-verified license to kodela.license.json", async () => {
    const repoRoot = tmpRepo();
    const r = await runActivate({
      repoRoot,
      token: "kdl_act_abc",
      billingUrl: "https://billing.kodela.dev",
      deps: { fetchImpl: fakeFetch({ orgId: "org_fixed", license: LICENSE }), verifyImpl: () => true },
    });
    assert.equal(r.written, true);
    assert.equal(r.plan, "pro");
    assert.equal(r.orgId, "org_fixed");
    assert.equal(r.signatureValid, true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(repoRoot, "kodela.license.json"), "utf8"));
    assert.equal(onDisk.orgId, "org_fixed");
    assert.deepEqual(onDisk.features, ["search", "dashboard"]);
  });

  test("refuses to install a license whose signature does not verify", async () => {
    const repoRoot = tmpRepo();
    await assert.rejects(
      runActivate({
        repoRoot,
        token: "kdl_act_abc",
        billingUrl: "https://billing.kodela.dev",
        deps: { fetchImpl: fakeFetch({ license: LICENSE }), verifyImpl: () => false },
      }),
      /signature did not verify/,
    );
    assert.equal(fs.existsSync(path.join(repoRoot, "kodela.license.json")), false, "must not write a forged license");
  });

  test("rejects a malformed license payload before touching disk", async () => {
    const repoRoot = tmpRepo();
    await assert.rejects(
      runActivate({
        repoRoot,
        token: "kdl_act_abc",
        billingUrl: "https://billing.kodela.dev",
        deps: { fetchImpl: fakeFetch({ license: { plan: "pro" } }), verifyImpl: () => true },
      }),
      /malformed license/,
    );
    assert.equal(fs.existsSync(path.join(repoRoot, "kodela.license.json")), false);
  });

  test("surfaces a 404 as 'payment may still be processing'", async () => {
    await assert.rejects(
      runActivate({
        repoRoot: tmpRepo(),
        token: "kdl_act_abc",
        billingUrl: "https://billing.kodela.dev",
        deps: { fetchImpl: fakeFetch({ error: "no license for this token" }, 404), verifyImpl: () => true },
      }),
      /payment may still be processing/,
    );
  });

  test("surfaces a 401 as a rejected token", async () => {
    await assert.rejects(
      runActivate({
        repoRoot: tmpRepo(),
        token: "bad",
        billingUrl: "https://billing.kodela.dev",
        deps: { fetchImpl: fakeFetch({ error: "missing token" }, 401), verifyImpl: () => true },
      }),
      /token rejected/,
    );
  });

  test("--print resolves the license without writing it", async () => {
    const repoRoot = tmpRepo();
    const r = await runActivate({
      repoRoot,
      token: "kdl_act_abc",
      print: true,
      billingUrl: "https://billing.kodela.dev",
      deps: { fetchImpl: fakeFetch({ license: LICENSE }), verifyImpl: () => true },
    });
    assert.equal(r.written, false);
    assert.equal(fs.existsSync(path.join(repoRoot, "kodela.license.json")), false);
  });

  test("errors clearly when no billing URL is configured", async () => {
    const prev = process.env["KODELA_BILLING_URL"];
    delete process.env["KODELA_BILLING_URL"];
    try {
      await assert.rejects(
        runActivate({ repoRoot: tmpRepo(), token: "kdl_act_abc", deps: { fetchImpl: fakeFetch({}), verifyImpl: () => true } }),
        /KODELA_BILLING_URL/,
      );
    } finally {
      if (prev !== undefined) process.env["KODELA_BILLING_URL"] = prev;
    }
  });
});

describe("runLicenseStatus", () => {
  test("reports free tier when no license is installed", async () => {
    const s = await runLicenseStatus({ repoRoot: tmpRepo(), deps: { loadLicenseImpl: async () => null } });
    assert.equal(s.present, false);
    assert.equal(s.plan, "free");
    assert.equal(s.effective, false);
  });

  test("reports plan, features and expiry for an installed license", async () => {
    const s = await runLicenseStatus({ repoRoot: tmpRepo(), deps: { loadLicenseImpl: async () => LICENSE } });
    assert.equal(s.present, true);
    assert.equal(s.plan, "pro");
    assert.equal(s.orgId, "org_fixed");
    assert.equal(s.expired, false);
    assert.deepEqual(s.features, ["search", "dashboard"]);
  });

  test("flags an expired license", async () => {
    const expired: KodelaLicense = { ...LICENSE, expiresAt: "2000-01-01" };
    const s = await runLicenseStatus({ repoRoot: tmpRepo(), deps: { loadLicenseImpl: async () => expired } });
    assert.equal(s.expired, true);
    assert.equal(s.effective, false);
  });
});
