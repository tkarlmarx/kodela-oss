// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { whyForFile, type WhyEdge, type WhyDecision, type WhyEntry } from "./whyForFile.js";

const entries: WhyEntry[] = [
  { id: "e1", filePath: "src/auth/session.ts" },
  { id: "e2", filePath: "src/other.ts" },
];
const decisions: WhyDecision[] = [
  { id: "d1", title: "Rotate refresh tokens", reason: "Prevent token replay after refresh.".repeat(1), decidedAt: "2026-01-01T00:00:00Z" },
  { id: "d2", title: "Use argon2", reason: "Stronger hashing", decidedAt: "2026-02-01T00:00:00Z" },
];

describe("whyForFile", () => {
  test("finds a decision one hop from the file's FILE_CHANGE node", () => {
    const edges: WhyEdge[] = [
      { edgeType: "MOTIVATES", sourceNodeType: "FILE_CHANGE", sourceNodeId: "e1", targetNodeType: "DECISION", targetNodeId: "d1", confidence: 0.9 },
    ];
    const items = whyForFile("src/auth/session.ts", entries, edges, decisions);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.decisionId, "d1");
    assert.equal(items[0]!.title, "Rotate refresh tokens");
    assert.equal(items[0]!.confidence, 0.9);
  });

  test("traverses an intermediate node and multiplies confidence", () => {
    const edges: WhyEdge[] = [
      { edgeType: "BELONGS_TO", sourceNodeType: "FILE_CHANGE", sourceNodeId: "e1", targetNodeType: "CLUSTER", targetNodeId: "c1", confidence: 0.8 },
      { edgeType: "MOTIVATES", sourceNodeType: "CLUSTER", sourceNodeId: "c1", targetNodeType: "DECISION", targetNodeId: "d2", confidence: 0.75 },
    ];
    const items = whyForFile("src/auth/session.ts", entries, edges, decisions);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.decisionId, "d2");
    assert.ok(Math.abs(items[0]!.confidence - 0.6) < 1e-9, "0.8 * 0.75 = 0.6");
  });

  test("ranks multiple decisions by confidence and truncates the reason", () => {
    const longReason = "x".repeat(300);
    const decs: WhyDecision[] = [
      { id: "d1", title: "A", reason: longReason, decidedAt: "2026-01-01T00:00:00Z" },
      { id: "d2", title: "B", reason: "short", decidedAt: "2026-01-01T00:00:00Z" },
    ];
    const edges: WhyEdge[] = [
      { edgeType: "MOTIVATES", sourceNodeType: "FILE_CHANGE", sourceNodeId: "e1", targetNodeType: "DECISION", targetNodeId: "d1", confidence: 0.7 },
      { edgeType: "MOTIVATES", sourceNodeType: "FILE_CHANGE", sourceNodeId: "e1", targetNodeType: "DECISION", targetNodeId: "d2", confidence: 0.95 },
    ];
    const items = whyForFile("src/auth/session.ts", entries, edges, decs);
    assert.deepEqual(items.map((i) => i.decisionId), ["d2", "d1"], "higher confidence first");
    assert.equal(items[1]!.reasonExcerpt.length, 201, "200 chars + ellipsis");
    assert.ok(items[1]!.reasonExcerpt.endsWith("…"));
  });

  test("ignores edges below the confidence floor and outside the allow-list", () => {
    const edges: WhyEdge[] = [
      { edgeType: "MOTIVATES", sourceNodeType: "FILE_CHANGE", sourceNodeId: "e1", targetNodeType: "DECISION", targetNodeId: "d1", confidence: 0.3 },
      { edgeType: "MENTIONS", sourceNodeType: "FILE_CHANGE", sourceNodeId: "e1", targetNodeType: "DECISION", targetNodeId: "d2", confidence: 0.99 },
    ];
    const items = whyForFile("src/auth/session.ts", entries, edges, decisions, { minEdgeConfidence: 0.6 });
    assert.equal(items.length, 0, "low-confidence + non-allow-listed edges dropped");
  });

  test("as_of excludes decisions decided after the cutoff", () => {
    const edges: WhyEdge[] = [
      { edgeType: "MOTIVATES", sourceNodeType: "FILE_CHANGE", sourceNodeId: "e1", targetNodeType: "DECISION", targetNodeId: "d2", confidence: 0.9 },
    ];
    // d2 decided 2026-02-01; as_of 2026-01-15 → excluded.
    const items = whyForFile("src/auth/session.ts", entries, edges, decisions, { asOf: "2026-01-15T00:00:00Z" });
    assert.equal(items.length, 0);
  });

  test("optional evidence chain records the path", () => {
    const edges: WhyEdge[] = [
      { edgeType: "MOTIVATES", sourceNodeType: "FILE_CHANGE", sourceNodeId: "e1", targetNodeType: "DECISION", targetNodeId: "d1", confidence: 0.9 },
    ];
    const items = whyForFile("src/auth/session.ts", entries, edges, decisions, { includeEvidence: true });
    assert.equal(items[0]!.evidenceChain?.length, 1);
    assert.equal(items[0]!.evidenceChain![0]!.edgeType, "MOTIVATES");
  });
});
