// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
//
// Community Edition: the MCP server is always local SQLite. The multi-tenant
// Postgres / SaaS storage backend lives in the upstream (commercial)
// repository, so this resolver never returns a remote backend.
//
// The shape mirrors the full implementation so the MCP server boot code
// (artifacts/mcp-server/src/index.ts) compiles and runs unchanged — it simply
// always gets `backend: null` and writes to the local store.

import type { StorageBackend, StorageMode } from "@kodela/core";

/** Tenant resolution contract (unused in the Community Edition). */
export interface TenantResolver {
  resolveOrgId(repoRoot: string): Promise<string>;
  resolveRepoId(repoRoot: string): Promise<string>;
}

/** Resolve deployment mode from env. Community honours only `local`/`central`. */
export function resolveDeploymentMode(): StorageMode {
  const env = process.env["KODELA_DEPLOYMENT_MODE"];
  if (env === "central" || env === "local") return env;
  return "local";
}

export interface DeploymentStorage {
  mode: StorageMode;
  backend: StorageBackend | null;
  tenant: { orgId: string; repoId: string } | null;
  warnings: string[];
}

/**
 * Community Edition always resolves to local storage. When `DATABASE_URL` or a
 * `saas` deployment mode is configured we surface a clear warning rather than
 * silently pretending Postgres is wired — that feature is upstream-only.
 */
export async function initDeploymentStorage(
  _repoRoot: string,
): Promise<DeploymentStorage> {
  const warnings: string[] = [];
  if (process.env["KODELA_DEPLOYMENT_MODE"] === "saas" || process.env["DATABASE_URL"]) {
    warnings.push(
      "SaaS / Postgres storage is not available in the Community Edition — " +
        "MCP context is written to the local store only. The multi-tenant " +
        "backend lives in the commercial edition.",
    );
  }
  return { mode: "local", backend: null, tenant: null, warnings };
}
