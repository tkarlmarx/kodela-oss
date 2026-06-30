// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { z } from "zod/v4";

/**
 * All gated capabilities in the Kodela open-core model.
 *
 * Free tier: CLI + local tracking — no features required.
 * Team/Paid tier: ci_enforcement, pr_checks, dashboard, search.
 * Enterprise tier: sso, audit_logs, policy_engine, retroactive_scan.
 */
export const KodelaFeatureSchema = z.enum([
  "dashboard",
  "policy_engine",
  "ci_enforcement",
  "pr_checks",
  "retroactive_scan",
  "search",
  "sso",
  "audit_logs",
  "rbac",
  "data_export",
  "security",
]);

export type KodelaFeature = z.infer<typeof KodelaFeatureSchema>;

export const KODELA_FEATURES: readonly KodelaFeature[] = KodelaFeatureSchema.options;

export const KodelaLicensePlanSchema = z.enum(["free", "pro", "team", "enterprise"]);

export type KodelaLicensePlan = z.infer<typeof KodelaLicensePlanSchema>;

/**
 * Zod schema for `kodela.license.json`.
 *
 * `expiresAt` must be an ISO date string in `YYYY-MM-DD` format.
 * `features` is the explicit list of granted capabilities for this license;
 * consumers must always check via `licenseHasFeature()` rather than
 * inspecting `plan` directly.
 *
 * Signature envelope (`keyId` + `signature`) is OPTIONAL at the schema level so
 * that (a) older unsigned files still parse during the warn-only rollout, and
 * (b) the canonical claims can be computed by stripping `signature`. Whether an
 * unsigned license is *honoured* is decided by the resolver's enforcement flag,
 * not by the schema. See `verify.ts`.
 */
export const KodelaLicenseSchema = z.object({
  plan: KodelaLicensePlanSchema,
  features: z.array(KodelaFeatureSchema),
  orgId: z.string().min(1, "orgId must be a non-empty string"),
  expiresAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expiresAt must be a date in YYYY-MM-DD format"),
  apiSecret: z
    .string()
    .min(16, "apiSecret must be at least 16 characters")
    .optional(),
  /**
   * Maximum number of active seats (members) this license permits. Enforced by
   * the server's seat-counting layer (see api-server). Absent ⇒ unlimited
   * (e.g. enterprise custom) or not-yet-issued-with-seats.
   */
  maxSeats: z.number().int().positive().optional(),
  /**
   * Identifier of the Ed25519 signing key used to sign this license. Lets us
   * rotate keys without invalidating outstanding licenses — the verifier looks
   * the public key up by this id. Required for signed licenses.
   */
  keyId: z.string().min(1).optional(),
  /**
   * Base64-encoded Ed25519 signature over the canonical claims (the license
   * object with `signature` removed; see `canonicalClaims()`). Required for
   * signed licenses.
   */
  signature: z.string().min(1).optional(),
  /**
   * Phase 5.9 (internal design note) — admin role enforcement.
   *
   * Identities (matched against the SSO session's `email` claim) that are
   * permitted to call destructive admin operations (RTBF, audit export,
   * capture-policy edits).
   *
   * The IdP-claim path is the preferred grant: when the OIDC provider returns
   * a `groups`/`roles` claim containing one of `adminRoleNames`, that's
   * authoritative. This `adminEmails` field is the fallback for IdPs that
   * don't expose group membership in claims (or for break-glass access).
   */
  adminEmails: z.array(z.string().email()).optional(),
  /**
   * OIDC group/role names that grant admin. Default: `["admin", "kodela-admin"]`.
   * Checked against the `groups`, `roles`, `cognito:groups`, and `realm_access.roles`
   * claims (covers Okta, Google Workspace, Azure AD, Cognito, Keycloak shapes).
   */
  adminRoleNames: z.array(z.string().min(1)).optional(),
});

export type KodelaLicense = z.infer<typeof KodelaLicenseSchema>;
