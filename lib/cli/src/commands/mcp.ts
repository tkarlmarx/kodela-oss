// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 54 Phase D — `kodela mcp` CLI command group
 *
 * Two subcommands:
 *
 *   kodela mcp start
 *     Prints a ready-to-paste MCP configuration snippet for Claude Code
 *     (and other MCP-aware tools) and validates that the MCP server package
 *     is available.
 *
 *   kodela mcp status
 *     Checks whether the MCP server is configured in `.claude/settings.json`
 *     and reports its status.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type McpStartOptions = {
  repoRoot: string;
  repoPath?: string;
};

export type McpStartResult = {
  configSnippet: string;
  serverPath: string;
  available: boolean;
};

export type McpStatusOptions = {
  repoRoot: string;
};

export type McpStatusResult = {
  configured: boolean;
  settingsPath: string;
  serverEntry?: string;
};

/**
 * Locate the MCP server entry point by walking up from the CLI binary.
 * Returns the absolute path to artifacts/mcp-server/src/index.ts or the
 * compiled dist equivalent, whichever exists.
 */
async function findMcpServerPath(repoRoot: string): Promise<string | null> {
  const candidates = [
    path.join(repoRoot, "artifacts", "mcp-server", "dist", "index.cjs"),
    path.join(repoRoot, "artifacts", "mcp-server", "dist", "index.js"),
    path.join(repoRoot, "artifacts", "mcp-server", "src", "index.ts"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // not found, try next
    }
  }
  return null;
}

/**
 * Check whether Node.js is available in PATH.
 */
async function nodeAvailable(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("node", ["--version"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function runMcpStart(opts: McpStartOptions): Promise<McpStartResult> {
  const { repoRoot } = opts;

  const serverPath = await findMcpServerPath(repoRoot);
  const nodeVersion = await nodeAvailable();
  const available = serverPath !== null && nodeVersion !== null;

  const displayPath = serverPath
    ? path.relative(repoRoot, serverPath)
    : "artifacts/mcp-server/src/index.ts";

  const configSnippet = JSON.stringify(
    {
      mcpServers: {
        kodela: {
          command: "node",
          args: [
            "--import",
            "tsx",
            path.join(repoRoot, "artifacts", "mcp-server", "src", "index.ts"),
          ],
          env: {
            KODELA_REPO_ROOT: repoRoot,
          },
        },
      },
    },
    null,
    2,
  );

  return { configSnippet, serverPath: displayPath, available };
}

export async function runMcpStatus(opts: McpStatusOptions): Promise<McpStatusResult> {
  const { repoRoot } = opts;
  const settingsPath = path.join(repoRoot, ".claude", "settings.json");

  let configured = false;
  let serverEntry: string | undefined;

  try {
    const raw = await fs.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as unknown;
    if (
      settings !== null &&
      typeof settings === "object" &&
      "mcpServers" in settings &&
      typeof (settings as Record<string, unknown>).mcpServers === "object" &&
      (settings as Record<string, unknown>).mcpServers !== null &&
      "kodela" in ((settings as Record<string, unknown>).mcpServers as object)
    ) {
      configured = true;
      const mcp = (settings as Record<string, unknown>).mcpServers as Record<string, unknown>;
      serverEntry = JSON.stringify(mcp["kodela"], null, 2);
    }
  } catch {
    // settings.json missing or not parseable
  }

  return { configured, settingsPath, serverEntry };
}

export function formatMcpStart(result: McpStartResult): string {
  const lines: string[] = [];
  lines.push("Kodela MCP Server");
  lines.push("═════════════════");
  lines.push("");
  if (result.available) {
    lines.push(`✅  Server package found at: ${result.serverPath}`);
  } else {
    lines.push(`⚠️   Server package not built. Run: pnpm --filter @workspace/mcp-server run dev`);
  }
  lines.push("");
  lines.push("Add the following to your Claude Code .claude/settings.json:");
  lines.push("");
  lines.push(result.configSnippet);
  lines.push("");
  lines.push(
    "Or, if you prefer using pnpm directly, use command=\"pnpm\" with args " +
    '["--filter", "@workspace/mcp-server", "run", "dev"].',
  );
  return lines.join("\n");
}

export function formatMcpStatus(result: McpStatusResult): string {
  const lines: string[] = [];
  if (result.configured) {
    lines.push(`✅  Kodela MCP server is configured in ${result.settingsPath}`);
    if (result.serverEntry) {
      lines.push("");
      lines.push("Server entry:");
      lines.push(result.serverEntry);
    }
  } else {
    lines.push(`⚠️   Kodela MCP server is NOT configured in ${result.settingsPath}`);
    lines.push("Run `kodela mcp start` to see the configuration snippet.");
  }
  return lines.join("\n");
}
