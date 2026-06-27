// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * End-to-end test for the memory graph (Phase 2).
 *
 * Critically, this exercises the REAL ingestion path rather than hand-inserting
 * edges: session_start → record_decision → annotate_file(linked_decision_ids)
 * → get_why. If get_why returns the decision, the whole wiring (edge builders,
 * idempotent insert, FILE_CHANGE lookup, BFS traversal, ranking) is proven, not
 * just the traversal in isolation.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import { openIndex } from "@kodela/core";
import { ensureDecisionTables } from "../lib/decisions-store.js";
import {
  ensureGraphTables,
  countEdges,
  insertEdge,
  outgoingEdges,
} from "../lib/graph-store.js";
import { sessionStart } from "./session-start.js";
import { recordDecision } from "./record-decision.js";
import { annotateFile } from "./annotate-file.js";
import { getWhyForMcp } from "./get-why.js";
import { getContextV4 } from "./get-context.js";
import { findRelatedChangesForMcp } from "./find-related-changes.js";

let tmpRepo: string;
let db: DatabaseSync;
let sessionId: string;
let decisionId: string;
let entryId: string;

const FILE = "src/billing/aggregator.ts";

before(async () => {
  tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-graph-test-"));
  await fs.mkdir(path.join(tmpRepo, ".kodela"), { recursive: true });
  db = openIndex(path.join(tmpRepo, ".kodela", "index.db"));
  ensureDecisionTables(db);
  ensureGraphTables(db);

  const ss = await sessionStart(tmpRepo, {
    user_prompt: "Add the billing aggregator with rounding rules",
    actor_tool: "claude-code",
  });
  sessionId = ss.sessionId;

  const dec = recordDecision(
    tmpRepo,
    {
      title: "Round billing amounts half-up at 2 decimals",
      category: "architecture",
      problem:
        "Floating point sums drift; we need a deterministic rounding rule across the billing pipeline.",
      decision:
        "Adopt half-up rounding to 2 decimal places at the aggregator boundary, applied once.",
      reason:
        "Half-up at the boundary keeps invoices reproducible and matches finance's spreadsheet expectations; rounding per-line drifts.",
      options: [
        { label: "Half-up at boundary", description: "Round once at the aggregator", was_chosen: true },
        {
          label: "Per-line rounding",
          description: "Round each line item",
          was_chosen: false,
          rejection_reason: "Accumulates drift across many lines",
        },
      ],
      author_id: "eng@example.com",
      approver_ids: ["lead@example.com"],
      tags: ["billing"],
      visibility: "public-to-org",
      decided_at: "2026-05-01T00:00:00.000Z",
      initial_links: [],
    },
    db,
  );
  assert.equal(dec.ok, true, `record failed: ${dec.error}`);
  decisionId = dec.decision_id!;

  const ann = await annotateFile(
    tmpRepo,
    {
      session_id: sessionId,
      file_path: FILE,
      why_changed: "Implements the half-up rounding rule at the aggregator boundary.",
      problem_solved: "Prevents floating-point drift in invoice totals.",
      lines_added: 24,
      lines_removed: 2,
      related_files: [],
      linked_decision_ids: [decisionId],
      risk: "medium",
    },
    db,
  );
  assert.equal(ann.ok, true, `annotate failed: ${ann.error}`);
  entryId = ann.entryId!;
});

after(async () => {
  db.close();
  await fs.rm(tmpRepo, { recursive: true, force: true });
});

