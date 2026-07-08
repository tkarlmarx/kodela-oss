// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela connect` — one command to wire Kodela into every MCP-capable AI tool.
 *
 * The whole AI-tool ecosystem converged on the same MCP `mcpServers` JSON shape;
 * only the config-file PATH (and a couple of formats) differ per tool. So this
 * detects which tools are installed and merges one Kodela MCP entry into each —
 * plus the tool-agnostic watcher (which covers Bolt/web/anything without MCP).
 *
 * Design (validated):
 *  - DRY-RUN by default; writes only with --apply (writing into users' tool
 *    configs is hard to reverse, so it's opt-in and prints the plan first).
 *  - MERGE, never clobber: existing MCP servers are preserved; a .kodela-bak
 *    backup is written before any change.
 *  - PORTABLE: project-scoped configs omit KODELA_REPO_ROOT so the server
 *    resolves the repo from the IDE's cwd (works for any repo you open).
 *    Global-only configs (Windsurf, Antigravity) pin the current repo.
 *  - VERIFIED FORMATS ONLY are written (mcpServers-JSON, VS Code `servers`-JSON).
 *    TOML/uncommon tools get a printed snippet + doc link instead of a guessed
 *    file. Cross-machine portability needs an npm publish (honest limitation).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runWatchDetach } from "./watch-daemon.js";
import { runMemoryBank } from "./memory-bank.js";

const HOME = os.homedir();

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export type McpKey = "mcpServers" | "servers";

export interface ToolAdapter {
  id: string;
  name: string;
  /** "json"/"toml" → merge into a config file; "snippet" → print (uncertain format). */
  mode: "json" | "toml" | "snippet";
  jsonKey?: McpKey;
  scope: "project" | "global";
  configPath: (repoRoot: string) => string;
  detect: () => boolean;
  docUrl?: string;
}

/** Registry of supported tools. Add a row to support a new tool. */
export const TOOL_REGISTRY: ToolAdapter[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    mode: "json",
    jsonKey: "mcpServers",
    scope: "project",
    configPath: (r) => path.join(r, ".mcp.json"),
    detect: () => exists(path.join(HOME, ".claude")) || exists(path.join(HOME, ".claude.json")),
  },
  {
    id: "cursor",
    name: "Cursor",
    mode: "json",
    jsonKey: "mcpServers",
    scope: "project",
    configPath: (r) => path.join(r, ".cursor", "mcp.json"),
    detect: () => exists(path.join(HOME, ".cursor")),
  },
  {
    id: "vscode",
    name: "VS Code",
    mode: "json",
    jsonKey: "servers", // VS Code uses `servers`, not `mcpServers`
    scope: "project",
    configPath: (r) => path.join(r, ".vscode", "mcp.json"),
    detect: () => exists(path.join(HOME, ".config", "Code")) || exists(path.join(HOME, ".vscode")),
  },
  {
    id: "windsurf",
    name: "Windsurf",
    mode: "json",
    jsonKey: "mcpServers",
    scope: "global",
    configPath: () => path.join(HOME, ".codeium", "windsurf", "mcp_config.json"),
    detect: () => exists(path.join(HOME, ".codeium")),
  },
  {
    id: "antigravity",
    name: "Antigravity / Gemini",
    mode: "json",
    jsonKey: "mcpServers",
    scope: "global",
    configPath: () => path.join(HOME, ".gemini", "config", "mcp_config.json"),
    detect: () => exists(path.join(HOME, ".gemini")),
  },
  {
    id: "codex",
    name: "Codex CLI",
    mode: "toml", // ~/.codex/config.toml uses [mcp_servers.<name>]
    scope: "global",
    configPath: () => path.join(HOME, ".codex", "config.toml"),
    detect: () => exists(path.join(HOME, ".codex")),
    docUrl: "https://github.com/openai/codex",
  },
  {
    id: "cline",
    name: "Cline (VS Code)",
    mode: "json",
    jsonKey: "mcpServers",
    scope: "global",
    configPath: () =>
      path.join(
        HOME,
        ".config",
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      ),
    detect: () =>
      exists(
        path.join(HOME, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev"),
      ),
  },
  {
    id: "kiro",
    name: "Kiro",
    mode: "json",
    jsonKey: "mcpServers",
    // Kiro reads workspace-level MCP config from .kiro/settings/mcp.json.
    // Uses project scope so the config travels with the repo (same as Cursor).
    // Detection: ~/.kiro is created when Kiro is installed on the machine.
    scope: "project",
    configPath: (r) => path.join(r, ".kiro", "settings", "mcp.json"),
    detect: () => exists(path.join(HOME, ".kiro")),
  },
  {
    id: "continue",
    name: "Continue",
    // Continue's MCP config is YAML and version-dependent — print the snippet
    // rather than risk writing a form the installed version ignores.
    mode: "snippet",
    scope: "global",
    configPath: () => path.join(HOME, ".continue", "config.yaml"),
    detect: () => exists(path.join(HOME, ".continue")),
    docUrl: "https://docs.continue.dev/customize/deep-dives/mcp",
  },
];

