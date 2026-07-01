// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 3 — P3.3 plugin-distribution manifests. Validates the shipped plugin /
 * marketplace manifests stay well-formed and internally consistent, so a broken
 * edit is caught in CI rather than by a user's failed `/plugin install`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// lib/cli/src/plugins.test.ts → repo root is four levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readJson(rel: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
}

describe("Claude Code plugin marketplace (P3.3)", () => {
  test("marketplace.json has the required shape and points at a real plugin dir", () => {
    const m = readJson(".claude-plugin/marketplace.json") as {
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string }[];
    };
    assert.equal(typeof m.name, "string");
    assert.ok(m.name.length > 0);
    assert.equal(typeof m.owner?.name, "string");
    assert.ok(Array.isArray(m.plugins) && m.plugins.length >= 1);
    const kodela = m.plugins.find((p) => p.name === "kodela")!;
    assert.ok(kodela, "declares the kodela plugin");
    // The source dir must exist and contain a plugin manifest.
    const manifest = path.join(REPO_ROOT, kodela.source, ".claude-plugin", "plugin.json");
    assert.ok(fs.existsSync(manifest), `plugin manifest exists at ${kodela.source}`);
  });

  test("plugin.json declares the kodela MCP server via npx", () => {
    const p = readJson("plugins/kodela/.claude-plugin/plugin.json") as {
      name: string;
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.equal(p.name, "kodela");
    const server = p.mcpServers?.kodela;
    assert.ok(server, "declares an mcpServers.kodela entry");
    assert.equal(server.command, "npx");
    assert.deepEqual(server.args, ["-y", "@kodela/cli", "mcp", "serve"]);
  });
});

describe("cross-tool MCP manifests (P3.3)", () => {
  test("Cursor manifest uses mcpServers + npx", () => {
    const c = readJson("plugins/cursor/mcp.json") as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.equal(c.mcpServers?.kodela?.command, "npx");
    assert.ok(c.mcpServers.kodela.args.includes("@kodela/cli"));
  });

  test("VS Code / Copilot manifest uses `servers` with type stdio", () => {
    const v = readJson("plugins/vscode-copilot/mcp.json") as {
      servers: Record<string, { type: string; command: string; args: string[] }>;
    };
    assert.equal(v.servers?.kodela?.type, "stdio");
    assert.equal(v.servers.kodela.command, "npx");
    assert.ok(v.servers.kodela.args.includes("@kodela/cli"));
  });
});
