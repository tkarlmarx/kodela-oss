# Changelog

All notable changes to the Community Edition are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/).

## [1.2.0] — 2026-07-11

### Added
- **Decision-violation / contradiction detection** — flags when a change reverses or
  contradicts a recorded decision (opposite stance on the same entity, or reviving a
  superseded choice), with a topic-gate to keep false positives low.
- **Governance metrics** — decisions honored vs. violated and AI-intent coverage,
  surfaced via the new `kodela governance` command.
- **Real code-graph import edges** — the comprehension graph now derives IMPORT edges
  from parsed dependencies, not just function containment.
- **Auto change description** — richer, inferred summaries for captured changes.

## [1.1.2] — 2026-07-11

### Changed
- Maintenance release: no functional changes. First release published through the
  automated CI pipeline with npm provenance (supply-chain attestation).

## [1.1.1] — 2026-07-11

### Changed
- Maintenance release: no functional changes to the CLI. Restores the automated,
  tag-triggered npm publish pipeline so builds are reproducible from source.

## [1.0.0] — 2026-07-06

### Added
- Initial public Community Edition: core context engine, CLI, MCP server, watcher,
  embeddings, local SQLite storage, VS Code extension, local LLM proxy.
- 50+ CLI commands: `init`, `connect`, `ui`, `comprehend`, `tour`, `impact`,
  `architecture`, `recall`, `hygiene`, `pack`, `memory-bank`, `mcp serve`, and more.
- 21 MCP server tools covering capture, retrieval, decisions, graph, and architecture.
- Local AES-256-GCM field-level encryption on all annotation notes.
- SHA-256 tamper-evident audit chain for all context mutations.
- Offline semantic search via local ONNX embeddings (`kodela embed`).
- `kodela ui` — free, local, read-only interactive web app (Files, Graph, Decisions,
  Timeline, Memory Health tabs).
- Plugin manifests for Claude Code marketplace, Cursor, and VS Code Copilot.
- One-line installer (`install.sh`) and `kodela connect --apply --npx` quick start.
- AI tool auto-detection for Claude Code, Cursor, VS Code, Windsurf, Antigravity/Gemini,
  Cline, Kiro, and Continue.
- Supply-chain security: `minimumReleaseAge: 1440` in pnpm workspace config.

### Fixed
- Graph tab now respects severity filter chips (Critical/High/Medium/Low) — previously
  showed all nodes regardless of the active filter.
- `kodela ui` now handles port conflicts gracefully with a helpful message and kill
  command instead of crashing with a raw Node.js stack trace.
- `kodela impact` now warns when a specified file does not exist in the repository
  instead of silently returning an empty blast radius.
- `kodela connect` now shows clear `--npx` guidance when run outside the monorepo
  instead of a cryptic `pnpm-workspace.yaml` error.
- Tree-sitter WASM files now bundled in the npm tarball — `kodela comprehend` and
  `kodela tour` now show function and class-level detail (not just file names).
- `kodela connect` now auto-detects Kiro and writes `.kiro/settings/mcp.json`.
- Search upsell message now shown once per session instead of on every invocation.

### Known limitations
- `kodela recall` uses keyword matching by default (offline). For semantic matching,
  run `kodela embed` first and use `kodela search --semantic`.
- Auto-annotation without an MCP-capable tool (Claude Code, Cursor) requires setting
  `KODELA_AI_API_KEY` for the watcher to synthesize the *why* from diffs.
- The web dashboard, shared team memory, RBAC, and governance features are part of
  the paid Team/Enterprise editions — see [kodela.com/pricing](https://kodela.com/pricing).

## [Unreleased]