export interface McpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The Kodela MCP server launch entry.
 *  - Default (local): `node <kodelaHome>/artifacts/mcp-server/dist/index.js` —
 *    stable, no pnpm/tsx needed, but only valid on this machine.
 *  - `--npx` (published): `npx -y @kodela/cli mcp serve` — portable across
 *    machines/teammates once the package is on npm (no local checkout needed).
 * Pins KODELA_REPO_ROOT only for global-scoped configs where the IDE's cwd
 * can't be relied on; project configs omit it (resolved from cwd).
 */
export function buildMcpEntry(
  kodelaHome: string,
  pinRepoRoot?: string,
  useNpx?: boolean,
): McpEntry {
  const entry: McpEntry = useNpx
    ? { command: "npx", args: ["-y", "@kodela/cli", "mcp", "serve"] }
    : {
        command: "node",
        args: [path.join(kodelaHome, "artifacts", "mcp-server", "dist", "index.js")],
      };
  if (pinRepoRoot) entry.env = { KODELA_REPO_ROOT: pinRepoRoot };
  return entry;
}

/**
 * Merge the Kodela entry into an MCP config JSON under `key`, preserving any
 * other servers. Returns the new file contents. Invalid/empty input → fresh.
 */
export function mergeMcpConfig(existingRaw: string | null, key: McpKey, entry: McpEntry): string {
  let obj: Record<string, unknown> = {};
  if (existingRaw && existingRaw.trim()) {
    try {
      const parsed = JSON.parse(existingRaw);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      // Unparseable — caller will have backed it up; start clean rather than fail.
    }
  }
  const bucket = obj[key];
  const servers: Record<string, unknown> =
    bucket && typeof bucket === "object" ? (bucket as Record<string, unknown>) : {};
  servers.kodela = entry;
  obj[key] = servers;
  return JSON.stringify(obj, null, 2) + "\n";
}

/**
 * Add/replace the `[mcp_servers.kodela]` block in a Codex `config.toml`, leaving
 * everything else untouched. Hand-rolled (no TOML dependency): walk lines and
 * drop any existing kodela section, then append a fresh block — so re-runs
 * replace rather than duplicate, and other servers/keys are preserved.
 */
