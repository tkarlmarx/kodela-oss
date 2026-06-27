// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * One-shot script that records the two architectural decisions we made in
 * the feat/session-scope-fix conversation:
 *
 *   1. Two-path capture (passive watchers primary, MCP enrichment, synthesis).
 *      Captured in docs/Business/execution-plan/13-universal-capture-governance.md.
 *
 *   2. Defer function-level AST code graph to a later sprint.
 *      Captured in docs/Business/execution-plan/14-function-level-code-graph.md.
 *
 * Normally these would be written via `kodela_record_decision` MCP calls
 * during the design conversation, but the long-running MCP server in this
 * session has a stale module cache that prevents new decisions from being
 * inserted via the tool surface. This script bypasses the tool path and
 * writes directly to the SQLite + JSON store using the same `insertDecision`
 * helper the MCP tool calls underneath.
 *
 * Usage:
 *   KODELA_REPO_ROOT=/path/to/repo pnpm --filter @workspace/mcp-server \
 *     tsx scripts/seed-architectural-decisions.ts
 *
 * Idempotent: skips a decision whose title already exists in the store.
 */

import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KODELA_DIR } from "@kodela/core";
import {
  ensureDecisionTables,
  insertDecision,
  type RecordDecisionInput,
} from "../src/lib/decisions-store.js";

const REPO_ROOT = process.env["KODELA_REPO_ROOT"] ?? process.cwd();
const SESSION_ID = "3f2e6769-a5fe-4274-b98f-b3ab8e329a34";

