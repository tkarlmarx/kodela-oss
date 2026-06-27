<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 The Kodela Authors
-->

# `@kodela/proxy`

A local, pass-through **LLM API proxy** that captures AI coding exchanges as
Kodela sessions — the network-level sibling of the editor/CLI capture paths.

## What it is

Point an AI coding tool (Cursor, Claude Code, Windsurf, an SDK script, …) at this
proxy instead of directly at `api.openai.com` / `api.anthropic.com`. The proxy:

1. **Routes** the request to the right upstream provider based on the model name
   (`gpt-*`/`o1-*` → OpenAI, `claude-*` → Anthropic; see `src/proxy/router.ts`).
2. **Forwards** it transparently — including streaming responses — using the
   provider key from the configured environment variable. Latency overhead is a
   single local hop; the proxy never sits between you and your data egress
   decisions (it talks to the same upstreams your tool already would).
3. **Captures** each exchange (prompt, model, detected tool, response) into a
   Kodela session under `.kodela/sessions/`, attributing it to the originating
   tool via user-agent / header / path / model heuristics
   (`src/capture/request.ts`).
4. **Groups** consecutive exchanges on the same branch within a 30-minute window
   into one logical session (`src/session/id.ts`).

This is "silent capture" for teams that drive AI tools over HTTP rather than
through the MCP server or the editor extension — it needs no per-tool plugin,
only an API base-URL change.

## Why it exists (vs. the other capture paths)

| Capture path | Hook point | Best for |
|---|---|---|
| MCP server | Agent tool calls | Claude Code / MCP-aware agents |
| VS Code extension | Editor events | Interactive IDE use |
| Watcher | File changes on disk | Tool-agnostic, post-hoc |
| **Proxy (this package)** | **The LLM HTTP request** | **Any tool you can repoint by base URL** |

## Run it

```bash
pnpm --filter @kodela/proxy start      # listens on 127.0.0.1:4200 by default
```

Then set your tool's API base URL to `http://127.0.0.1:4200`. Configuration lives
in `.kodela/proxy.config.yaml` (auto-created on first run); see
`src/config/loader.ts` for the schema and `src/config/defaults.ts` for defaults.

Health/observability endpoints: `GET /health`, `GET /status`,
`GET /kodela/sessions`, `POST /kodela/session/end` (`src/utils/health.ts`).

## Status

The pure routing/capture logic is unit-tested (`pnpm --filter @kodela/proxy test`).
The HTTP server wiring (`src/server.ts`, `src/proxy/handler.ts`) is exercised
manually; end-to-end proxy integration tests are a known follow-up.

## License

AGPL-3.0-only (open core). See [`../../LICENSING.md`](../../LICENSING.md).
