# Kodela Community Edition — Migration Report

**Generated:** 2026-06-27
**Source (upstream, private, unchanged):** `Rudratic-cyber/Kodela`
**Target (public):** `tkarlmarx/kodela-oss`
**Method:** Allowlist copy into a fresh git history (no upstream history is carried,
so no secret that ever existed in an upstream commit can leak), then surgical
de-coupling of cloud/commercial/licensing-key code.

> The upstream private repository was **not modified**. It remains the source of
> truth containing Community + Team + Cloud + Enterprise + Licensing + Billing.

---

## ✅ Included (Community Edition)

| Area | Path | Notes |
|---|---|---|
| Core context engine | `lib/core/` | sessions, WHY chain, schema, storage interface, code-graph, graph, audit hash-chain, local policy, reasoning, attribution, semantic-search, staleness, handoff, MCP envelope |
| CLI | `lib/cli/` | `@kodela/cli` — connect, init, context, search, embed, watch, mcp serve, graph, report, doctor, … |
| MCP server | `artifacts/mcp-server/` | stdio MCP server (read + write tools) |
| Local AI / embeddings | `lib/embed/` | offline ONNX + dependency-free hash fallback |
| Silent-capture watcher | `lib/watcher/` | tool-agnostic git+fs capture |
| Diff engine | `lib/diff/` | AI-change detection |
| Local storage | `lib/db/` | **SQLite adapter only** + schema |
| VS Code extension | `lib/vscode/` | editor integration |
| Local LLM proxy | `lib/proxy/` | base-URL capture path |
| License (verification only) | `lib/core/src/license/` | **keys neutralized** — empty registry, always resolves to the free/community tier |
| Local telemetry | `lib/core/src/telemetry/` | **local event log only**, zero network egress (powers `kodela health`) |

---

## ❌ Excluded (stays in the private upstream)

| Category | What | Why |
|---|---|---|
| Commercial UI | `lib/dashboard/` | Commercial-licensed enterprise dashboard |
| SaaS backend | `artifacts/api-server/`, `lib/api-client-react/`, `lib/api-zod/`, `lib/api-spec/` | Multi-tenant SaaS orchestration |
| Cloud storage | `lib/db/src/adapters/postgres*.ts`, `lib/core/src/storage/sql-backend*.ts` | Multi-tenant Postgres backend (Cloud) |
| Hosted services | `artifacts/synthesis-worker/`, `artifacts/github-app/` | Managed/hosted paid surfaces |
| Production keys | `lib/core/src/license/keys.ts` production signing keys, `scripts/licensing/{gen-keypair,sign-license}` | Licensing key material / signing |
| Secrets & licenses | `.env*`, `kodela.license.json`, `mock-licenses/` | Secrets / license artifacts |
| Confidential docs | `strategy/` (16 docs), `docs/Business/` | Pricing, revenue, competitive analysis, compliance, business plan |
| Internal/host config | `.replit`, `replit.md`, `.kiro/`, `.cursor/`, `attached_assets/` | Internal/dev-host scratch |

---

## 🔧 Enterprise-dependency de-coupling (interfaces preserved)

| Coupling | Action |
|---|---|
| `lib/db` `getStorage()` Postgres branch | Rewritten to SQLite-only; `hasDatabaseUrl()` returns false |
| `lib/core` storage factory `saas` mode | Throws "not available in Community Edition" instead of importing the removed SaaS backend; `sql?: never` |
| `lib/core/src/license/keys.ts` | `SIGNING_KEYS = []` — verification always declines → free tier. No keys shipped |
| Public API compatibility | `KodelaStorage`, `loadLicense`, storage `factory`, and the MCP tool surface keep their signatures |

---

## 🔒 Security verification (run at migration time)

- ✅ No private-key material, no license private-key env var, and no production signing key-id anywhere in the tree.
- ✅ No `.env`, `kodela.license.json`, or `mock-licenses/`.
- ✅ No `dashboard`, `api-server`, `api-client-react`, `api-zod`, `api-spec`, `synthesis-worker`, `github-app`, `strategy/`, or `docs/Business/`.
- ✅ No Postgres / `node-postgres` imports remain.
- ℹ️ The only files matching secret-like patterns are `lib/core/src/policy/secrets-scan.ts(.test.ts)` — that is the secret **detector** feature, not a secret.

---

## ✅ Build status — VERIFIED standalone

Verified in this repository (independent of the upstream monorepo):

- `pnpm install` → success (workspace + catalog resolve).
- `pnpm run typecheck` → **exit 0** (all packages: core, cli, db, watcher, diff,
  embed, vscode, proxy, mcp-server).
- `pnpm run test` → **1827 / 1827 passing, 0 failures.**

The included `.github/workflows/ci.yml` re-runs typecheck + tests on every push.

**Recommended:** push to a PRIVATE `tkarlmarx/kodela-oss` first, confirm CI is
green on GitHub's runners, then flip the repository to public.
