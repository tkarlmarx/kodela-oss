# Kodela (Community Edition)

**The open-source system of record for AI-assisted development.** Kodela captures
the *why* behind every code change — especially AI-generated ones — and turns it
into a queryable memory graph your team and your AI agents can pull from.

Git records *what* changed. Kodela records *why* — the reasoning, the author
(human or which AI tool), the alternatives rejected — and keeps it next to the
code, structured and queryable, fully on your machine.

> This is the free, local-first **Community Edition** (AGPL-3.0). It needs no
> account and no cloud. Team/Cloud/Enterprise features (multi-tenant SaaS,
> dashboard, hosted services) are a separate commercial offering.

---

## The demo

```console
$ kodela context src/auth/jwt.ts

→ Last modified by Claude Code on 2026-03-15 (session e3f9c)
→ Why: fix token-expiry bug causing 3-minute session drops
→ Decision: ed25519 over RSA — performance, reviewed by @hari
→ Prior RSA implementation: commit 8a4f7c (available for rollback)
```

---

## How it works — two paths, one local memory

- **MCP fast path** (`artifacts/mcp-server/`) — MCP-capable agents (Claude Code,
  Cursor, Continue…) call `kodela_annotate_file`, `kodela_get_context`, etc.
  directly, authoring the *why* in their own words.
- **Silent-capture watcher** (`lib/watcher/`) — for every other case (browser
  agents, raw `git commit`s, a forgotten annotation), the watcher records *what*
  changed via git + filesystem, so context is never lost.

On top of that it builds a **fused memory graph**: the code-structure graph
(tree-sitter AST) fused with the event/decision graph (sessions, WHY, decisions).

Everything is stored locally under `.kodela/` (SQLite + JSON). No data leaves your
machine.

---

## Quick start (from source)

```bash
git clone https://github.com/tkarlmarx/kodela-oss.git
cd kodela-oss
pnpm install
pnpm build
node lib/cli/dist/bin.cjs --help     # or `pnpm --filter @kodela/cli start`
```

Requires Node 24+ and pnpm 10+.

Wire Kodela into your AI tools and start the watcher:

```bash
kodela connect --apply        # detects Claude Code, Cursor, VS Code, Windsurf, …
```

---

## Key commands

| Command | What it does |
|---|---|
| `kodela init` | Initialize Kodela in the current repo (`.kodela/`). |
| `kodela connect [--apply]` | Wire Kodela into every installed AI tool + start the watcher. |
| `kodela mcp serve` | Run the MCP server over stdio. |
| `kodela watch --auto-annotate` | Run the silent-capture watcher. |
| `kodela context <file>` | Show the captured reasoning for a file. |
| `kodela search <query> [--semantic]` | Search annotations by keyword or meaning. |
| `kodela graph` / `kodela report` | Explore the memory graph / generate a summary. |
| `kodela doctor` | Diagnose the local setup. |

Run `kodela --help` for the full set.

---

## Repository layout

```
lib/
  core/        # context engine, sessions, WHY chain, schema, memory graph
  cli/         # @kodela/cli
  watcher/     # silent-capture daemon
  diff/        # AI-change detection
  embed/       # offline embeddings (ONNX + hash fallback)
  db/          # local SQLite storage
  vscode/      # VS Code extension
  proxy/       # local LLM proxy capture path
artifacts/
  mcp-server/  # MCP stdio server
```

---

## Contributing

We welcome contributions — see [CONTRIBUTING.md](CONTRIBUTING.md),
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md).
Roadmap: [ROADMAP.md](ROADMAP.md).

## License

[AGPL-3.0-only](LICENSE). "Kodela" and the `@kodela/*` npm scope are trademarks of
the Kodela project; the license grants code rights, not trademark rights.
