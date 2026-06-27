// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Offline license signature verification (Ed25519).
 *
 * A license is "signed" when it carries `keyId` + `signature`. The signature is
 * computed by the issuer over the **canonical claims** — the license object with
 * the `signature` field removed and keys serialized in a stable order. Clients
 * verify it against the embedded public key named by `keyId` (see `keys.ts`),
 * with no network call.
 *
 * This module is pure crypto + serialization. Whether an *unsigned* license is
 * honoured is a policy decision made in `resolver.ts` via the enforcement flag —
 * verification here only answers "is this signature cryptographically valid?".
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { KodelaLicense } from "./types.js";
import { findSigningKey, publicKeyRegistry } from "./keys.js";

/**
 * Produce the canonical byte string that the signature is computed over.
 *
 * Rules (must match the issuer in `scripts/licensing/sign-license.mjs`):
 *  - Drop the `signature` field (you can't sign your own signature).
 *  - Keep `keyId` IN the signed payload, so a signature can't be replayed under
 *    a different key id.
 *  - Serialize with keys sorted lexicographically and arrays left in order, so
 *    the bytes are identical regardless of how the JSON was originally written.
 */
export function canonicalClaims(license: KodelaLicense): string {
  const { signature: _omit, ...claims } = license as KodelaLicense & {
    signature?: string;
  };
  return stableStringify(claims);
}

/** Deterministic JSON.stringify with lexicographically sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Verify a license's Ed25519 signature against the trusted public keys.
 *
 * @param license   the parsed license
 * @param publicKeys optional `{ keyId -> base64(SPKI DER) }` override (tests);
 *                   defaults to the embedded production/dev registry.
 * @returns true only if the license is signed, names a known `keyId`, and the
 *          signature verifies over the canonical claims. False otherwise —
 *          including the unsigned case (no `keyId`/`signature`).
 */
export function verifyLicenseSignature(
  license: KodelaLicense,
  publicKeys: Record<string, string> = publicKeyRegistry(),
): boolean {
  if (!license.keyId || !license.signature) return false;
  const spkiBase64 = publicKeys[license.keyId];
  if (!spkiBase64) return false;

  try {
    const publicKey = createPublicKey({
      key: Buffer.from(spkiBase64, "base64"),
      format: "der",
      type: "spki",
    });
    const message = Buffer.from(canonicalClaims(license), "utf-8");
    const signature = Buffer.from(license.signature, "base64");
    // Ed25519: algorithm arg must be null.
    return cryptoVerify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

/** True if the license carries a signature envelope (`keyId` + `signature`). */
export function isLicenseSigned(license: KodelaLicense): boolean {
  return Boolean(license.keyId && license.signature);
}

/** Convenience: look up the issuing key's metadata for a license, if known. */
export function signingKeyFor(license: KodelaLicense) {
  return license.keyId ? findSigningKey(license.keyId) : undefined;
}
