// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Durable end-to-end demo for Decision Intelligence (MVP).
 *
 * Exercises every MVP MCP tool against the repo's real .kodela/index.db:
 *   1. kodela_record_decision    — DEC-0001 + DEC-0002
 *   2. kodela_get_decision       — retrieve DEC-0001 with options + links
 *   3. kodela_search_decisions   — keyword + facet
 *   4. kodela_supersede_decision — supersede DEC-0001 with a new decision
 *
 * Re-runnable. Idempotent in the sense that new sequential DEC-NNNN ids
 * are generated on every run; existing rows are not modified. Pass
 * `--clean` to wipe the decisions tables before running.
 *
 * Usage:
 *   pnpm --filter @workspace/mcp-server demo
 *   pnpm --filter @workspace/mcp-server demo:clean   # wipe first
 *
 * Or directly:
 *   npx tsx artifacts/mcp-server/scripts/demo-decisions.ts
 *   npx tsx artifacts/mcp-server/scripts/demo-decisions.ts --clean
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

import { ensureDecisionTables } from "../src/lib/decisions-store.js";
import { recordDecision } from "../src/tools/record-decision.js";
import { getDecisionForMcp } from "../src/tools/get-decision.js";
import { searchDecisionsForMcp } from "../src/tools/search-decisions.js";
import { supersedeDecisionForMcp } from "../src/tools/supersede-decision.js";

const repoRoot = process.env["KODELA_REPO_ROOT"] ?? findRepoRoot();
const kodelaDir = path.join(repoRoot, ".kodela");
const dbPath = path.join(kodelaDir, "index.db");

const wantsClean = process.argv.includes("--clean");

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, ".kodela"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function banner(text: string): void {
  const line = "─".repeat(72);
  console.log(`\n${line}\n  ${text}\n${line}`);
}

function header(text: string): void {
  console.log(`\n── ${text} ${"─".repeat(Math.max(0, 70 - text.length))}`);
}