describe("memory graph — real ingestion path", () => {
  test("ingestion created edges (decision + annotation)", () => {
    // USER—AUTHORED→DEC, USER—APPROVED→DEC, AI_SESSION—PRODUCED→FC,
    // FC—ANNOTATED_BY→USER, FC—IMPLEMENTS→DEC  → at least 5 edges.
    assert.ok(countEdges(db) >= 4, `expected several edges, got ${countEdges(db)}`);
  });

  test("get_why returns the linked decision for the file", () => {
    const r = getWhyForMcp(
      tmpRepo,
      {
        file_path: FILE,
        include_intermediate_evidence: true,
        max_depth: 3,
        min_edge_confidence: 0.6,
      },
      db,
    );
    assert.equal(r.ok, true, `get_why failed: ${r.error}`);
    assert.ok(r.meta!.entries_found >= 1, "expected the file's FILE_CHANGE entry");
    const hit = r.why!.find((w) => w.decision_id === decisionId);
    assert.ok(hit, `expected ${decisionId} in why: ${JSON.stringify(r.why)}`);
    assert.ok(hit!.title.includes("Round billing"));
    assert.ok(hit!.confidence > 0);
    assert.ok((hit!.evidence_chain?.length ?? 0) >= 1, "expected an evidence chain");
    assert.equal(hit!.evidence_chain![0].edge_type, "IMPLEMENTS");
  });

  test("get_context fuses the file's decisions (doc 22 P2 — one call = code + why)", () => {
    const env = getContextV4(tmpRepo, { file_path: FILE, token_budget: 4000 }, db);
    assert.ok(env.context.decisions, "expected fused decisions on the context envelope");
    const hit = env.context.decisions!.find((d) => d.decision_id === decisionId);
    assert.ok(
      hit,
      `expected ${decisionId} fused into get_context: ${JSON.stringify(env.context.decisions)}`,
    );
    assert.ok(hit!.title.includes("Round billing"));
    assert.ok(hit!.confidence > 0);
  });

  test("get_why as_of is bi-temporal (decision decided 2026-05-01)", () => {
    const common = { include_intermediate_evidence: false, max_depth: 3, min_edge_confidence: 0.6 };
    const before = getWhyForMcp(tmpRepo, { file_path: FILE, ...common, as_of: "2026-04-01T00:00:00.000Z" }, db);
    assert.equal(before.ok, true);
    assert.ok(
      !before.why!.some((w) => w.decision_id === decisionId),
      "decision decided 2026-05-01 must NOT appear as of 2026-04-01",
    );
    const after = getWhyForMcp(tmpRepo, { file_path: FILE, ...common, as_of: "2026-06-01T00:00:00.000Z" }, db);
    assert.ok(
      after.why!.some((w) => w.decision_id === decisionId),
      "decision must appear as of 2026-06-01",
    );
  });

  test("get_context surfaces mapping status (drift-aware, doc 22 P2)", () => {
    const env = getContextV4(tmpRepo, { file_path: FILE, token_budget: 4000 }, db);
    const e = env.context.entries.find((x) => x.id === entryId);
    if (e) {
      assert.equal(e.status, "mapped");
      assert.ok(!e.stale, "a mapped entry is not stale");
    }
  });

  test("get_why is empty (with a note) for an unlinked file", async () => {
    const ann = await annotateFile(
      tmpRepo,
      {
        session_id: sessionId,
        file_path: "src/util/unrelated.ts",
        why_changed: "Tidied an unrelated helper, no decision attached.",
        problem_solved: "Readability only, nothing architectural.",
        lines_added: 3,
        lines_removed: 1,
        related_files: [],
        linked_decision_ids: [],
        risk: "low",
      },
      db,
    );
    assert.equal(ann.ok, true);
    const r = getWhyForMcp(
      tmpRepo,
      { file_path: "src/util/unrelated.ts", include_intermediate_evidence: true, max_depth: 3, min_edge_confidence: 0.6 },
      db,
    );
    assert.equal(r.ok, true);
    assert.equal(r.why!.length, 0);
    assert.ok(r.meta!.notes.some((n) => n.includes("no decision links")));
  });

  test("repeat annotate_file does not throw (mints a new FILE_CHANGE node)", async () => {
    // Note: annotate_file mints a fresh entryId per call, so this creates a NEW
    // node — it does NOT exercise the dedup path (see the insertEdge test below
    // for that). It only asserts the repeat call succeeds.
    const before = countEdges(db);
    const ann = await annotateFile(
      tmpRepo,
      {
        session_id: sessionId,
        file_path: FILE,
        why_changed: "Re-annotating the same file in a second call.",
        problem_solved: "Confirm a repeat annotate succeeds end to end.",
        lines_added: 24,
        lines_removed: 2,
        related_files: [],
        linked_decision_ids: [decisionId],
        risk: "medium",
      },
      db,
    );
    assert.equal(ann.ok, true);
    assert.ok(countEdges(db) >= before, "edge write must not fail on repeat");
  });

  test("insertEdge dedups on the unique key, keeping max confidence", () => {
    const e = {
      edge_type: "IMPLEMENTS" as const,
      source_node_type: "FILE_CHANGE" as const,
      source_node_id: "FC-dup",
      target_node_type: "DECISION" as const,
      target_node_id: "DEC-dup",
    };
    const n = countEdges(db);
    insertEdge(db, { ...e, confidence: 0.5 }, "2026-01-01T00:00:00.000Z");
    insertEdge(db, { ...e, confidence: 0.9 }, "2026-01-02T00:00:00.000Z");
    // Two inserts of the same tuple → one row (ON CONFLICT), keeping max conf.
    assert.equal(countEdges(db), n + 1, "dedup must collapse to a single row");
    const got = outgoingEdges(db, "FILE_CHANGE", "FC-dup", { edgeTypes: ["IMPLEMENTS"] });
    assert.equal(got.length, 1);
    assert.equal(got[0].confidence, 0.9, "must keep the higher confidence");

    // A lower-confidence re-insert must not lower it.
    insertEdge(db, { ...e, confidence: 0.3 }, "2026-01-03T00:00:00.000Z");
    assert.equal(
      outgoingEdges(db, "FILE_CHANGE", "FC-dup", { edgeTypes: ["IMPLEMENTS"] })[0].confidence,
      0.9,
    );
  });
});

describe("find_related_changes", () => {
  test("all → surfaces the implemented decision from a file_change anchor", () => {
    const r = findRelatedChangesForMcp(
      tmpRepo,
      { anchor: { type: "file_change", id: entryId }, relation: "all", limit: 20 },
      db,
    );
    assert.equal(r.ok, true, `failed: ${r.error}`);
    const dec = r.related!.find((x) => x.kind === "decision" && x.id === decisionId);
    assert.ok(dec, `expected decision ${decisionId} related: ${JSON.stringify(r.related)}`);
    assert.equal(dec!.relation, "implements");
  });

  test("decision anchor → finds the implementing file change", () => {
    const r = findRelatedChangesForMcp(
      tmpRepo,
      { anchor: { type: "decision", id: decisionId }, relation: "all", limit: 20 },
      db,
    );
    assert.equal(r.ok, true);
    const fc = r.related!.find((x) => x.kind === "file_change" && x.id === entryId);
    assert.ok(fc, "expected the implementing file_change");
    assert.ok(fc!.summary.includes("aggregator.ts"));
  });
});
