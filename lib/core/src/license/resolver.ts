// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { KodelaLicenseSchema, type KodelaFeature, type KodelaLicense } from "./types.js";
import { verifyLicenseSignature, isLicenseSigned } from "./verify.js";

export const LICENSE_FILE_NAME = "kodela.license.json";

/**
 * Env var that flips signature enforcement on.
 *
 * Rollout (doc 24 W2): ships default-OFF for one release (warn-only — unsigned
 * licenses still work so existing customers aren't bricked), then defaults ON.
 * Accepts "1" or "true" (case-insensitive).
 */
export const LICENSE_ENFORCE_SIGNATURE_ENV = "KODELA_LICENSE_ENFORCE_SIGNATURE";

export function signatureEnforcementEnabled(): boolean {
  const v = process.env[LICENSE_ENFORCE_SIGNATURE_ENV];
  return v === "1" || v?.toLowerCase() === "true";
}

/**
 * Name of the environment variable used to inject a license in CI/CD
 * environments where writing a file to disk is inconvenient.
 *
 * Accepted values:
 *   - Inline JSON: a string starting with `{` containing the license object.
 *   - File path: an absolute or relative path to a `kodela.license.json` file.
 */
export const LICENSE_ENV_VAR = "KODELA_LICENSE";

/**
 * Parse raw JSON (already decoded to a JS value) into a KodelaLicense.
 * Returns `null` on any validation error so callers treat invalid licenses
 * the same as missing ones (free tier).
 */
function parseLicense(raw: unknown): KodelaLicense | null {
  const result = KodelaLicenseSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Check whether a license has expired based on the current UTC date.
 * Expiry is inclusive: a license with `expiresAt = today` is still valid.
 */
export function isLicenseExpired(license: KodelaLicense): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return license.expiresAt < today;
}

/**
 * Load a `KodelaLicense` from the following sources, in priority order:
 *
 * 1. `KODELA_LICENSE` environment variable:
 *    a. If the value starts with `{`, treat it as inline JSON.
 *    b. Otherwise, treat it as a file path and read + parse that file.
 * 2. `explicitPath` — an absolute path to a license file supplied by the caller
 *    (e.g. from the `license` key in `kodela.config.json`).
 * 3. Walk up the directory tree from `repoRoot` (defaults to `process.cwd()`)
 *    looking for a `kodela.license.json` file.
 *
 * Returns `null` when:
 * - No license source is found.
 * - The license JSON is malformed or fails Zod validation.
 * - Any file-system error occurs (file unreadable, directory not accessible).
 *
 * Never throws. A `null` return means the caller should fall back to free-tier
 * behaviour.
 */
export async function loadLicense(
  repoRoot?: string,
  explicitPath?: string,
): Promise<KodelaLicense | null> {
  const envValue = process.env[LICENSE_ENV_VAR];

  if (envValue !== undefined && envValue.trim().length > 0) {
    try {
      const trimmed = envValue.trim();
      if (trimmed.startsWith("{")) {
        return parseLicense(JSON.parse(trimmed) as unknown);
      } else {
        const raw = await fs.readFile(trimmed, "utf-8");
        return parseLicense(JSON.parse(raw) as unknown);
      }
    } catch {
      return null;
    }
  }

  if (explicitPath !== undefined && explicitPath.trim().length > 0) {
    try {
      const raw = await fs.readFile(explicitPath, "utf-8");
      return parseLicense(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  const startDir = repoRoot !== undefined ? repoRoot : process.cwd();
  let current = path.resolve(startDir);
  const fsRoot = path.parse(current).root;

  while (true) {
    const candidate = path.join(current, LICENSE_FILE_NAME);
    try {
      const raw = await fs.readFile(candidate, "utf-8");
      return parseLicense(JSON.parse(raw) as unknown);
    } catch {
      // not found or invalid — continue walking up
    }

    if (current === fsRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

/**
 * Synchronously check whether a preloaded license grants a specific feature.
 *
 * Returns `false` when:
 * - `license` is `null` (free tier — no license file found).
 * - The license has expired.
 * - The feature is not present in `license.features`.
 *
 * Pure function — no I/O, no side effects.
 */
export function licenseHasFeature(
  license: KodelaLicense | null,
  feature: KodelaFeature,
): boolean {
  if (license === null) return false;
  if (isLicenseExpired(license)) return false;
  // Signature gate. When enforcement is on, an unsigned or tampered license is
  // treated as free tier (no feature granted). When off (warn-only rollout),
  // the signature is not required — callers can surface a warning via
  // assessLicense().
  if (signatureEnforcementEnabled() && !verifyLicenseSignature(license)) return false;
  return license.features.includes(feature);
}

/** A snapshot of a license's trust state — for logging during the rollout. */
export interface LicenseAssessment {
  present: boolean;
  expired: boolean;
  signed: boolean;
  signatureValid: boolean;
  enforced: boolean;
  /** Whether this license is honoured for feature checks right now. */
  effective: boolean;
}

/**
 * Diagnose a license without granting/denying a specific feature. Use this to
 * log a warning during the warn-only phase, e.g.:
 *   "unsigned license — will stop working once signature enforcement is on".
 */
export function assessLicense(license: KodelaLicense | null): LicenseAssessment {
  const enforced = signatureEnforcementEnabled();
  if (license === null) {
    return { present: false, expired: false, signed: false, signatureValid: false, enforced, effective: false };
  }
  const expired = isLicenseExpired(license);
  const signed = isLicenseSigned(license);
  const signatureValid = signed && verifyLicenseSignature(license);
  const effective = !expired && (!enforced || signatureValid);
  return { present: true, expired, signed, signatureValid, enforced, effective };
}

/**
 * Async convenience wrapper: load the license from disk/env and check a
 * single feature in one call.
 *
 * Equivalent to:
 * ```ts
 * licenseHasFeature(await loadLicense(repoRoot), feature)
 * ```
 *
 * Returns `false` on any error (no license file, invalid JSON, expired).
 */
export async function hasFeature(
  feature: KodelaFeature,
  repoRoot?: string,
): Promise<boolean> {
  const license = await loadLicense(repoRoot);
  return licenseHasFeature(license, feature);
}
