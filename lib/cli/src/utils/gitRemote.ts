// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Repo-identity resolution moved to @kodela/core so the CLI and the MCP server
 * share it. Re-exported here for the CLI's existing import paths.
 */
export {
  parseRepoIdentity,
  resolveRepoIdentity,
  type RepoIdentity,
  type RepoProvider,
} from "@kodela/core";
