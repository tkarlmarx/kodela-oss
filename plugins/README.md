<!--
SPDX-License-Identifier: Apache-2.0
Copyright (C) 2026 The Kodela Authors
-->

# Kodela plugins & one-file installs

Kodela is an [MCP](https://modelcontextprotocol.io) server, so it drops into any
MCP-capable AI tool. This directory holds ready-to-use manifests plus a Claude
Code **plugin marketplace** so a teammate can add Kodela in one step.

> The fastest path for **every** tool is still `kodela connect --apply`, which
> detects your installed tools and merges the Kodela MCP server into each. These
> manifests are for when you'd rather copy one file, or install from a
> marketplace.

## Claude Code — plugin marketplace (recommended)

This repository *is* a Claude Code plugin marketplace (see
[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)). In
Claude Code:

```
/plugin marketplace add tkarlmarx/kodela-oss
/plugin install kodela@kodela
```

That wires the Kodela MCP server (all `kodela_*` tools — capture, recall,
comprehension, impact, …) and the capture hooks. Restart Claude Code when
prompted.

## Cursor

Copy [`cursor/mcp.json`](./cursor/mcp.json) into your project's
`.cursor/mcp.json` (or merge the `kodela` entry into an existing file), then
reload Cursor. Cursor uses the standard `mcpServers` shape.

## VS Code (GitHub Copilot / Agent mode)

Copy the `servers` block from [`vscode-copilot/mcp.json`](./vscode-copilot/mcp.json)
into your VS Code `settings.json` or a workspace `.vscode/mcp.json`. VS Code uses
`servers` (not `mcpServers`) and wants an explicit `"type": "stdio"`.

## What each manifest launches

Every manifest runs the same thing — the published CLI's MCP server over stdio:

```
npx -y @kodela/cli mcp serve
```

`npx` fetches `@kodela/cli` from npm on first run. For an air-gapped or
monorepo checkout, point `command`/`args` at the local build instead:
`node <kodela-repo>/artifacts/mcp-server/dist/index.js` (this is what
`kodela connect` writes without `--npx`).