export function mergeTomlConfig(existingRaw: string | null, entry: McpEntry): string {
  const block: string[] = [
    "[mcp_servers.kodela]",
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`,
  ];
  if (entry.env) {
    block.push("", "[mcp_servers.kodela.env]");
    for (const [k, v] of Object.entries(entry.env)) block.push(`${k} = ${JSON.stringify(v)}`);
  }

  const kept: string[] = [];
  let skipping = false;
  for (const line of (existingRaw ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) skipping = /^\[mcp_servers\.kodela(\.|\])/.test(trimmed);
    if (skipping) continue;
    kept.push(line);
  }
  const base = kept.join("\n").trimEnd();
  return (base ? base + "\n\n" : "") + block.join("\n") + "\n";
}

// ── Agent rules file (AGENTS.md) ───────────────────────────────────────────────

const AGENTS_START = "<!-- kodela:protocol:start -->";
const AGENTS_END = "<!-- kodela:protocol:end -->";

function kodelaAgentsBlock(): string {
  return [
    AGENTS_START,
    "## Kodela context protocol",
    "",
    "This repo uses **Kodela** to capture the *why* behind code changes. As an AI agent working here:",
    "",
    "- **Before editing** a non-trivial file → call `kodela_get_context` to see prior reasoning.",
    "- **After every file edit** → call `kodela_annotate_file` (why_changed, problem_solved, risk).",
    "- **At the end of the session** → call `kodela_session_end`.",
    "- Record significant choices with `kodela_record_decision`.",
    "",
    "Kodela uses a two-path capture architecture. The MCP fast path above is preferred when your agent can drive it (highest-quality capture — you author the *why* in your own words). The background watcher is **ground-truth capture for tools that can't drive MCP**: it observes every file change via git + filesystem and a 6-layer UBA attribution stack, so the *what* is recorded even when no MCP call ever fires. The async synthesis worker fills in the *why* from diff + chat transcript when the agent didn't.",
    AGENTS_END,
  ].join("\n");
}

export type AgentsAction = "create" | "append" | "present";

/** Write/merge the Kodela protocol into AGENTS.md without clobbering the user's rules. */
export function writeAgentsFile(repoRoot: string): { path: string; action: AgentsAction } {
  const p = path.join(repoRoot, "AGENTS.md");
  if (!exists(p)) {
    fs.writeFileSync(p, kodelaAgentsBlock() + "\n");
    return { path: p, action: "create" };
  }
  const cur = fs.readFileSync(p, "utf8");
  if (cur.includes(AGENTS_START)) return { path: p, action: "present" };
  fs.writeFileSync(p, cur.trimEnd() + "\n\n" + kodelaAgentsBlock() + "\n");
  return { path: p, action: "append" };
}

/** Walk up from a start dir to find the Kodela monorepo (pnpm-workspace.yaml + mcp-server). */
export function resolveKodelaHome(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (exists(path.join(dir, "pnpm-workspace.yaml")) && exists(path.join(dir, "artifacts", "mcp-server"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface ConnectPlanItem {
  tool: string;
  name: string;
  mode: "json" | "toml" | "snippet";
  scope: "project" | "global";
  path: string;
  detected: boolean;
  action: "create" | "merge" | "snippet";
  applied?: boolean;
  backup?: string;
  error?: string;
  docUrl?: string;
}

export interface ConnectResult {
  items: ConnectPlanItem[];
  entry: McpEntry;
  applied: boolean;
  watcherStarted: boolean;
  watcherReason?: string;
  agents?: { path: string; action: AgentsAction };
  /** The auto-generated agent Memory Bank (created on --apply). */
  memoryBank?: { dir: string; files: number };
}

export interface ConnectOptions {
  repoRoot: string;
  kodelaHome: string;
  apply: boolean;
  watch: boolean;
  cliVersion: string;
  /** Include tools that aren't detected on this machine (write their config anyway). */
  all?: boolean;
  /** Write a published `npx -y @kodela/cli mcp serve` entry instead of a local node path. */
  npx?: boolean;
}

export async function runConnect(opts: ConnectOptions): Promise<ConnectResult> {
  const { repoRoot, kodelaHome, apply, watch, cliVersion, all = false, npx = false } = opts;
  const items: ConnectPlanItem[] = [];

  for (const tool of TOOL_REGISTRY) {
    const detected = tool.detect();
    const cfgPath = tool.configPath(repoRoot);

    if (tool.mode === "snippet") {
      items.push({
        tool: tool.id,
        name: tool.name,
        mode: "snippet",
        scope: tool.scope,
        path: cfgPath,
        detected,
        action: "snippet",
        docUrl: tool.docUrl,
      });
      continue;
    }

    const had = exists(cfgPath);
    const item: ConnectPlanItem = {
      tool: tool.id,
      name: tool.name,
      mode: tool.mode,
      scope: tool.scope,
      path: cfgPath,
      detected,
      action: had ? "merge" : "create",
    };

    // Only write for detected tools (or --all). Project configs are harmless,
    // but writing only what's present keeps the apply minimal and predictable.
    if (apply && (detected || all)) {
      try {
        const existingRaw = had ? fs.readFileSync(cfgPath, "utf8") : null;
        if (had) {
          const bak = `${cfgPath}.kodela-bak`;
          fs.writeFileSync(bak, existingRaw as string);
          item.backup = bak;
        }
        const entry = buildMcpEntry(kodelaHome, tool.scope === "global" ? repoRoot : undefined, npx);
        const merged =
          tool.mode === "toml"
            ? mergeTomlConfig(existingRaw, entry)
            : mergeMcpConfig(existingRaw, tool.jsonKey as McpKey, entry);
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, merged);
        item.applied = true;
      } catch (e) {
        item.error = e instanceof Error ? e.message : String(e);
      }
    }
    items.push(item);
  }

  // The universal capture path — covers any tool, MCP-capable or not.
  let watcherStarted = false;
  let watcherReason: string | undefined;
  if (apply && watch) {
    try {
      const w = await runWatchDetach({ repoRoot, extraArgs: ["--auto-annotate"], cliVersion });
      watcherStarted = w.started || w.alreadyRunning;
      watcherReason = w.reason;
    } catch {
      watcherReason = "watcher could not start; run `kodela watch --auto-annotate --detach` manually.";
    }
  }

  // Drop the Kodela protocol into AGENTS.md so agents follow annotate/session.
  let agents: ConnectResult["agents"];
  if (apply) {
    try {
      agents = writeAgentsFile(repoRoot);
    } catch {
      // non-fatal — the MCP wiring + watcher are the important parts.
    }
  }

  // Auto-generate the agent Memory Bank so it exists immediately after setup,
  // with zero further commands from the developer. Refreshed continuously by
  // the watcher thereafter.
  let memoryBank: ConnectResult["memoryBank"];
  if (apply) {
    try {
      const mb = await runMemoryBank({ repoRoot });
      memoryBank = { dir: mb.dir, files: mb.files.length };
    } catch {
      // non-fatal — capture wiring is the important part.
    }
  }

  return {
    items,
    entry: buildMcpEntry(kodelaHome, undefined, npx),
    applied: apply,
    watcherStarted,
    watcherReason,
    agents,
    memoryBank,
  };
}

export function formatConnectResult(result: ConnectResult): string {
  const lines: string[] = [];
  const verb = result.applied ? "Connected" : "Plan (dry-run — pass --apply to write)";
  lines.push(`Kodela · ${verb}`);
  lines.push("");

  const writable = result.items.filter((i) => i.mode !== "snippet");
  const detected = writable.filter((i) => i.detected);
  const undetected = writable.filter((i) => !i.detected);
  const snippets = result.items.filter((i) => i.mode === "snippet");

  if (detected.length > 0) {
    lines.push("Detected tools:");
    for (const i of detected) {
      const status = result.applied
        ? i.applied
          ? `✓ ${i.action === "merge" ? "merged into" : "created"}`
          : i.error
            ? `✗ ${i.error}`
            : "—"
        : `would ${i.action}`;
      lines.push(`  • ${i.name} (${i.scope}) — ${status}: ${i.path}${i.backup ? `  [backup ${path.basename(i.backup)}]` : ""}`);
    }
    lines.push("");
  }

  if (undetected.length > 0) {
    lines.push("Available (not detected here — install the tool, then re-run, or use --all):");
    for (const i of undetected) lines.push(`  • ${i.name} → ${i.path}`);
    lines.push("");
  }

  if (snippets.length > 0) {
    lines.push("Manual (different format — paste this entry yourself):");
    for (const i of snippets) {
      lines.push(`  • ${i.name} → ${i.path}${i.docUrl ? `  (${i.docUrl})` : ""}`);
    }
    lines.push("");
  }

  lines.push("Kodela MCP entry (the same one written everywhere):");
  lines.push(JSON.stringify({ mcpServers: { kodela: result.entry } }, null, 2));
  lines.push("");

  if (result.applied) {
    if (result.agents) {
      const verb =
        result.agents.action === "present"
          ? "already documents"
          : result.agents.action === "append"
            ? "now documents (appended)"
            : "now documents (created)";
      lines.push(`✓ AGENTS.md ${verb} the Kodela protocol for agents.`);
    }
    lines.push(
      result.watcherStarted
        ? "✓ Silent capture watcher running (covers any tool, incl. Bolt/web)."
        : `⚠ Watcher not started${result.watcherReason ? ` — ${result.watcherReason}` : ""}.`,
    );
    if (result.memoryBank) {
      lines.push(
        `✓ Memory Bank generated in ${result.memoryBank.dir}/ (${result.memoryBank.files} files) — refreshed automatically as you work.`,
      );
    }
    lines.push("Reload your AI tool(s) so they pick up the kodela MCP server.");
  } else {
    lines.push("Run `kodela connect --apply` to write the configs above + start the watcher.");
  }
  return lines.join("\n");
}
