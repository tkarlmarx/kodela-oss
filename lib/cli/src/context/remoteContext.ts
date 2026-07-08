// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Shared-memory read client (`storage.readMode`). The implementation now lives
 * in `@kodela/core` so the MCP server can share it; this module re-exports it
 * for the CLI's existing import paths.
 */
export {
  fetchRemoteContext,
  mergeContexts,
  type FetchRemoteContextOptions,
} from "@kodela/core";
