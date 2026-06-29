// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela activate <token>` and `kodela license` — close the BR-MON-6 funnel.
 *
 * After payment the billing webhook issues a signed license server-side; the
 * paying user still needs it on their machine. `activate` exchanges the opaque
 * org-scoped activation token (printed by the success page / emailed) for the
 * org's latest signed license via `GET $KODELA_BILLING_URL/license` and writes
 * it to `kodela.license.json` at the repo root, where `loadLicense` finds it.
 *
 * Community-side only: NO billing secrets here. The license is signed by the
 * billing service's private key; the CLI only *verifies* it offline using the
 * public-key registry baked into core. An unverifiable license is rejected
 * before it touches disk so a malicious server can't plant a forged one.
 *
 * `license` is a read-only status command: it loads the current license and
 * prints plan / features / expiry / signature trust without any network call.
 */
import fs from "node:fs";
import path from "node:path";
import {
  LICENSE_FILE_NAME,
  loadLicense,
  isLicenseExpired,
  assessLicense,
  verifyLicenseSignature,
  KodelaLicenseSchema,
  type KodelaLicense,
} from "@kodela/core";

export interface ActivateOptions {
  repoRoot: string;
  token: string;
  billingUrl?: string;
  /** Resolve to the license path without writing (dry-run preview). */
  print?: boolean;
  /** Test injection. */
  deps?: Partial<ActivateDeps>;
}

export interface ActivateDeps {
  fetchImpl: typeof fetch;
  /** Verify a license's signature offline. Returns true when trusted. */
  verifyImpl: (license: KodelaLicense) => boolean;
}

export interface ActivateResult {
  orgId: string;
  plan: string;
  expiresAt: string;
  features: string[];
  licensePath: string;
  written: boolean;
  signatureValid: boolean;
}

/** Resolve the billing service base URL, trimming a trailing slash. */
function resolveBillingUrl(explicit: string | undefined): string {
  const url = (explicit ?? process.env["KODELA_BILLING_URL"] ?? "").replace(/\/$/, "");
  if (!url) {
    throw new Error(
      "no billing service URL — pass --billing-url <url> or set KODELA_BILLING_URL",
    );
  }
  return url;
}

export async function runActivate(opts: ActivateOptions): Promise<ActivateResult> {
  const deps: ActivateDeps = {
    fetchImpl: opts.deps?.fetchImpl ?? (fetch as typeof fetch),
    verifyImpl: opts.deps?.verifyImpl ?? ((lic) => verifyLicenseSignature(lic)),
  };
  const token = opts.token?.trim();
  if (!token) throw new Error("missing activation token (kodela activate <token>)");
  const billingUrl = resolveBillingUrl(opts.billingUrl);

  let res: Response;
  try {
    res = await deps.fetchImpl(`${billingUrl}/license`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new Error(
      `billing service unreachable (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const data = (await res.json().catch(() => ({}))) as { license?: unknown; error?: string };
  if (res.status === 401) throw new Error("activation token rejected (401) — check the token");
  if (res.status === 404) {
    throw new Error("no license for this token yet (404) — payment may still be processing");
  }
  if (!res.ok) throw new Error(`billing service error (${res.status}): ${data.error ?? "unknown"}`);

  // Validate shape before trusting anything from the network.
  const parsed = KodelaLicenseSchema.safeParse(data.license);
  if (!parsed.success) {
    throw new Error("billing service returned a malformed license");
  }
  const license = parsed.data;

  // Verify the signature offline. A server we don't fully trust cannot plant a
  // forged license: the signature must validate against core's public-key
  // registry. (We still write expired licenses so `kodela license` can explain
  // why a renewal is needed — but never an unsigned/forged one.)
  const signatureValid = deps.verifyImpl(license);
  if (!signatureValid) {
    throw new Error(
      "license signature did not verify against the trusted key registry — refusing to install",
    );
  }

  const licensePath = path.join(opts.repoRoot, LICENSE_FILE_NAME);
  const result: ActivateResult = {
    orgId: license.orgId,
    plan: license.plan,
    expiresAt: license.expiresAt,
    features: license.features,
    licensePath,
    written: false,
    signatureValid,
  };
  if (opts.print) return result;

  fs.writeFileSync(licensePath, JSON.stringify(license, null, 2) + "\n");
  result.written = true;
  return result;
}

export function formatActivateResult(r: ActivateResult): string {
  const lines = [
    r.written
      ? `✓ Activated ${r.plan} license for org ${r.orgId}`
      : `License for org ${r.orgId} (${r.plan}) — not written (--print)`,
    `  expires:  ${r.expiresAt}`,
    `  features: ${r.features.length ? r.features.join(", ") : "(none)"}`,
    `  signature: ${r.signatureValid ? "verified" : "UNVERIFIED"}`,
    `  path:     ${r.licensePath}`,
  ];
  return lines.join("\n");
}

// ─── kodela license — read-only status ───────────────────────────────────────

export interface LicenseStatusOptions {
  repoRoot: string;
  /** Test injection. */
  deps?: { loadLicenseImpl?: (repoRoot: string) => Promise<KodelaLicense | null> };
}

export interface LicenseStatus {
  present: boolean;
  plan: string;
  orgId?: string;
  expiresAt?: string;
  expired: boolean;
  features: string[];
  signed: boolean;
  signatureValid: boolean;
  enforced: boolean;
  effective: boolean;
}

export async function runLicenseStatus(opts: LicenseStatusOptions): Promise<LicenseStatus> {
  const load = opts.deps?.loadLicenseImpl ?? ((root: string) => loadLicense(root));
  const license = await load(opts.repoRoot);
  const a = assessLicense(license);
  if (!license) {
    return {
      present: false,
      plan: "free",
      expired: false,
      features: [],
      signed: false,
      signatureValid: false,
      enforced: a.enforced,
      effective: false,
    };
  }
  return {
    present: true,
    plan: license.plan,
    orgId: license.orgId,
    expiresAt: license.expiresAt,
    expired: isLicenseExpired(license),
    features: license.features,
    signed: a.signed,
    signatureValid: a.signatureValid,
    enforced: a.enforced,
    effective: a.effective,
  };
}

export function formatLicenseStatus(s: LicenseStatus): string {
  if (!s.present) {
    return [
      "Plan: free (no license installed)",
      "  Run `kodela upgrade` to purchase, then `kodela activate <token>`.",
    ].join("\n");
  }
  const lines = [
    `Plan: ${s.plan}${s.effective ? "" : "  (not effective)"}`,
    `  org:       ${s.orgId}`,
    `  expires:   ${s.expiresAt}${s.expired ? "  (EXPIRED)" : ""}`,
    `  features:  ${s.features.length ? s.features.join(", ") : "(none)"}`,
    `  signature: ${s.signed ? (s.signatureValid ? "verified" : "INVALID") : "unsigned"}` +
      (s.enforced ? " — enforced" : " — warn-only"),
  ];
  if (!s.effective) {
    lines.push(
      s.expired
        ? "  → license expired; run `kodela upgrade` to renew."
        : "  → license not effective; signature must verify once enforcement is on.",
    );
  }
  return lines.join("\n");
}
