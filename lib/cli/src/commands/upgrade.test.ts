// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runUpgrade } from "./upgrade.js";

function fakeFetch(body: object, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const baseDeps = {
  openImpl: () => true,
  loadLicenseImpl: async () => null,
  resolveOrgId: () => "org_fixed",
};

describe("runUpgrade", () => {
  test("uses the billing service checkout URL when reachable", async () => {
    const r = await runUpgrade({
      repoRoot: "/tmp",
      plan: "pro",
      billingUrl: "https://billing.kodela.dev",
      deps: { ...baseDeps, fetchImpl: fakeFetch({ url: "https://checkout.stripe.com/c/pay/cs_1" }) },
    });
    assert.equal(r.source, "checkout-session");
    assert.equal(r.url, "https://checkout.stripe.com/c/pay/cs_1");
    assert.equal(r.orgId, "org_fixed");
    assert.equal(r.opened, true);
  });

  test("falls back to the pricing page when the billing service errors", async () => {
    const r = await runUpgrade({
      repoRoot: "/tmp",
      plan: "team",
      billingUrl: "https://billing.kodela.dev",
      deps: { ...baseDeps, fetchImpl: fakeFetch({ error: "boom" }, false, 500) },
    });
    assert.equal(r.source, "pricing-page");
    assert.match(r.url, /pricing\?org=org_fixed&plan=team/);
    assert.match(r.note ?? "", /declined/);
  });

  test("uses the pricing page when no billing url is configured", async () => {
    const prev = process.env["KODELA_BILLING_URL"];
    delete process.env["KODELA_BILLING_URL"];
    try {
      const r = await runUpgrade({ repoRoot: "/tmp", plan: "pro", deps: { ...baseDeps, fetchImpl: fakeFetch({}) } });
      assert.equal(r.source, "pricing-page");
      assert.match(r.url, /^https:\/\/kodela\.dev\/pricing\?org=org_fixed&plan=pro$/);
    } finally {
      if (prev !== undefined) process.env["KODELA_BILLING_URL"] = prev;
    }
  });

  test("prefers the license org id when present", async () => {
    const r = await runUpgrade({
      repoRoot: "/tmp",
      deps: { ...baseDeps, loadLicenseImpl: async () => ({ orgId: "org_from_license" }), fetchImpl: fakeFetch({}) },
    });
    assert.equal(r.orgId, "org_from_license");
  });

  test("--print does not open a browser", async () => {
    let opened = false;
    const r = await runUpgrade({
      repoRoot: "/tmp",
      print: true,
      deps: { ...baseDeps, openImpl: () => { opened = true; return true; }, fetchImpl: fakeFetch({}) },
    });
    assert.equal(r.opened, false);
    assert.equal(opened, false, "openImpl must not be called with --print");
  });
});
