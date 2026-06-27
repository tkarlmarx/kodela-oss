// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Admin-role resolution — Phase 5.9 / doc 26.
 *
 * Two paths grant admin (either succeeds, both are checked):
 *
 *   1. **OIDC claim** — the SSO ID token includes a group/role membership the
 *      license's `adminRoleNames` lists. Preferred path: the IdP is the
 *      source of truth for who is staff, and revoking the group in Okta /
 *      Google / Azure AD instantly revokes Kodela admin.
 *
 *   2. **License `adminEmails`** — fallback for IdPs that don't expose group
 *      membership in claims, plus break-glass access (board observer, vendor
 *      auditor) where group membership in the customer's IdP isn't reachable.
 *
 * Multiple OIDC claim shapes are supported because every provider names this
 * differently:
 *
 *   - Okta / Google Workspace:   `groups: ["admin", "engineering"]`
 *   - Generic OIDC:              `roles: ["admin"]`
 *   - AWS Cognito:               `cognito:groups: ["admin"]`
 *   - Keycloak:                  `realm_access: { roles: ["admin"] }`
 *
 * All resolvers are pure functions — no IO. The Express middleware
 * (`requireAdmin`) does the IO (license load, session verify) and passes the
 * claims here.
 */

import type { KodelaLicense } from "./types.js";

const DEFAULT_ADMIN_ROLE_NAMES: ReadonlyArray<string> = ["admin", "kodela-admin"];

/**
 * Extract the set of role/group names from an OIDC claim bag.
 *
 * Walks `groups`, `roles`, `cognito:groups`, and `realm_access.roles` —
 * normalising each into a single string array.  Returns `[]` when the bag
 * has no recognisable role claims (so the caller can fall through to the
 * email allowlist without throwing).
 */
export function extractIdpRoles(claims: Record<string, unknown>): string[] {
  const out: string[] = [];

  const addArray = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === "string" && v.length > 0) out.push(v);
      }
    }
  };

  addArray(claims["groups"]);
  addArray(claims["roles"]);
  addArray(claims["cognito:groups"]);
  // Keycloak's nested realm_access.roles.
  const realmAccess = claims["realm_access"];
  if (realmAccess && typeof realmAccess === "object") {
    addArray((realmAccess as Record<string, unknown>)["roles"]);
  }

  return out;
}

/**
 * The set of role names that grant admin.  Comes from the license, falling
 * back to a sensible default when the license doesn't override it.
 */
export function effectiveAdminRoleNames(license: KodelaLicense | null): ReadonlyArray<string> {
  const fromLicense = license?.adminRoleNames;
  if (fromLicense && fromLicense.length > 0) return fromLicense;
  return DEFAULT_ADMIN_ROLE_NAMES;
}

/**
 * Has the IdP-claim path granted admin? True when any of the user's roles
 * matches one of the configured admin role names.
 *
 * Comparison is case-insensitive to handle IdPs that uppercase / lowercase
 * group names inconsistently (Cognito has been observed to do this).
 */
export function isAdminViaClaim(license: KodelaLicense | null, userRoles: ReadonlyArray<string>): boolean {
  const adminNames = effectiveAdminRoleNames(license).map((s) => s.toLowerCase());
  for (const r of userRoles) {
    if (adminNames.includes(r.toLowerCase())) return true;
  }
  return false;
}

/**
 * Has the license-email path granted admin? True when the verified email is
 * in the license's `adminEmails` list. Comparison is case-insensitive (RFC
 * 5321 says local-part case matters; in practice nobody cares — being lenient
 * here matches real-world auth provider behaviour).
 */
export function isAdminViaEmail(license: KodelaLicense | null, verifiedEmail: string | undefined): boolean {
  if (!verifiedEmail) return false;
  if (!license?.adminEmails || license.adminEmails.length === 0) return false;
  const normalized = verifiedEmail.toLowerCase();
  return license.adminEmails.some((e) => e.toLowerCase() === normalized);
}

/**
 * Combined admin check: returns the path that granted admin, or `null` when
 * neither does. The string return lets the audit chain entry distinguish
 * "admin via IdP group" from "admin via license fallback" — useful when
 * investigating who actually triggered a destructive op.
 */
export type AdminGrant = "idp_claim" | "license_email";

export interface IsAdminInput {
  license: KodelaLicense | null;
  userEmail: string | undefined;
  userRoles: ReadonlyArray<string>;
}

export function isAdmin({ license, userEmail, userRoles }: IsAdminInput): AdminGrant | null {
  if (isAdminViaClaim(license, userRoles)) return "idp_claim";
  if (isAdminViaEmail(license, userEmail)) return "license_email";
  return null;
}