const TWO_PATH: RecordDecisionInput = {
  title:
    "Adopt two-path capture: passive watchers primary, MCP enrichment fast path, async synthesis",
  category: "architecture",
  problem:
    "Kodela's mission is to capture why/who/purpose for every code change made by any AI agent on any host, ambiently. The MCP-only architecture only works for agents that comply with MCP and produces severe DX friction (per-edit tool calls, permission prompts, session-end failures when the working tree contains files outside session scope). It fails entirely for Codex CLI, Aider, gh-copilot, JetBrains AI, Antigravity, browser-only agents, autonomous CI bots.",
  decision:
    "Adopt a two-path capture architecture. Passive watchers per host (VS Code, JetBrains, shell + pre-commit hook, VCS webhook, browser ext) become the primary input. MCP is demoted to a fast path for agents capable of authoring richer first-party annotations, no longer required for capture. Server-side LLM synthesis fills why/problem/reasoning from (diff + transcript + commit msg) when no MCP annotation exists. Governance enforced at every pillar: capture, transport, synthesis, storage, access. Session scope = files the watcher saw touched, not git-diff against baseline. Full design in docs/Business/execution-plan/13-universal-capture-governance.md.",
  reason:
    "The MCP-only model violates the universal-capture promise: most agents in market today cannot or will not drive MCP, and forcing capture into the agent hot path taxes developer flow. This design conversation paid that tax with permission prompts and a session_end that failed because it conflated session-touched files with pre-existing working-tree state. Demoting MCP to enrichment preserves existing value AND unlocks every other agent. Server-side synthesis closes the long tail without burdening any agent. Embedding governance per pillar makes the system enterprise-defensible by construction.",
  consequences:
    "Commits engineering to building per-host watchers and a synthesis worker. Commits product to maintaining MCP as a first-class but optional surface. Commits governance to enforcing checkpoints at watcher process, Capture Bus edge, synthesis worker, storage layer. Precludes a single-surface strategy and locks in CaptureEvent as the unifying schema.",
  trade_offs:
    "More moving parts (Capture Bus, synthesis worker, 5+ watchers). Synthesis quality must be monitored — provenance tagging distinguishes synthesized from authored annotations plus human override. Browser-extension capture is regulated in some jurisdictions; deferred behind regulatory review.",
  options: [
    {
      label: "MCP-only (status quo)",
      description:
        "Keep MCP as sole capture path. Every agent must read CLAUDE.md and call kodela_annotate_file after every edit, kodela_session_end at end.",
      pros: "First-party annotations from the agent that authored the change. No synthesis-quality risk.",
      cons: "Works for Claude Code only, partially for Cursor. Fails for everything else. Per-edit tool calls and permission prompts erode DX.",
      was_chosen: false,
      rejection_reason:
        "Cannot meet the universal-capture promise. Coverage is bound to MCP adoption inside agent products, a market we do not control.",
    },
    {
      label: "Watcher-only",
      description:
        "Drop MCP. Capture everything passively via per-host watchers. All why/problem/reasoning produced by synthesis.",
      pros: "Maximum coverage, zero agent compliance burden, uniform UX.",
      cons: "Throws away rich first-party annotations MCP-aware agents already produce. Synthesis quality has variance. Watcher fragility leaves no fallback.",
      was_chosen: false,
      rejection_reason:
        "Regresses the existing Claude Code experience and discards the strongest signal we have. Watcher OR MCP is a false choice; both have value.",
    },
    {
      label: "Two-path: watchers primary, MCP enrichment, synthesis filler (chosen)",
      description:
        "Watchers per host emit normalized CaptureEvents to a Capture Bus. MCP agents may write directly with higher-quality annotations that override synthesized output. Synthesis worker fills gaps. Governance checkpoints at every pillar.",
      pros: "Universal coverage including non-MCP agents. Preserves rich first-party annotations where agents opt in. Watcher fragility bounded. Session scoping moves to watcher (touched-files set), fixing INCOMPLETE_PER_FILE_CONTEXT bug.",
      cons: "More moving parts. Synthesis introduces a quality dimension (mitigated by provenance tags + override). Browser-extension pillar deferred behind regulatory review.",
      was_chosen: true,
    },
  ],
  author_id: "praneeth@blash.uk",
  approver_ids: [],
  tags: ["capture-architecture", "mcp", "watcher", "synthesis", "governance", "universal-capture"],
  visibility: "public-to-org",
  decided_at: "2026-06-01T14:00:00Z",
  initial_links: [
    {
      link_type: "document",
      external_id: "docs/Business/execution-plan/13-universal-capture-governance.md",
      display_label: "Doc 13 - Universal Capture & Governance",
    },
    {
      link_type: "document",
      external_id: "docs/Business/execution-plan/07-mcp-expansion.md",
      display_label: "Doc 07 - MCP Roadmap (superseded role)",
    },
    {
      link_type: "document",
      external_id: "docs/Business/execution-plan/08-enterprise-governance.md",
      display_label: "Doc 08 - Enterprise Governance",
    },
    {
      link_type: "session",
      external_id: SESSION_ID,
      display_label: "Session in which this architecture was designed",
    },
  ],
};

