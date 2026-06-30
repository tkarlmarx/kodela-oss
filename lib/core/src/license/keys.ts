// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Embedded Ed25519 **public** signing keys for offline license verification.
 *
 * The matching **private** keys live ONLY in the license-issuing secret store
 * (never in this repo). Clients verify a license's signature against the public
 * key named by the license's `keyId`. Keying by id lets us rotate signing keys
 * without invalidating licenses already in the field: add the new public key
 * here, start signing new licenses with the new `keyId`, and keep the old key
 * present until every license signed with it has expired.
 *
 * Key format: base64-encoded SPKI DER (what
 * `crypto.createPublicKey(...).export({ type: "spki", format: "der" })`
 * produces). See `scripts/licensing/gen-license-keypair.mjs` to mint a new
 * keypair and `the project design docs` for the operator
 * runbook.
 */

export interface SigningKey {
  /** Stable identifier embedded in each license's `keyId`. */
  keyId: string;
  /** base64(SPKI DER) of the Ed25519 public key. */
  publicKeySpkiBase64: string;
  /** Optional: keys past this date are no longer used to SIGN (still verify). */
  retiredAfter?: string;
  /** Human note: environment / rotation reason. */
  note?: string;
}

/**
 * Community Edition: no signing keys are bundled.
 *
 * The Community Edition is free and unlicensed — there is no license to verify,
 * so the trusted-key registry is intentionally empty. License verification
 * therefore always declines and the runtime falls back to the free tier.
 * Production/commercial signing keys live ONLY in the upstream private
 * repository and the secret store — never in this public repository.
 */
export const SIGNING_KEYS: readonly SigningKey[] = [];

/** Look up a trusted public key by its id. Returns undefined if unknown. */
export function findSigningKey(keyId: string): SigningKey | undefined {
  return SIGNING_KEYS.find((k) => k.keyId === keyId);
}

/** Public-key registry as a `{ keyId -> base64(SPKI DER) }` map. */
export function publicKeyRegistry(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SIGNING_KEYS) out[k.keyId] = k.publicKeySpkiBase64;
  return out;
}
