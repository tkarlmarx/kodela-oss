// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeGovernance } from "./metrics.js";
import type { ContradictionDecision } from "../contradiction/types.js";
import type { GovernanceChange } from "./metrics.js";

const DECISIONS: ContradictionDecision[] = [
  {
    id: "DEC-1",
    title: "Reject MongoDB for the memory store",
    status: "active",
    decision: "Do not use MongoDB; standardize on Postgres.",
    reason: "We reject MongoDB.",
  },
  {
    id: "DEC-2",
    title: "MCP-first primary capture path",
    status: "active",
    decision: "Make MCP the primary write path.",
    reason: "MCP is primary.",
  },
  { id: "DEC-3", title: "Old choice", status: "superseded", decision: "x", reason: "y" },
  {
    id: "DEC-4",
    title: "Re-adopt MongoDB",
    status: "proposed",
    decision: "Reintroduce MongoDB as the cache.",
    reason: "Adopt MongoDB for speed.",
  },
];

describe("computeGovernance — decision counts", () => {
  test("breaks decisions down by status and computes supersession rate", () => {
    const s = computeGovernance({ decisions: DECISIONS });
    assert.equal(s.decisions.total, 4);
    assert.equal(s.decisions.active, 2);
    assert.equal(s.decisions.superseded, 1);
    assert.equal(s.decisions.proposed, 1);
    assert.equal(s.supersededRate, pctOf(1, 3));
  });

  test("a proposed decision that reverses an active one is a proposedConflict", () => {
    const s = computeGovernance({ decisions: DECISIONS });
    assert.equal(s.proposedConflicts, 1, "DEC-4 re-adopts rejected MongoDB");
  });
});

describe("computeGovernance — decisions honored vs violated", () => {
  const changes: GovernanceChange[] = [
    { id: "c1", text: "Reintroduce MongoDB as the caching layer.", isAi: true, hasCapturedIntent: true },
    { id: "c2", text: "Improve Postgres pool timeout handling.", isAi: true, hasCapturedIntent: true },
    { id: "c3", text: "Add a SQLite adapter test.", isAi: false, hasCapturedIntent: true },
  ];

  test("counts violating changes and reports honored rate", () => {
    const s = computeGovernance({ decisions: DECISIONS, changes });
    assert.equal(s.changesEvaluated, 3);
    assert.equal(s.violatingChanges, 1, "only c1 reverses a decision");
    assert.equal(s.violations[0]!.changeId, "c1");
    assert.equal(s.decisionsHonoredPct, pctOf(2, 3));
  });

  test("100% honored when nothing violates", () => {
    const clean: GovernanceChange[] = [
      { id: "c2", text: "Improve Postgres pool timeout.", isAi: true, hasCapturedIntent: true },
    ];
    const s = computeGovernance({ decisions: DECISIONS, changes: clean });
    assert.equal(s.decisionsHonoredPct, 100);
    assert.equal(s.violatingChanges, 0);
  });

  test("empty-text changes are skipped for violation detection", () => {
    const s = computeGovernance({
      decisions: DECISIONS,
      changes: [{ id: "e", text: "", isAi: true, hasCapturedIntent: false }],
    });
    assert.equal(s.changesEvaluated, 0);
    assert.equal(s.decisionsHonoredPct, 100);
  });
});

describe("computeGovernance — AI intent coverage & score", () => {
  test("computes % AI changes with captured intent", () => {
    const changes: GovernanceChange[] = [
      { id: "a", text: "x", isAi: true, hasCapturedIntent: true },
      { id: "b", text: "y", isAi: true, hasCapturedIntent: false },
      { id: "c", text: "z", isAi: false, hasCapturedIntent: false },
    ];
    const s = computeGovernance({ decisions: [], changes });
    assert.equal(s.aiChanges, 2);
    assert.equal(s.aiChangesWithIntent, 1);
    assert.equal(s.intentCoveragePct, 50);
  });

  test("100% intent coverage when there are no AI changes", () => {
    const s = computeGovernance({ decisions: [], changes: [] });
    assert.equal(s.intentCoveragePct, 100);
    assert.equal(s.governanceScore, 100);
  });

  test("governance score blends honored-rate and intent-coverage", () => {
    const changes: GovernanceChange[] = [
      { id: "a", text: "Reintroduce MongoDB.", isAi: true, hasCapturedIntent: false }, // violates + no intent
      { id: "b", text: "Improve Postgres timeout.", isAi: true, hasCapturedIntent: true },
    ];
    const s = computeGovernance({ decisions: DECISIONS, changes });
    // honored = 1/2 = 50; intent = 1/2 = 50 → score 50
    assert.equal(s.decisionsHonoredPct, 50);
    assert.equal(s.intentCoveragePct, 50);
    assert.equal(s.governanceScore, 50);
  });
});

function pctOf(n: number, d: number): number {
  return Math.round((n / d) * 1000) / 10;
}
