// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Shared org_id resolution for MCP tools.
 *
 * Doc 08 §1 makes org-scoping the storage-layer invariant: "Every row Kodela
 * writes belongs to exactly one org_id" and the original blocker was code that
 * silently coerces a missing org to "default". This helper centralizes that
 * resolution so there is exactly one place that decides what an absent org_id
 * means.
 *
 * Two modes (doc 24 W3 — retire `_default` on the authenticated path):
 *  - **Free / local (default):** an absent or blank org resolves to the
 *    single-tenant `_default` sentinel, so zero-config local use stays
 *    frictionless (no account, no org).
 *  - **Authenticated / multi-tenant:** when `KODELA_REQUIRE_ORG` is set, a
 *    missing org is an ERROR instead of a silent default — the server/enterprise
 *    deployment must pass an explicit org from the session/license. This is how
 *    the `_default` fallback is retired without breaking the free path.
 *
 * Keep the sentinel in sync with decisions-store.ts (`DEFAULT_ORG`).
 */

/** Single-tenant MVP sentinel. The one org every row belongs to until tenancy. */
export const DEFAULT_ORG = "_default" as const;

/**
 * Env var that retires the `_default` fallback. Set it on authenticated /
 * multi-tenant deployments (the API server) so a missing org_id fails loudly
 * instead of silently writing to the shared `_default` org. Accepts "1"/"true".
 */
export const REQUIRE_ORG_ENV = "KODELA_REQUIRE_ORG";

export function orgIsRequired(): boolean {
  const v = process.env[REQUIRE_ORG_ENV];
  return v === "1" || v?.toLowerCase() === "true";
}

/**
 * Resolve the effective org_id for a tool call.
 *
 * @throws when org is absent/blank AND `KODELA_REQUIRE_ORG` is set — the
 *         authenticated path must not fall back to `_default`.
 */
export function resolveOrgId(orgId?: string | null): string {
  const trimmed = orgId?.trim();
  if (trimmed && trimmed.length > 0) return trimmed;
  if (orgIsRequired()) {
    throw new Error(
      `org_id is required: ${REQUIRE_ORG_ENV} is set, so the '_default' fallback is disabled on this ` +
        `multi-tenant deployment. Pass an explicit org_id (from the session/license).`,
    );
  }
  return DEFAULT_ORG;
}

