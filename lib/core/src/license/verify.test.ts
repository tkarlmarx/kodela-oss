// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  canonicalClaims,
  verifyLicenseSignature,
  isLicenseSigned,
} from "./verify.js";
import {
  licenseHasFeature,
  assessLicense,
  signatureEnforcementEnabled,
  LICENSE_ENFORCE_SIGNATURE_ENV,
} from "./resolver.js";
import type { KodelaLicense } from "./types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Mint a throwaway Ed25519 keypair and a helper that signs claims with it. */
function makeIssuer(keyId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spkiB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const registry: Record<string, string> = { [keyId]: spkiB64 };

  function sign(claims: Omit<KodelaLicense, "signature">): KodelaLicense {
    const withKey = { ...claims, keyId };
    const message = Buffer.from(canonicalClaims(withKey as KodelaLicense), "utf-8");
    const signature = edSign(null, message, privateKey).toString("base64");
    return { ...withKey, signature };
  }

  return { registry, sign, spkiB64 };
}

const BASE: Omit<KodelaLicense, "signature"> = {
  plan: "team",
  features: ["dashboard", "ci_enforcement"],
  orgId: "org_acme",
  expiresAt: tomorrow(),
  maxSeats: 10,
};

// ── canonicalClaims ──────────────────────────────────────────────────────────

describe("canonicalClaims", () => {
  test("is stable regardless of key insertion order", () => {
    const a = canonicalClaims({ plan: "team", features: [], orgId: "o", expiresAt: "2099-01-01" } as KodelaLicense);
    const b = canonicalClaims({ expiresAt: "2099-01-01", orgId: "o", features: [], plan: "team" } as KodelaLicense);
    assert.equal(a, b);
  });

  test("excludes the signature field but keeps keyId", () => {
    const c = canonicalClaims({
      plan: "team", features: [], orgId: "o", expiresAt: "2099-01-01",
      keyId: "k1", signature: "AAAA",
    } as KodelaLicense);
    assert.ok(c.includes('"keyId":"k1"'));
    assert.ok(!c.includes("signature"));
  });
});

// ── verifyLicenseSignature ───────────────────────────────────────────────────

describe("verifyLicenseSignature", () => {
  test("verifies a correctly signed license", () => {
    const issuer = makeIssuer("k-test-1");
    const lic = issuer.sign(BASE);
    assert.equal(verifyLicenseSignature(lic, issuer.registry), true);
  });

  test("rejects an unsigned license", () => {
    assert.equal(verifyLicenseSignature(BASE as KodelaLicense, {}), false);
    assert.equal(isLicenseSigned(BASE as KodelaLicense), false);
  });

  test("rejects a tampered claim (feature added after signing)", () => {
    const issuer = makeIssuer("k-test-2");
    const lic = issuer.sign(BASE);
    const tampered: KodelaLicense = { ...lic, features: [...lic.features, "sso"] };
    assert.equal(verifyLicenseSignature(tampered, issuer.registry), false);
  });

  test("rejects a tampered orgId", () => {
    const issuer = makeIssuer("k-test-3");
    const lic = issuer.sign(BASE);
    assert.equal(verifyLicenseSignature({ ...lic, orgId: "attacker" }, issuer.registry), false);
  });

  test("rejects an unknown keyId", () => {
    const issuer = makeIssuer("k-known");
    const lic = issuer.sign(BASE);
    // Verify against a registry that doesn't contain the key.
    assert.equal(verifyLicenseSignature(lic, { "k-other": issuer.spkiB64 }), false);
  });

  test("rejects when keyId is swapped (signature bound to original keyId)", () => {
    const issuer = makeIssuer("k-orig");
    const lic = issuer.sign(BASE);
    const swapped: KodelaLicense = { ...lic, keyId: "k-evil" };
    assert.equal(verifyLicenseSignature(swapped, { "k-evil": issuer.spkiB64 }), false);
  });

  test("rejects garbage signature without throwing", () => {
    const issuer = makeIssuer("k-test-4");
    const lic = issuer.sign(BASE);
    assert.equal(verifyLicenseSignature({ ...lic, signature: "!!!notbase64!!!" }, issuer.registry), false);
  });
});

// ── enforcement flag + licenseHasFeature integration ─────────────────────────

describe("signature enforcement in licenseHasFeature", () => {
  const ORIG = process.env[LICENSE_ENFORCE_SIGNATURE_ENV];
  afterEach(() => {
    if (ORIG === undefined) delete process.env[LICENSE_ENFORCE_SIGNATURE_ENV];
    else process.env[LICENSE_ENFORCE_SIGNATURE_ENV] = ORIG;
  });

  test("default (no env) is warn-only: unsigned license still grants features", () => {
    delete process.env[LICENSE_ENFORCE_SIGNATURE_ENV];
    assert.equal(signatureEnforcementEnabled(), false);
    assert.equal(licenseHasFeature(BASE as KodelaLicense, "dashboard"), true);
  });

  test("with enforcement on, an unsigned license grants nothing", () => {
    process.env[LICENSE_ENFORCE_SIGNATURE_ENV] = "true";
    assert.equal(signatureEnforcementEnabled(), true);
    assert.equal(licenseHasFeature(BASE as KodelaLicense, "dashboard"), false);
  });

  test("enforcement accepts '1' as truthy", () => {
    process.env[LICENSE_ENFORCE_SIGNATURE_ENV] = "1";
    assert.equal(signatureEnforcementEnabled(), true);
  });
});

// ── assessLicense ────────────────────────────────────────────────────────────

describe("assessLicense", () => {
  const ORIG = process.env[LICENSE_ENFORCE_SIGNATURE_ENV];
  afterEach(() => {
    if (ORIG === undefined) delete process.env[LICENSE_ENFORCE_SIGNATURE_ENV];
    else process.env[LICENSE_ENFORCE_SIGNATURE_ENV] = ORIG;
  });

  test("null license → not present, not effective", () => {
    const a = assessLicense(null);
    assert.equal(a.present, false);
    assert.equal(a.effective, false);
  });

  test("unsigned + warn-only → effective true but signed false", () => {
    delete process.env[LICENSE_ENFORCE_SIGNATURE_ENV];
    const a = assessLicense(BASE as KodelaLicense);
    assert.equal(a.present, true);
    assert.equal(a.signed, false);
    assert.equal(a.effective, true);
  });

  test("unsigned + enforced → effective false (will block)", () => {
    process.env[LICENSE_ENFORCE_SIGNATURE_ENV] = "true";
    const a = assessLicense(BASE as KodelaLicense);
    assert.equal(a.signed, false);
    assert.equal(a.effective, false);
  });
});
