// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { aggregateChanges } from "./aggregation.js";
import { classifyRisk } from "./classify.js";
import { detectModule } from "./module.js";
import { detectAIChange } from "./ai-detect.js";
import type { FileChange, ContextMappingResult } from "./types.js";
import type { DiffResult } from "@kodela/diff";

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function makeDiff(addedLines = 0, removedLines = 0): DiffResult {
  return {
    added: addedLines > 0 ? [{ type: "added", newRange: [1, addedLines] }] : [],
    removed: removedLines > 0 ? [{ type: "removed", oldRange: [1, removedLines] }] : [],
    modified: [],
    moved: [],
    stats: {
      changeType: "modify" as const,
      totalLinesOld: removedLines,
      totalLinesNew: addedLines,
      addedLines,
      removedLines,
      modifiedLines: 0,
      movedLines: 0,
      changeDensity: removedLines > 0 ? removedLines / (removedLines + 1) : 0,
      contentSimilarity: 1,
    },
  };
}

function makeFile(
  filePath: string,
  linesChanged: number,
  opts: {
    changeType?: FileChange["changeType"];
    contexts?: ContextMappingResult[];
    timestamp?: number;
  } = {},
): FileChange {
  return {
    filePath,
    linesChanged,
    changeType: opts.changeType ?? "modify",
    diff: makeDiff(linesChanged),
    contexts: opts.contexts ?? [],
    timestamp: opts.timestamp ?? 1_000_000,
  };
}

function mappedCtx(confidence = 1.0): ContextMappingResult {
  return { contextId: "ctx-1", status: "mapped", confidence };
}

function uncertainCtx(confidence = 0.75): ContextMappingResult {
  return { contextId: "ctx-2", status: "uncertain", confidence };
}

function orphanedCtx(): ContextMappingResult {
  return { contextId: "ctx-3", status: "orphaned", confidence: 0.1 };
}

// ─── aggregateChanges ─────────────────────────────────────────────────────────

describe("aggregateChanges", () => {
  test("returns null for empty input", () => {
    assert.strictEqual(aggregateChanges([]), null);
  });

  test("single low-risk file produces low riskScore", () => {
    const result = aggregateChanges([makeFile("src/utils/helpers.ts", 5)]);
    assert.ok(result !== null);
    assert.strictEqual(result.totalFiles, 1);
    assert.strictEqual(result.totalLinesChanged, 5);
    assert.strictEqual(result.riskScore, "low");
    assert.strictEqual(result.highRiskFiles.length, 0);
    assert.strictEqual(result.mediumRiskFiles.length, 0);
    assert.strictEqual(result.lowRiskFiles.length, 1);
  });

  test("single large file (>100 lines) → high risk", () => {
    const result = aggregateChanges([makeFile("src/utils/big.ts", 150)]);
    assert.ok(result !== null);
    assert.strictEqual(result.riskScore, "high");
    assert.strictEqual(result.highRiskFiles.length, 1);
    assert.strictEqual(result.highRiskFiles[0]!.filePath, "src/utils/big.ts");
  });

  test("changeType rewrite → high risk regardless of line count", () => {
    const file = makeFile("src/tiny.ts", 3, { changeType: "rewrite" });
    const result = aggregateChanges([file]);
    assert.ok(result !== null);
    assert.strictEqual(result.riskScore, "high");
  });

  test("orphaned context → high risk", () => {
    const file = makeFile("src/foo.ts", 5, { contexts: [orphanedCtx()] });
    const result = aggregateChanges([file]);
    assert.ok(result !== null);
    assert.strictEqual(result.riskScore, "high");
  });

  test("sensitive path (auth) → high risk", () => {
    const result = aggregateChanges([makeFile("src/auth/login.ts", 10)]);
    assert.ok(result !== null);
    assert.strictEqual(result.riskScore, "high");
  });

  test("sensitive path (billing) → high risk", () => {
    const result = aggregateChanges([makeFile("src/billing/invoice.ts", 5)]);
    assert.ok(result !== null);
    assert.strictEqual(result.riskScore, "high");
  });

  test("uncertain context → medium risk", () => {
    const file = makeFile("src/helpers.ts", 5, { contexts: [uncertainCtx()] });
    const result = aggregateChanges([file]);
    assert.ok(result !== null);
    assert.strictEqual(result.riskScore, "medium");
  });

  test("linesChanged in 20-100 range → at least medium risk", () => {
    const result = aggregateChanges([makeFile("src/view.ts", 50)]);
    assert.ok(result !== null);
    assert.ok(result.riskScore === "medium" || result.riskScore === "high");
  });

  test("all low-risk batch → minimal summary text", () => {
    const files = [
      makeFile("src/a.ts", 2),
      makeFile("src/b.ts", 3),
    ];
    const result = aggregateChanges(files);
    assert.ok(result !== null);
    assert.strictEqual(result.riskScore, "low");
    assert.ok(result.summaryText.toLowerCase().includes("low-risk"));
  });
});

