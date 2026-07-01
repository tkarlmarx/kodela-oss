// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Diff impact (Phase 2 — P2.3). Confirms computeImpact does a bounded reverse-
 * dependency BFS (distance labelling), fuses whys + decisions across the blast
 * radius, reports the highest risk, respects maxDepth, and ranks closest-first.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeImpact, type ImpactInput } from "./index.js";
import type { WhyLink, DecisionLink } from "../comprehension/types.js";

function why(severity: WhyLink["severity"], note = "n"): WhyLink {
  return { entryId: `e-${note}`, note, severity, tags: [] };
}

// Dependency shape:  a.ts ← b.ts ← c.ts   (b imports a, c imports b)
function baseInput(over: Partial<ImpactInput> = {}): ImpactInput {
  return {
    changedFiles: ["src/a.ts"],
    dependents: new Map<string, string[]>([
      ["src/a.ts", ["src/b.ts"]],
      ["src/b.ts", ["src/c.ts"]],
    ]),
    whysByFile: new Map<string, WhyLink[]>(),
    ...over,
  };
}

describe("computeImpact (Phase 2 diff impact)", () => {
  test("labels the reverse-dependency blast radius by distance", () => {
    const r = computeImpact(baseInput(), { maxDepth: 2 });
    const byPath = new Map(r.impacted.map((f) => [f.filePath, f.distance]));
    assert.equal(byPath.get("src/a.ts"), 0, "changed file is distance 0");
    assert.equal(byPath.get("src/b.ts"), 1, "direct importer is distance 1");
    assert.equal(byPath.get("src/c.ts"), 2, "importer-of-importer is distance 2");
    assert.equal(r.stats.changed, 1);
    assert.equal(r.stats.dependents, 2);
  });

  test("maxDepth bounds the radius", () => {
    const r = computeImpact(baseInput(), { maxDepth: 1 });
    assert.ok(r.impacted.some((f) => f.filePath === "src/b.ts"));
    assert.ok(!r.impacted.some((f) => f.filePath === "src/c.ts"), "distance-2 file excluded at depth 1");
  });

  test("fuses whys + decisions across the radius and reports highest risk", () => {
    const r = computeImpact(
      baseInput({
        whysByFile: new Map<string, WhyLink[]>([
          ["src/a.ts", [why("low", "changed-note")]],
          ["src/c.ts", [why("critical", "downstream-critical")]],
        ]),
        decisionsByFile: new Map<string, DecisionLink[]>([
          ["src/b.ts", [{ decisionId: "d1", title: "Use ed25519", status: "accepted" }]],
        ]),
      }),
      { maxDepth: 2 },
    );
    assert.equal(r.highestRisk, "critical", "a critical why two hops away still counts");
    assert.equal(r.decisions.length, 1);
    assert.equal(r.decisions[0]!.title, "Use ed25519");
    assert.equal(r.stats.withWhy, 3);
    assert.equal(r.stats.decisions, 1);
  });

  test("ranks closest-to-the-change first", () => {
    const r = computeImpact(baseInput(), { maxDepth: 2 });
    assert.deepEqual(
      r.impacted.map((f) => f.filePath),
      ["src/a.ts", "src/b.ts", "src/c.ts"],
    );
  });

  test("a change with no dependents impacts only itself", () => {
    const r = computeImpact({
      changedFiles: ["src/lonely.ts"],
      dependents: new Map(),
      whysByFile: new Map(),
    });
    assert.equal(r.impacted.length, 1);
    assert.equal(r.stats.dependents, 0);
    assert.equal(r.highestRisk, "none");
  });
});
