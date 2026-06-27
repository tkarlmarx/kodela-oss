// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { mergeMcpConfig, mergeTomlConfig, buildMcpEntry, resolveKodelaHome } from "./connect.js";

describe("connect — mergeMcpConfig (never clobber existing servers)", () => {
  const kodela = buildMcpEntry("/opt/kodela");

  test("adds kodela under mcpServers while preserving other servers", () => {
    const existing = JSON.stringify({
      mcpServers: { github: { command: "npx", args: ["gh-mcp"] } },
      otherTopLevelKey: 1,
    });
    const out = JSON.parse(mergeMcpConfig(existing, "mcpServers", kodela));
    assert.ok(out.mcpServers.github, "existing server preserved");
    assert.deepEqual(out.mcpServers.kodela, kodela, "kodela added");
    assert.equal(out.otherTopLevelKey, 1, "unrelated keys preserved");
  });

  test("VS Code `servers` key form", () => {
    const existing = JSON.stringify({ servers: { foo: { command: "x" } } });
    const out = JSON.parse(mergeMcpConfig(existing, "servers", kodela));
    assert.ok(out.servers.foo, "existing preserved");
    assert.deepEqual(out.servers.kodela, kodela);
    assert.equal(out.mcpServers, undefined, "did not invent the wrong key");
  });

  test("empty / missing input produces a fresh config", () => {
    const out = JSON.parse(mergeMcpConfig(null, "mcpServers", kodela));
    assert.deepEqual(Object.keys(out.mcpServers), ["kodela"]);
  });

  test("unparseable input does not throw and starts clean", () => {
    const out = JSON.parse(mergeMcpConfig("{ not json", "mcpServers", kodela));
    assert.deepEqual(out.mcpServers.kodela, kodela);
  });

  test("re-running is idempotent (kodela entry replaced, not duplicated)", () => {
    const once = mergeMcpConfig(null, "mcpServers", kodela);
    const twice = mergeMcpConfig(once, "mcpServers", kodela);
    const out = JSON.parse(twice);
    assert.deepEqual(Object.keys(out.mcpServers), ["kodela"]);
  });
});

describe("connect — mergeTomlConfig (Codex)", () => {
  test("appends [mcp_servers.kodela] and preserves other content", () => {
    const existing = `model = "gpt-5"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n`;
    const out = mergeTomlConfig(existing, buildMcpEntry("/opt/kodela", "/home/me/proj"));
    assert.ok(out.includes('model = "gpt-5"'), "top-level preserved");
    assert.ok(out.includes("[mcp_servers.github]"), "other server preserved");
    assert.ok(out.includes("[mcp_servers.kodela]"), "kodela added");
    assert.ok(out.includes("[mcp_servers.kodela.env]"), "env block for global pin");
    assert.ok(out.includes('KODELA_REPO_ROOT = "/home/me/proj"'));
  });

  test("re-running replaces the kodela block (no duplicate, others kept)", () => {
    const once = mergeTomlConfig(`[mcp_servers.github]\ncommand = "x"\n`, buildMcpEntry("/opt/kodela"));
    const twice = mergeTomlConfig(once, buildMcpEntry("/opt/kodela"));
    assert.equal(twice.match(/\[mcp_servers\.kodela\]/g)?.length, 1, "exactly one kodela block");
    assert.ok(twice.includes("[mcp_servers.github]"), "other server still there");
  });
});

describe("connect — buildMcpEntry", () => {
  test("project scope omits KODELA_REPO_ROOT (resolves from IDE cwd)", () => {
    const e = buildMcpEntry("/opt/kodela");
    assert.equal(e.command, "node");
    assert.equal(e.args[0], path.join("/opt/kodela", "artifacts", "mcp-server", "dist", "index.js"));
    assert.equal(e.env, undefined);
  });

  test("global scope pins KODELA_REPO_ROOT to the project", () => {
    const e = buildMcpEntry("/opt/kodela", "/home/me/proj");
    assert.equal(e.env?.KODELA_REPO_ROOT, "/home/me/proj");
  });
});

describe("connect — resolveKodelaHome", () => {
  test("walks up to the dir holding pnpm-workspace.yaml + artifacts/mcp-server", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kodela-home-"));
    try {
      fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n");
      fs.mkdirSync(path.join(root, "artifacts", "mcp-server"), { recursive: true });
      const deep = path.join(root, "lib", "cli", "dist");
      fs.mkdirSync(deep, { recursive: true });
      assert.equal(resolveKodelaHome(deep), root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null when no Kodela install is above", () => {
    assert.equal(resolveKodelaHome(os.tmpdir()), null);
  });
});