// ─── Deduplication ────────────────────────────────────────────────────────────

describe("deduplication", () => {
  test("duplicate filePaths are merged (last timestamp wins)", () => {
    const files: FileChange[] = [
      makeFile("src/foo.ts", 10, { timestamp: 1000 }),
      makeFile("src/foo.ts", 99, { timestamp: 2000 }),
    ];
    const result = aggregateChanges(files);
    assert.ok(result !== null);
    assert.strictEqual(result.totalFiles, 1);
    assert.strictEqual(result.totalLinesChanged, 99);
  });

  test("duplicate filePaths with earlier timestamp do not override", () => {
    const files: FileChange[] = [
      makeFile("src/bar.ts", 200, { timestamp: 5000 }),
      makeFile("src/bar.ts", 1, { timestamp: 1000 }),
    ];
    const result = aggregateChanges(files);
    assert.ok(result !== null);
    assert.strictEqual(result.totalFiles, 1);
    assert.strictEqual(result.totalLinesChanged, 200);
  });
});

// ─── AI Detection ─────────────────────────────────────────────────────────────

describe("detectAIChange", () => {
  test("returns false for small, slow batch", () => {
    const files = Array.from({ length: 5 }, (_, i) =>
      makeFile(`src/file${i}.ts`, 10, { timestamp: i * 10000 }),
    );
    const result = detectAIChange(files, 50);
    assert.strictEqual(result, false);
  });

  test("returns true when totalLinesChanged > 500", () => {
    const files = [makeFile("src/big.ts", 600)];
    const result = detectAIChange(files, 600);
    assert.strictEqual(result, true);
  });

  test("returns true when >10 files within <2s window", () => {
    const now = Date.now();
    const files = Array.from({ length: 11 }, (_, i) =>
      makeFile(`src/file${i}.ts`, 5, { timestamp: now + i * 100 }),
    );
    const result = detectAIChange(files, 55);
    assert.strictEqual(result, true);
  });

  test("returns false when >10 files but spread over >2s", () => {
    const now = Date.now();
    const files = Array.from({ length: 11 }, (_, i) =>
      makeFile(`src/file${i}.ts`, 5, { timestamp: now + i * 1000 }),
    );
    const result = detectAIChange(files, 55);
    assert.strictEqual(result, false);
  });

  test("returns true when >10 files exactly at 2s boundary (inclusive)", () => {
    const now = 0;
    const files = Array.from({ length: 11 }, (_, i) =>
      makeFile(`src/file${i}.ts`, 5, { timestamp: now + (i === 10 ? 2000 : i * 100) }),
    );
    const result = detectAIChange(files, 55);
    assert.strictEqual(result, true);
  });

  test("aggregateChanges sets aiDetected=true when >500 lines", () => {
    const files = [makeFile("src/huge.ts", 501, { changeType: "rewrite" })];
    const result = aggregateChanges(files);
    assert.ok(result !== null);
    assert.strictEqual(result.aiDetected, true);
  });
});

// ─── Module Detection ─────────────────────────────────────────────────────────

describe("detectModule", () => {
  const cases: [string, string][] = [
    ["src/auth/login.ts", "auth"],
    ["src/billing/invoice.ts", "billing"],
    ["src/payments/stripe.ts", "payments"],
    ["src/security/csrf.ts", "security"],
    ["lib/core/src/engine/mapper.ts", "core"],
    ["lib/diff/src/diff.ts", "diff"],
    ["lib/watcher/src/watcher.ts", "watcher"],
    ["src/utils/helper.ts", "utils"],
    ["src/components/Button.tsx", "components"],
    ["README.md", "root"],
  ];

  for (const [filePath, expected] of cases) {
    test(`"${filePath}" → "${expected}"`, () => {
      assert.strictEqual(detectModule(filePath), expected);
    });
  }

  test("unknown path falls back to parent directory name", () => {
    const module = detectModule("unknown/xyz/myfile.ts");
    assert.strictEqual(module, "xyz");
  });
});

// ─── classifyRisk ─────────────────────────────────────────────────────────────

