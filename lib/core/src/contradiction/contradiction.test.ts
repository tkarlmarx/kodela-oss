// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectContradictions } from "./detect.js";
import { stanceOf } from "./stance.js";
import type { ContradictionDecision } from "./types.js";

/**
 * Golden corpus reproducing the Phase-0 prototype's real cases in a
 * self-contained, deterministic form (no .kodela/index.db needed in CI). Guards
 * the headline de-risking result: 100% precision, 0% false-positive rate on
 * benign changes. If a change to the engine regresses precision, this fails.
 */
const DECISIONS: ContradictionDecision[] = [
  {
    id: "d-mongo",
    title: "Reject MongoDB for the memory store",
    status: "active",
    problem: "Choosing the datastore for shared memory.",
    decision: "Do not use MongoDB; standardize on Postgres and SQLite.",
    reason: "Operational simplicity — we reject MongoDB to avoid a second datastore.",
    supersedes: [],
  },
  {
    id: "d-watcher-old",
    title: "Watcher-first primary capture path",
    status: "superseded",
    problem: "Which capture path is primary?",
    decision: "Use the passive watcher as the primary write path.",
    reason: "Guaranteed coverage — adopt the watcher as primary.",
    supersedes: [],
  },
  {
    id: "d-mcp-new",
    title: "MCP-first primary capture path",
    status: "active",
    problem: "Which capture path is primary?",
    decision: "Make MCP the primary write path; the watcher is the fallback.",
    reason: "Highest-fidelity capture — MCP is primary.",
    supersedes: ["d-watcher-old"],
  },
  {
    id: "d-treesitter",
    title: "Defer the tree-sitter AST code graph",
    status: "proposed", // NOT active — must not be enforced
    problem: "When do we ship the AST code graph?",
    decision: "Defer tree-sitter to a later sprint.",
    reason: "Not yet — focus on capture first; defer tree-sitter.",
    supersedes: [],
  },
];

interface Scenario {
  label: "TRUE" | "BENIGN";
  text: string;
}
const SCENARIOS: Scenario[] = [
  { label: "TRUE", text: "Reintroduce MongoDB as the caching layer for shared memory to speed up recall." },
  { label: "TRUE", text: "Switch the primary write path to passive file watchers; MCP becomes an optional enrichment path." },
  // A miss BY DESIGN — the tree-sitter decision is proposed, not active.
  { label: "BENIGN", text: "Ship the function-level tree-sitter AST code graph now as the default comprehension backend." },
  { label: "BENIGN", text: "Fix a typo in the README and bump the Node version badge." },
  { label: "BENIGN", text: "Add a unit test for the SQLite adapter's entries-for-repo query." },
  { label: "BENIGN", text: "Improve the Postgres connection pool timeout handling for the api-server." },
  { label: "BENIGN", text: "Refactor the CLI help text formatting for the `kodela ui` command." },
  { label: "BENIGN", text: "Add retry logic to the MCP proxy when the upstream model returns a 429." },
];

describe("detectContradictions — precision / false-positive guardrail", () => {
  test("zero false positives on benign changes that merely mention the same tech", () => {
    for (const sc of SCENARIOS.filter((s) => s.label === "BENIGN")) {
      const flags = detectContradictions({ text: sc.text }, DECISIONS);
      assert.equal(
        flags.length,
        0,
        `benign change should not flag but did (${flags.map((f) => f.reason).join("; ")}): "${sc.text}"`,
      );
    }
  });

  test("flags true decision reversals", () => {
    const truthy = SCENARIOS.filter((s) => s.label === "TRUE");
    for (const sc of truthy) {
      const flags = detectContradictions({ text: sc.text }, DECISIONS);
      assert.ok(flags.length > 0, `expected a flag for: "${sc.text}"`);
    }
  });

  test("precision is 100% and FP-rate is 0% on the labeled corpus", () => {
    let tp = 0, fp = 0, tn = 0;
    for (const sc of SCENARIOS) {
      const flagged = detectContradictions({ text: sc.text }, DECISIONS).length > 0;
      const shouldFlag = sc.label === "TRUE";
      if (flagged && shouldFlag) tp++;
      else if (flagged && !shouldFlag) fp++;
      else if (!flagged && !shouldFlag) tn++;
    }
    const precision = tp / (tp + fp || 1);
    assert.equal(fp, 0, "false positives must be zero (the alert-fatigue guarantee)");
    assert.equal(precision, 1, "precision must be 100%");
    assert.ok(tn >= 5, "benign changes must be correctly cleared");
  });
});

describe("detectContradictions — tier behaviour", () => {
  test("Tier 2a: polarity reversal flags at 0.9 with the offending decision", () => {
    const flags = detectContradictions(
      { text: "Reintroduce MongoDB as the caching layer." },
      DECISIONS,
    );
    const f = flags.find((x) => x.decisionId === "d-mongo");
    assert.ok(f, "expected a MongoDB flag");
    assert.equal(f!.kind, "polarity");
    assert.equal(f!.confidence, 0.9);
    assert.equal(f!.entity, "MongoDB");
  });

  test("Tier 2b: primary-slot conflict is flagged when a different mechanism claims 'primary'", () => {
    const flags = detectContradictions(
      { text: "Switch the primary write path to passive file watchers; MCP becomes optional." },
      DECISIONS,
    );
    assert.ok(
      flags.some((f) => f.kind === "primary-slot"),
      `expected a primary-slot flag, got: ${flags.map((f) => f.kind).join(", ")}`,
    );
  });

  test("Tier 3: reviving a superseded stance is flagged as a supersession revival", () => {
    const flags = detectContradictions(
      { text: "Switch the primary write path to passive file watchers; MCP becomes optional." },
      DECISIONS,
    );
    assert.ok(
      flags.some((f) => f.kind === "supersession" && f.decisionId === "d-watcher-old"),
      `expected a supersession flag against the old watcher decision, got: ${flags.map((f) => f.kind + ":" + f.decisionId).join(", ")}`,
    );
  });

  test("proposed (non-active) decisions are not enforced", () => {
    const flags = detectContradictions(
      { text: "Ship the tree-sitter AST code graph now as the default backend." },
      DECISIONS,
    );
    assert.equal(flags.length, 0, "a proposed decision must not produce a flag");
  });

  test("minConfidence filters low-confidence flags", () => {
    const change = { text: "Switch the primary write path to passive file watchers; MCP becomes optional." };
    const all = detectContradictions(change, DECISIONS);
    const highOnly = detectContradictions(change, DECISIONS, { minConfidence: 0.7 });
    assert.ok(all.length >= highOnly.length);
    assert.ok(highOnly.every((f) => f.confidence >= 0.7));
  });
});

describe("stanceOf", () => {
  test("reads opposite polarities from local windows", () => {
    const s = stanceOf("We reject MongoDB but adopt Postgres as the primary store.");
    const mongo = s.find((x) => x.entity === "MongoDB");
    const pg = s.find((x) => x.entity === "Postgres");
    assert.equal(mongo?.polarity, "reject");
    assert.equal(pg?.polarity, "adopt");
    assert.equal(pg?.primary, true);
  });

  test("custom aliases extend the lexicon", () => {
    const s = stanceOf("Adopt Kafka for the event bus.", { aliases: { kafka: "Kafka" } });
    assert.equal(s.find((x) => x.entity === "Kafka")?.polarity, "adopt");
  });
});
