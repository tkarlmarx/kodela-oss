// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { LocalStorageBackend } from "./local-backend.js";
import { CentralStorageBackend, type CentralBackendConfig } from "./central-backend.js";
import type { StorageBackend } from "./backend.js";

export type StorageMode = "local" | "central" | "saas";

export interface StorageFactoryOptions {
  /**
   * The active storage mode.  Resolution priority (highest first):
   *   1. Explicit `opts.mode` argument (used by tests + the CLI which is
   *      always "local" per doc 28 §3.4 line 105)
   *   2. `KODELA_DEPLOYMENT_MODE` env var (read by api-server + SaaS-mode
   *      mcp-server at boot)
   *   3. Default `"local"`
   */
  mode?: StorageMode;
  central?: CentralBackendConfig;
  /**
   * SaaS (multi-tenant Postgres) backend config. Not available in the Community
   * Edition — the SaaS backend lives in the upstream commercial repository.
   */
  sql?: never;
}

let _singleton: StorageBackend | null = null;

/**
 * Resolve the storage mode.  Explicit `opts.mode` wins; otherwise read the
 * `KODELA_DEPLOYMENT_MODE` env var (doc 28 §3.4); default `"local"`.
 */
function resolveMode(opts: StorageFactoryOptions): StorageMode {
  if (opts.mode) return opts.mode;
  const env = process.env.KODELA_DEPLOYMENT_MODE;
  if (env === "saas" || env === "central" || env === "local") return env;
  return "local";
}

/**
 * Synchronous factory — supports "local" and "central" only.  For "saas"
 * use {@link createStorageBackendAsync} because SqlBackend's `@workspace/db`
 * dependency is lazy-imported to keep the CLI bundle free of `pg`/drizzle.
 */
export function createStorageBackend(opts: StorageFactoryOptions = {}): StorageBackend {
  const mode = resolveMode(opts);

  if (mode === "saas") {
    throw new Error(
      "createStorageBackend (sync) does not support mode='saas' — " +
        "use createStorageBackendAsync(opts) instead.  The sync factory is " +
        "for the CLI/local path which never reaches SaaS mode (doc 28 §3.4).",
    );
  }

  if (mode === "central") {
    if (!opts.central) {
      throw new Error(
        "Gap 60: storage mode 'central' requires a central backend config " +
          "(serverUrl and apiKey). Check your kodela.config.json storage block.",
      );
    }
    return new CentralStorageBackend(opts.central);
  }

  return new LocalStorageBackend();
}

/**
 * Async factory — required for mode='saas' so SqlBackend's `@workspace/db`
 * import (which pulls in `pg` + drizzle-orm) only loads when actually used.
 *
 * Local and Central modes also work through this entrypoint — server-side
 * callers (api-server, SaaS-mode mcp-server) should prefer this so they don't
 * branch on the mode at the call site.
 */
export async function createStorageBackendAsync(
  opts: StorageFactoryOptions = {},
): Promise<StorageBackend> {
  const mode = resolveMode(opts);

  if (mode === "saas") {
    throw new Error(
      "Storage mode 'saas' (multi-tenant Postgres) is not available in the " +
        "Kodela Community Edition. Use mode 'local' (SQLite). The SaaS backend " +
        "is part of the commercial edition.",
    );
  }

  // Local + central reuse the sync path.
  return createStorageBackend(opts);
}

export function getStorageBackend(opts?: StorageFactoryOptions): StorageBackend {
  if (!_singleton) {
    _singleton = createStorageBackend(opts ?? {});
  }
  return _singleton;
}

export function resetStorageBackend(): void {
  _singleton = null;
}