const DEFER_FUNCTION_GRAPH: RecordDecisionInput = {
  title: "Defer function-level AST code graph (Tree-sitter parsing) to a later sprint",
  category: "architecture",
  problem:
    "The Memory Graph terminates at file granularity after Phase 2. Users want finer detail — 'which function changed' rather than 'which file changed' — for traceability across long-lived codebases. Building this requires per-language AST parsing, a new node type, and a renderer that scales past the current 200-node sim.",
  decision:
    "Defer the function-level AST code graph until clear prerequisites land: Memory Graph renderer that scales past 200 nodes, customer demand validated, and capture-policy file with per-path exclude rules. Captured the full design (schema additions, parser strategy, edge cases, prerequisite work, trigger conditions, effort estimate ~4 sprints) in docs/Business/execution-plan/14-function-level-code-graph.md so the work is not forgotten.",
  reason:
    "Function granularity is correct but expensive. Per-language parser fan-out (TS, Python, Go, Rust, Java, etc.), node-count explosion (5–50× file count), AST dependency weight, and a missing schema for stable functionId all make this multi-sprint work. We just shipped a useful middle-ground (entry nodes with lineRange + file annotations sub-panel) that gives 80% of the function-level value using the existing data model. Starting Tree-sitter work before the renderer can show 1000+ nodes would deliver invisible value.",
  consequences:
    "Commits to keeping the file → entry → lineRange chain as the deepest grain for the foreseeable future. When we do pick it up, we lead with Tree-sitter (one dep, many language grammars) rather than per-language libs, and behind a 'Expand functions' lazy toggle so the default graph stays performant.",
  trade_offs:
    "Customers asking for function-level navigation today get the line-range sub-panel as the answer. We accept that traceability across renames is partial until the content-hash anchor work lands.",
  options: [
    {
      label: "Ship now with Tree-sitter",
      description: "Add Tree-sitter dep, parsers for TS/TSX/Python, function nodes + CONTAINS + ANNOTATES_FUNCTION edges in this sprint.",
      pros: "Closes the 'function-level memory' use case immediately.",
      cons: "~2 sprints of work shipped at the wrong time — the renderer can't show 1000+ nodes, customer demand unvalidated, dep weight added before policy gating exists.",
      was_chosen: false,
      rejection_reason: "Premature optimization. The 80% case is already addressed by the line-range sub-panel (Option A) and entry nodes (Option B) shipped in the same conversation.",
    },
    {
      label: "Defer with a captured design (chosen)",
      description: "Write docs/Business/execution-plan/14-function-level-code-graph.md capturing the schema, parser strategy, performance budget, edge cases, prerequisite work, trigger conditions, and effort. Pick it up when renderer-scale, customer demand, or a non-TS customer language adoption forces our hand.",
      pros: "No wasted work. Decision is durable in the planning track. Future engineers (or AIs) know exactly what we considered and why.",
      cons: "Customers asking for function-grain today get a partial answer (line ranges in the side panel) until we pick this up.",
      was_chosen: true,
    },
    {
      label: "Heuristic regex parser",
      description: "Use line-based regex (/function\\s+\\w+/) to extract function names without an AST.",
      pros: "Dep-free, fast to implement.",
      cons: "Mis-identifies arrow functions, methods, nested closures, generators, async, TS generics — almost everything modern code uses.",
      was_chosen: false,
      rejection_reason: "Anti-pattern. Document 14 explicitly rejects this; it would produce worse data than no function graph at all.",
    },
  ],
  author_id: "praneeth@blash.uk",
  approver_ids: [],
  tags: ["memory-graph", "function-graph", "ast", "tree-sitter", "deferred"],
  visibility: "public-to-org",
  decided_at: "2026-06-02T22:00:00Z",
  initial_links: [
    {
      link_type: "document",
      external_id: "docs/Business/execution-plan/14-function-level-code-graph.md",
      display_label: "Doc 14 - Function-Level Code Graph (Deferred)",
    },
    {
      link_type: "document",
      external_id: "docs/Business/execution-plan/04-memory-graph.md",
      display_label: "Doc 04 - Memory Graph",
    },
    {
      link_type: "session",
      external_id: SESSION_ID,
      display_label: "Session in which the defer was decided",
    },
  ],
};

function main(): void {
  const dbPath = path.join(REPO_ROOT, KODELA_DIR, "index.db");
  // Open node:sqlite directly. We bypass @kodela/core's openIndex because that
  // helper's getDatabaseSyncSync() uses require() in ESM mode (a known bug in
  // lib/core/src/storage/sqlite-index.ts that also breaks MCP server boot).
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  ensureDecisionTables(db);

  const existing = db
    .prepare("SELECT id, title FROM decisions")
    .all() as Array<{ id: string; title: string }>;

  for (const decision of [TWO_PATH, DEFER_FUNCTION_GRAPH]) {
    const match = existing.find((d) => d.title === decision.title);
    if (match) {
      process.stdout.write(`SKIP  ${match.id}  ${decision.title.slice(0, 60)}…\n`);
      continue;
    }
    const result = insertDecision(db, REPO_ROOT, decision);
    process.stdout.write(
      `WROTE ${result.decision.id}  status=${result.decision.status}  ` +
        `options=${result.options.length}  links=${result.links.length}  ` +
        `${decision.title.slice(0, 60)}…\n`,
    );
  }
}

main();
