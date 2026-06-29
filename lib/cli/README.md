# Kodela CLI

**The system of record for AI-assisted development.** Kodela captures the *why* behind every code change (especially AI-generated ones) and turns it into a queryable memory graph your humans and AI agents can pull from.

## Quick start (one line)

```bash
npx -y @kodela/cli connect --apply --npx
```

This detects every installed AI coding tool — Claude Code, Cursor, VS Code, Windsurf, Antigravity/Gemini, Codex, Cline, Continue — and wires the Kodela MCP server into each (preserving any existing servers), then starts the tool-agnostic silent-capture watcher. Reload your AI tool and Kodela is live.

Drop `--apply` to preview the plan first (dry-run is the default). Drop `--npx` to write local `node` paths instead of the published package entry.

## Commands

| Command | What it does |
|---|---|
| `kodela connect [--apply] [--npx] [--all]` | Wire Kodela into every installed AI tool + start the watcher. |
| `kodela mcp serve` | Run the MCP server over stdio (this is what IDE configs launch). |
| `kodela mcp start` / `mcp status` | Print a config snippet / check MCP wiring. |
| `kodela watch --auto-annotate --detach` | Run the silent-capture watcher standalone. |
| `kodela init` | Initialize Kodela in the current repo. |

## How it works — two paths, one memory

Kodela captures every AI-assisted code change via **two complementary paths** that converge on the same memory store:

- **MCP fast path** — when an AI agent can drive MCP, it calls `kodela_get_context`, `kodela_annotate_file`, `kodela_record_decision`, … directly. The agent authors the *why* in its own words, including reasoning and alternatives considered. This is the highest-quality capture and is preferred when available.
- **Watcher: ground-truth capture for tools that can't drive MCP** — for every other case (browser-only agents like v0/Bolt, raw `git commit`s, autonomous CI bots, agents that haven't adopted MCP yet, sessions where the agent forgot to annotate), the silent-capture watcher observes what changed via git + filesystem + 6-layer UBA attribution. It guarantees the *what* is recorded even when no MCP call ever fires — and Phase 2's async LLM synthesis worker (see [the project design docs](../../the project design docs)) fills in the *why* from diff + chat transcript when the agent didn't.

Both paths write to the same `.kodela/` store, so the dashboard, decisions, and Memory Graph see a single unified record — regardless of which agent (Claude Code, Cursor, Copilot, Codex, Aider, Windsurf, Antigravity, Cline, Continue, …) did the work.

See the main repository for the dashboard, architecture docs, and the full protocol.
