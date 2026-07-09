<!--
SPDX-License-Identifier: Apache-2.0
Copyright (C) 2026 The Kodela Authors
-->

# Kodela — Claude Code plugin

Installs the Kodela MCP server into Claude Code. Once enabled, the agent has the
full `kodela_*` toolset:

- **Capture** — `kodela_session_start`, `kodela_annotate_file`, `kodela_session_end`
  record *why* each change happened (the protocol in the repo's `.claude/CLAUDE.md`).
- **Recall** — `kodela_recall` injects the most relevant prior *why* at task start
  (session start auto-attaches it too).
- **Understand** — `kodela_query`, `kodela_get_why`, `kodela_get_function_context`,
  `kodela_get_architecture`, `kodela_get_fused_context`, …

## Install

From inside Claude Code:

```
/plugin marketplace add tkarlmarx/kodela-oss
/plugin install kodela@kodela
```

Restart when prompted. That's it — the MCP server launches via
`npx -y @kodela/cli mcp serve`, so the published `@kodela/cli` package is fetched
on first run. No local checkout required.

## Notes

- **Capture hooks** (auto-start a session on the first edit, auto-annotate) are
  installed per-repo by `kodela setup` / `kodela init`, because they live in the
  project's `.claude/hooks`. The plugin ships the *tools*; run `kodela init` in a
  repo to also wire the ambient capture hooks. The agent can drive the whole
  protocol through the MCP tools without them.
- For a monorepo checkout or air-gapped install, point the server at a local
  build instead of npx — see `kodela connect` (without `--npx`), which writes
  `node <repo>/artifacts/mcp-server/dist/index.js`.
- Other tools (Cursor, VS Code/Copilot): see [`../README.md`](../README.md).
