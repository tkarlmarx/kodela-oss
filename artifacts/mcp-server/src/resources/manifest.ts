// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela://manifest` resource — versioned tool/capability manifest.
 *
 * Per the project design docs §6, the manifest lets AI
 * clients discover the tool surface and feature-flag against it: it publishes
 * the server version, every registered tool with its own version + stability,
 * and the minimum client version Kodela expects per known client.
 *
 * Keep this list in sync with the `server.tool(...)` registrations in index.ts.
 * A tool that is registered but missing here is invisible to client discovery
 * (this is how kodela_get_decision was previously omitted).
 */

export type ToolStability = "stable" | "beta" | "experimental";

export interface ManifestTool {
  name: string;
  version: string;
  stability: ToolStability;
}

export interface KodelaManifest {
  type: "kodela.manifest";
  version: "1.0";
  server_version: string;
  tools: ManifestTool[];
  resources: string[];
  min_client_version: Record<string, string>;
}

/**
 * The registered tool surface. Versions are per-tool and bump independently of
 * the server version when a tool's input/output schema changes.
 */
const TOOLS: ManifestTool[] = [
  { name: "kodela_get_context",        version: "1.2.0", stability: "stable" },
  { name: "kodela_get_context_debug",  version: "1.0.0", stability: "beta" },
  { name: "kodela_annotate",           version: "1.1.0", stability: "stable" },
  { name: "kodela_annotate_file",      version: "1.2.0", stability: "stable" },
  { name: "kodela_session_start",      version: "1.2.0", stability: "stable" },
  { name: "kodela_session_end",        version: "1.2.0", stability: "stable" },
  { name: "kodela_record_decision",    version: "1.0.0", stability: "stable" },
  { name: "kodela_search_decisions",   version: "1.0.0", stability: "beta" },
  { name: "kodela_supersede_decision", version: "1.0.0", stability: "beta" },
  { name: "kodela_get_decision",       version: "1.0.0", stability: "stable" },
  { name: "kodela_record_decision_outcome", version: "1.0.0", stability: "beta" },
  { name: "kodela_list_sessions",      version: "1.0.0", stability: "beta" },
  { name: "kodela_generate_handoff",   version: "1.0.0", stability: "beta" },
  { name: "kodela_query",              version: "1.0.0", stability: "beta" },
  { name: "kodela_get_why",            version: "1.0.0", stability: "beta" },
  { name: "kodela_find_related_changes", version: "1.0.0", stability: "beta" },
  { name: "kodela_get_project_dna",    version: "1.0.0", stability: "beta" },
  { name: "kodela_get_architecture",   version: "1.0.0", stability: "beta" },
  { name: "kodela_get_risks",          version: "1.0.0", stability: "beta" },
];

const RESOURCES: string[] = ["kodela://file/{path}", "kodela://manifest"];

/**
 * Minimum client versions Kodela expects. Clients below these may not
 * understand the current envelope shapes; they should warn or degrade.
 */
const MIN_CLIENT_VERSION: Record<string, string> = {
  "claude-code": "1.0.0",
  cursor: "0.40.0",
};

export function buildManifest(serverVersion: string): KodelaManifest {
  return {
    type: "kodela.manifest",
    version: "1.0",
    server_version: serverVersion,
    tools: TOOLS,
    resources: RESOURCES,
    min_client_version: MIN_CLIENT_VERSION,
  };
}