describe("classifyRisk", () => {
  test("low confidence (<0.7) → high", () => {
    const file = makeFile("src/foo.ts", 5, {
      contexts: [{ contextId: "c1", status: "mapped", confidence: 0.5 }],
    });
    assert.strictEqual(classifyRisk(file), "high");
  });

  test("confidence between 0.7 and 0.85 → medium", () => {
    const file = makeFile("src/foo.ts", 5, {
      contexts: [{ contextId: "c1", status: "mapped", confidence: 0.8 }],
    });
    assert.strictEqual(classifyRisk(file), "medium");
  });

  test("no contexts, small change → low risk", () => {
    const file = makeFile("src/types.ts", 3);
    assert.strictEqual(classifyRisk(file), "low");
  });

  test("all mapped contexts with high confidence → low risk", () => {
    const file = makeFile("src/types.ts", 5, {
      contexts: [mappedCtx(0.95), mappedCtx(0.98)],
    });
    assert.strictEqual(classifyRisk(file), "low");
  });
});

// ─── Smart Surfacing ──────────────────────────────────────────────────────────

describe("smart surfacing", () => {
  test("returns at most 5 high-risk files", () => {
    const files = Array.from({ length: 8 }, (_, i) =>
      makeFile(`src/auth/file${i}.ts`, 150 + i),
    );
    const result = aggregateChanges(files);
    assert.ok(result !== null);
    assert.ok(result.highRiskFiles.length <= 5);
  });

  test("returns at most 3 medium-risk files", () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      makeFile(`src/view${i}.ts`, 50, { contexts: [uncertainCtx()] }),
    );
    const result = aggregateChanges(files);
    assert.ok(result !== null);
    assert.ok(result.mediumRiskFiles.length <= 3);
  });

  test("high-risk files sorted by linesChanged descending", () => {
    const files = [
      makeFile("src/auth/a.ts", 110),
      makeFile("src/auth/b.ts", 200),
      makeFile("src/auth/c.ts", 150),
    ];
    const result = aggregateChanges(files);
    assert.ok(result !== null);
    const lines = result.highRiskFiles.map((f) => f.linesChanged);
    for (let i = 1; i < lines.length; i++) {
      assert.ok(lines[i - 1]! >= lines[i]!);
    }
  });
});

// ─── Context Impact Analysis ──────────────────────────────────────────────────

describe("context impact", () => {
  test("counts mapped, uncertain, orphaned contexts per file", () => {
    const file = makeFile("src/engine.ts", 5, {
      contexts: [mappedCtx(), mappedCtx(), uncertainCtx(), orphanedCtx()],
    });
    const result = aggregateChanges([file]);
    assert.ok(result !== null);
    const entry = result.highRiskFiles[0]!;
    assert.strictEqual(entry.contextImpact.mapped, 2);
    assert.strictEqual(entry.contextImpact.uncertain, 1);
    assert.strictEqual(entry.contextImpact.orphaned, 1);
  });

  test("all-orphaned batch summary mentions orphaned", () => {
    const files = [
      makeFile("src/a.ts", 5, { contexts: [orphanedCtx()] }),
      makeFile("src/b.ts", 5, { contexts: [orphanedCtx()] }),
    ];
    const result = aggregateChanges(files);
    assert.ok(result !== null);
    assert.ok(result.summaryText.toLowerCase().includes("orphaned"));
  });
});

// ─── Modules Affected ─────────────────────────────────────────────────────────

describe("modulesAffected", () => {
  test("deduplicates and sorts modules alphabetically", () => {
    const files = [
      makeFile("src/auth/login.ts", 5),
      makeFile("src/auth/signup.ts", 5),
      makeFile("src/billing/invoice.ts", 5),
    ];
    const result = aggregateChanges(files);
    assert.ok(result !== null);
    assert.deepStrictEqual(result.modulesAffected, ["auth", "billing"]);
  });
});

// ─── Determinism ──────────────────────────────────────────────────────────────

describe("determinism", () => {
  test("same input produces identical output on repeated calls", () => {
    const files = [
      makeFile("src/auth/a.ts", 120, { contexts: [orphanedCtx()], timestamp: 1000 }),
      makeFile("src/billing/b.ts", 80, { contexts: [uncertainCtx()], timestamp: 1100 }),
      makeFile("src/utils/c.ts", 5, { timestamp: 1200 }),
    ];
    const result1 = aggregateChanges(files);
    const result2 = aggregateChanges(files);
    assert.deepStrictEqual(result1, result2);
  });

  test("order of input files does not affect output", () => {
    const f1 = makeFile("src/auth/a.ts", 120);
    const f2 = makeFile("src/billing/b.ts", 200);
    const result1 = aggregateChanges([f1, f2]);
    const result2 = aggregateChanges([f2, f1]);
    assert.ok(result1 !== null && result2 !== null);
    assert.deepStrictEqual(result1.modulesAffected, result2.modulesAffected);
    assert.strictEqual(result1.totalFiles, result2.totalFiles);
    assert.strictEqual(result1.totalLinesChanged, result2.totalLinesChanged);
    assert.strictEqual(result1.riskScore, result2.riskScore);
  });
});
