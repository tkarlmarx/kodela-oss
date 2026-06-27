# mcp-server scripts

Re-runnable demo + integration scripts for the MCP server's MVP capabilities.

These are durable artifacts kept under version control. They exist to:

1. Show future engineers how to exercise the MVP MCP tools without writing code.
2. Give the dashboard and pilot demos a quick "populate the DB" entry point.
3. Serve as integration-style tests (broader than the unit smoke tests under `src/tools/*.test.ts`).

## Scripts

| Script | Purpose |
|---|---|
| [`demo-decisions.ts`](./demo-decisions.ts) | End-to-end run of every Decision Intelligence MVP tool: `kodela_record_decision`, `kodela_get_decision`, `kodela_search_decisions`, `kodela_supersede_decision`. Writes to the repo's real `.kodela/index.db` and `.kodela/decisions/`. |

## Usage

From the repo root:

```bash
# Run against the repo's .kodela/index.db (decisions accumulate)
pnpm --filter @workspace/mcp-server demo

# Wipe the decisions tables first, then run cleanly
pnpm --filter @workspace/mcp-server demo:clean

# Direct (bypasses pnpm script aliasing)
npx tsx artifacts/mcp-server/scripts/demo-decisions.ts
npx tsx artifacts/mcp-server/scripts/demo-decisions.ts --clean
```

`KODELA_REPO_ROOT` env var overrides the auto-detected repo root.

## After running

- Decision records persist in `.kodela/index.db` (SQLite tables `decisions`, `decision_options`, `decision_links`).
- Human-readable copies persist in `.kodela/decisions/DEC-NNNN.json`.
- The dashboard (`pnpm --filter @workspace/dashboard dev`) shows them in the **Decisions** and **Memory graph** views.

## Test vs demo

| Layer | What it tests | Path |
|---|---|---|
| **Unit smoke tests** | Storage layer + each MCP tool in isolation, on a temp DB | `src/tools/decisions.test.ts` (run with `pnpm test`) |
| **Demo scripts** (this folder) | End-to-end flow against the real repo `.kodela/` directory | this folder |

When adding a new MCP tool to the server, add a corresponding step to the demo so any future engineer or AI agent can verify it works without needing to hand-craft MCP envelopes.
