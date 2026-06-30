# Kodela for VS Code

**Give your AI agent permanent memory of this repo — and see the *why* behind
every change, in the editor.**

Kodela captures the reasoning behind each code change — who changed it (you or
which AI tool), the problem it solved, the alternatives rejected — and keeps it
next to the code, queryable by you and your AI agents. This extension surfaces
that captured context inside VS Code.

## Features
- **`@kodela` chat participant** — ask "why is this file the way it is?" and get
  the captured decisions and context, right in the Chat view.
- **Context on the files you open** — Kodela activates when a workspace contains
  a `.kodela/` memory.
- **Local-first** — no account, nothing leaves your machine. Works alongside the
  `@kodela/cli` and the Kodela MCP server.

## Getting started
1. Install the Kodela CLI and wire it into your tools:
   ```bash
   npx -y @kodela/cli connect --apply --npx
   ```
2. Open the repo in VS Code. Browse the full memory anytime with `kodela ui`.

Open source (Apache-2.0). Source: https://github.com/tkarlmarx/kodela-oss