function pretty(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function fail(step: string, err: unknown): never {
  console.error(`\n✗ ${step} FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ── Setup ────────────────────────────────────────────────────────────────

banner("Kodela Decision Intelligence — end-to-end demo");

if (!fs.existsSync(kodelaDir)) {
  fs.mkdirSync(kodelaDir, { recursive: true });
  console.log(`Created ${kodelaDir}`);
}

const db = new DatabaseSync(dbPath);

if (wantsClean) {
  header("--clean: wiping decisions tables");
  db.exec("DROP TABLE IF EXISTS decision_links");
  db.exec("DROP TABLE IF EXISTS decision_options");
  db.exec("DROP TABLE IF EXISTS decisions");
  const dir = path.join(kodelaDir, "decisions");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
  console.log("✓ wiped");
}

ensureDecisionTables(db);
console.log(`✓ decisions tables ensured in ${dbPath}`);

// ── 1. Record a decision ─────────────────────────────────────────────────

header("1. kodela_record_decision — capture the MCP-first pivot decision");

const dec1 = recordDecision(
  repoRoot,
  {
    org_id: "_default",
    repo_id: "kodela",
    title: "Adopt MCP-first capture as the primary write path",
    category: "architecture",
    problem:
      "Original April 2025 design centered annotation on developers writing notes by hand; " +
      "AI tools now produce most code and developers won't reliably annotate after the fact.",
    decision:
      "Move primary write path to MCP tools called by AI agents during the session; " +
      "retain the AST mapping engine as drift-detection rather than the central trust contract.",
    reason:
      "AI agents emit context naturally at the moment of work via MCP. Hand-annotation has " +
      "historically failed in similar tools (Swimm, Stepsize). Session-close git-diff enforcement " +
      "makes the new path failure-resistant: no AI session can end without explaining every file.",
    consequences:
      "Commits us to maintaining the MCP server, the session lifecycle, and the per-file " +
      "context invariant. Means the marketing message must shift from 'annotation tool' to " +
      "'system of record for AI coding work'.",
    trade_offs: "We give up some developer-facing UI polish until Phase 6 dashboard.",
    options: [
      {
        label: "MCP-first capture (chosen)",
        description: "AI agents call kodela_session_start + kodela_annotate_file via MCP.",
        pros: "Captures the moment of work; failure-resistant via session-close enforcement.",
        cons: "Requires AI tools to be MCP-aware.",
        was_chosen: true,
      },
      {
        label: "Continue with developer hand-annotation",
        description: "Original April 2025 vision — developers run `kodela add` after writing code.",
        was_chosen: false,
        rejection_reason:
          "Behavioural — developers in field tests skip annotation after the fact. AI-era code volume amplifies the gap.",
      },
      {
        label: "Pure proxy-based capture",
        description: "Intercept all AI API traffic and infer context.",
        was_chosen: false,
        rejection_reason:
          "Requires per-IDE config patching (still TODO in lib/proxy/server.ts); not vendor-neutral.",
      },
    ],
    author_id: "praneeth@blash.uk",
    approver_ids: ["anjan.mukherjee@blash.uk"],
    tags: ["mcp", "capture", "architecture-pivot"],
    visibility: "public-to-org",
    decided_at: "2026-05-23T00:00:00Z",
    initial_links: [
      {
        link_type: "document",
        external_id: "git-diff-enforcement-spec.md",
        display_label: "Git-diff enforcement spec (May 2026)",
      },
    ],
  },
  db,
);

if (!dec1.ok) fail("record DEC-0001", dec1.error);
pretty(dec1);

header("2. kodela_record_decision — reject MongoDB");
const dec2 = recordDecision(
  repoRoot,
  {
    org_id: "_default",
    repo_id: "kodela",
    title: "Stay on Postgres + SQLite — reject MongoDB",
    category: "architecture",
    problem:
      "Considered MongoDB for the proxy-session capture store given the document-shaped nature " +
      "of session envelopes. Concerns about cross-shape query patterns.",
    decision: "Stay on the existing Postgres + SQLite stack across all storage paths.",
    reason:
      "Drizzle ORM + the SqliteStorage default give us schema portability and tooling. The " +
      "small ergonomic win on session writes does not offset the operational cost of running " +
      "a second datastore and the lock-in to a non-SQL query language for the dashboard.",
    options: [
      { label: "Postgres + SQLite (chosen)", description: "Existing stack.", was_chosen: true },
      {
        label: "MongoDB",
        description: "Document-shaped store.",
        was_chosen: false,
        rejection_reason: "Operational overhead of a second datastore; harder to power the dashboard.",
      },
    ],
    author_id: "praneeth@blash.uk",
    approver_ids: ["anjan.mukherjee@blash.uk"],
    tags: ["data-layer"],
    visibility: "public-to-org",
    decided_at: "2026-04-12T00:00:00Z",
    initial_links: [
      { link_type: "ticket", external_id: "PLAT-1287", display_label: "Pick the storage backend" },
    ],
  },
  db,
);
if (!dec2.ok) fail("record DEC-0002", dec2.error);
pretty(dec2);

// ── 3. Retrieve ──────────────────────────────────────────────────────────

const dec1Id = dec1.decision_id!;
header(`3. kodela_get_decision — retrieve ${dec1Id}`);
const got = getDecisionForMcp({ decision_id: dec1Id }, db);
if (!got.ok) fail("get_decision", got.error);
pretty(got);

// ── 4. Search ────────────────────────────────────────────────────────────

header("4. kodela_search_decisions — query 'MCP'");
const search1 = searchDecisionsForMcp({ query: "MCP", limit: 10 }, db);
if (!search1.ok) fail("search 'MCP'", search1.error);
pretty(search1);

header("5. kodela_search_decisions — category=architecture");
const search2 = searchDecisionsForMcp({ category: "architecture", limit: 10 }, db);
if (!search2.ok) fail("search architecture", search2.error);
pretty(search2);

// ── 5. Supersede ─────────────────────────────────────────────────────────

header(`6. kodela_supersede_decision — supersede ${dec1Id}`);
const supersede = supersedeDecisionForMcp(
  repoRoot,
  {
    old_decision_id: dec1Id,
    new_decision: {
      title: "Refine MCP-first capture with hybrid hook fallback",
      category: "architecture",
      problem:
        "Pure MCP capture loses context when an AI tool does not (yet) implement MCP. We need a " +
        "fallback path that still captures intent for non-MCP-aware tools without breaking the trust contract.",
      decision:
        "Layer Claude Code hooks + the AI-API proxy underneath MCP. When MCP is available we use " +
        "it; when not, hooks capture session boundaries and the proxy captures prompt/response pairs.",
      reason:
        "Field testing showed that Cursor's MCP support arrived late in 2026, and Continue.dev " +
        "still has partial coverage. Hybrid hooks + proxy mean we capture context across the full " +
        "toolchain without making MCP a hard prerequisite. The session-close enforcement invariant " +
        "is preserved across all three paths.",
      options: [
        {
          label: "Hybrid hooks + proxy + MCP (chosen)",
          description: "Three layered capture paths; MCP preferred when available.",
          was_chosen: true,
        },
        {
          label: "MCP-only — reject non-MCP tools",
          description: "Refuse to capture for non-MCP-aware tools.",
          was_chosen: false,
          rejection_reason: "Cuts off ~40% of customers using IDEs without mature MCP support.",
        },
      ],
      author_id: "praneeth@blash.uk",
      approver_ids: ["anjan.mukherjee@blash.uk"],
      tags: ["mcp", "capture", "hybrid"],
      visibility: "public-to-org",
      decided_at: new Date("2026-08-01T00:00:00Z").toISOString(),
      initial_links: [],
    },
  },
  db,
);
if (!supersede.ok) fail("supersede", supersede.error);
pretty(supersede);

// ── 6. Final state ────────────────────────────────────────────────────────

header("7. Final list");
const finalList = searchDecisionsForMcp({ limit: 100 }, db);
if (!finalList.ok) fail("final list", finalList.error);
for (const r of finalList.results!) {
  const arrow = r.status === "superseded" ? "→" : "•";
  console.log(`  ${arrow} ${r.decision_id}  [${r.status.padEnd(11)}]  ${r.title}`);
}

header(".kodela/decisions/ on disk");
const dir = path.join(kodelaDir, "decisions");
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir).sort()) {
    const stat = fs.statSync(path.join(dir, f));
    console.log(`  ${f}  (${stat.size} bytes)`);
  }
}

db.close();
banner("Demo complete. Open the dashboard to see Decisions + Memory Graph.");
