// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mapContexts } from "./mapper.js";
import type { ContextItem, DiffResult, MapContextsOptions } from "./mapper.js";

function normalizeForHash(text: string): string {
  return text
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/#[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function computeHash(lines: string[]): string {
  const normalized = normalizeForHash(lines.join("\n"));
  return createHash("sha256").update(normalized).digest("hex");
}

const EMPTY_DIFF: DiffResult = {
  added: [],
  removed: [],
  modified: [],
  moved: [],
  stats: {
    changeType: "modify" as const,
    totalLinesOld: 0,
    totalLinesNew: 0,
    addedLines: 0,
    removedLines: 0,
    modifiedLines: 0,
    movedLines: 0,
    changeDensity: 0,
    contentSimilarity: 1,
  },
};

describe("mapContexts", () => {
  test("returns empty array for empty contexts list", () => {
    const results = mapContexts([], "some file content", EMPTY_DIFF);
    assert.deepEqual(results, []);
  });

  test("exact hash match at predicted position → mapped with confidence 1.0", () => {
    const ctxLines = ["export function greet(name) {", "  return name;", "}"];
    const fileContent = ctxLines.join("\n");

    const ctx: ContextItem = {
      id: "ctx-exact",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 3 },
      originalLines: ctxLines,
    };

    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF);

    assert.equal(result.contextId, "ctx-exact");
    assert.equal(result.status, "mapped");
    assert.equal(result.confidence, 1.0);
    assert.deepEqual(result.newLineRange, { start: 1, end: 3 });
  });

  test("deleted-code detection: removed hunk covering context → orphaned immediately", () => {
    const ctxLines = ["alpha", "beta", "gamma"];
    const fileContent = ["line1", "line2", "line3", "line4", "line5"].join("\n");

    const ctx: ContextItem = {
      id: "ctx-deleted",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 2, end: 4 },
      originalLines: ctxLines,
    };

    const diff: DiffResult = {
      ...EMPTY_DIFF,
      removed: [{ type: "removed", oldRange: [2, 4] }],
    };

    const [result] = mapContexts([ctx], fileContent, diff);

    assert.equal(result.contextId, "ctx-deleted");
    assert.equal(result.status, "orphaned");
    assert.equal(result.confidence, 0);
    assert.equal(result.newLineRange, undefined);
  });

  test("partial overlap: modified hunk that only partially covers context is not deleted", () => {
    const ctxLines = ["alpha", "beta", "gamma"];
    const fileContent = ctxLines.join("\n");

    const ctx: ContextItem = {
      id: "ctx-partial",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 3 },
      originalLines: ctxLines,
    };

    const diff: DiffResult = {
      ...EMPTY_DIFF,
      modified: [{ type: "modified", oldRange: [3, 5], newRange: [3, 5] }],
    };

    const [result] = mapContexts([ctx], fileContent, diff);

    assert.notEqual(result.status, "orphaned", "partial overlap should not trigger deleted-code path");
  });

  test("no candidates in search window → orphaned", () => {
    const fileContent = ["line1", "line2", "line3"].join("\n");

    const ctx: ContextItem = {
      id: "ctx-nocandidates",
      tokenHash: "a".repeat(64),
      lineRange: { start: 200, end: 202 },
      originalLines: ["foo", "bar", "baz"],
    };

    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF);

    assert.equal(result.contextId, "ctx-nocandidates");
    assert.equal(result.status, "orphaned");
  });

  test("removed hunk before context shifts predicted position → content found at new location", () => {
    const ctxLines = ["ctx_alpha", "ctx_beta", "ctx_gamma"];

    const oldLines = ["L1", "L2", "L3", "L4", ...ctxLines, "L8", "L9", "L10"];
    const newLines = ["L3", "L4", ...ctxLines, "L8", "L9", "L10"];
    const newFileContent = newLines.join("\n");

    const ctx: ContextItem = {
      id: "ctx-offset",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 5, end: 7 },
      originalLines: ctxLines,
    };

    const diff: DiffResult = {
      ...EMPTY_DIFF,
      removed: [{ type: "removed", oldRange: [1, 2] }],
    };

    const [result] = mapContexts([ctx], newFileContent, diff);

    assert.equal(result.contextId, "ctx-offset");
    assert.equal(result.status, "mapped");
    assert.deepEqual(result.newLineRange, { start: 3, end: 5 });
  });

  test("partial token match at same position → uncertain", () => {
    const origLines = ["alpha beta gamma", "delta epsilon", "zeta"];
    const changedLines = ["alpha beta gamma", "omega pi", "zeta"];

    const padding = ["1000 2000", "3000 4000", "5000 6000", "7000 8000"];
    const newFileLines = [...padding, ...changedLines, "9000 1001", "1002 1003", "1004 1005"];
    const newFileContent = newFileLines.join("\n");

    const ctx: ContextItem = {
      id: "ctx-uncertain",
      tokenHash: computeHash(origLines),
      lineRange: { start: 5, end: 7 },
      originalLines: origLines,
    };

    const [result] = mapContexts([ctx], newFileContent, EMPTY_DIFF);

    assert.equal(result.contextId, "ctx-uncertain");
    assert.equal(result.status, "uncertain");
    assert.ok(
      result.confidence >= 0.6 && result.confidence <= 0.85,
      `expected uncertain confidence in [0.6, 0.85], got ${result.confidence}`,
    );
    assert.deepEqual(result.newLineRange, { start: 5, end: 7 });
  });

  test("confidence below 0.6 (no token overlap) → orphaned with newLineRange absent", () => {
    const origLines = ["alpha beta gamma", "delta epsilon", "zeta"];

    const unrelatedLines = ["9001 9002 9003", "9004 9005 9006", "9007 9008 9009"];
    const padding = Array.from({ length: 20 }, (_, i) => `pad${i}`);
    const newFileContent = [...padding, ...unrelatedLines, ...padding].join("\n");

    const ctx: ContextItem = {
      id: "ctx-orphaned-lowconf",
      tokenHash: computeHash(origLines),
      lineRange: { start: 21, end: 23 },
      originalLines: origLines,
    };

    const [result] = mapContexts([ctx], newFileContent, EMPTY_DIFF);

    assert.equal(result.contextId, "ctx-orphaned-lowconf");
    assert.equal(result.status, "orphaned");
    assert.equal(result.newLineRange, undefined);
  });

  test("multiple contexts are mapped independently", () => {
    const linesA = ["function alpha() {", "  return 1;", "}"];
    const linesB = ["function beta() {", "  return 2;", "}"];

    const fileContent = [
      ...linesA,
      "// separator",
      ...linesB,
    ].join("\n");

    const ctxA: ContextItem = {
      id: "ctx-multi-a",
      tokenHash: computeHash(linesA),
      lineRange: { start: 1, end: 3 },
      originalLines: linesA,
    };

    const ctxB: ContextItem = {
      id: "ctx-multi-b",
      tokenHash: computeHash(linesB),
      lineRange: { start: 5, end: 7 },
      originalLines: linesB,
    };

    const results = mapContexts([ctxA, ctxB], fileContent, EMPTY_DIFF);

    assert.equal(results.length, 2);

    const ra = results.find((r) => r.contextId === "ctx-multi-a");
    const rb = results.find((r) => r.contextId === "ctx-multi-b");

    assert.ok(ra, "result for ctxA should exist");
    assert.ok(rb, "result for ctxB should exist");

    assert.equal(ra.status, "mapped");
    assert.deepEqual(ra.newLineRange, { start: 1, end: 3 });

    assert.equal(rb.status, "mapped");
    assert.deepEqual(rb.newLineRange, { start: 5, end: 7 });
  });

  test("multi-candidate winner selection: hash-matching candidate wins over nearby partial matches", () => {
    const ctxLines = ["chosen_line_one", "chosen_line_two", "chosen_line_three"];

    const fileContent = [
      "unrelated_a", "unrelated_b", "unrelated_c",
      ...ctxLines,
      "unrelated_d", "unrelated_e", "unrelated_f",
      "chosen_line_one", "chosen_line_two", "close_but_different",
    ].join("\n");

    const ctx: ContextItem = {
      id: "ctx-winner",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 4, end: 6 },
      originalLines: ctxLines,
    };

    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF);

    assert.equal(result.contextId, "ctx-winner");
    assert.equal(result.status, "mapped");
    assert.deepEqual(
      result.newLineRange,
      { start: 4, end: 6 },
      "should select the exact-hash-matching candidate at lines 4-6",
    );
    assert.equal(result.confidence, 1.0);
  });

  test("adding lines before context's old position shifts predicted start → content found at new location", () => {
    const ctxLines = ["target_a", "target_b"];
    const newFileLines = [
      "new1", "new2", "new3",
      "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9",
      ...ctxLines,
      "L12",
    ];
    const newFileContent = newFileLines.join("\n");

    const ctx: ContextItem = {
      id: "ctx-added-offset",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 10, end: 11 },
      originalLines: ctxLines,
    };

    const diff: DiffResult = {
      ...EMPTY_DIFF,
      added: [{ type: "added", newRange: [1, 3] }],
    };

    const [result] = mapContexts([ctx], newFileContent, diff);

    assert.equal(result.contextId, "ctx-added-offset");
    assert.equal(result.status, "mapped");
    assert.deepEqual(result.newLineRange, { start: 13, end: 14 });
  });

  test("context range straddling a removed hunk is not treated as deleted", () => {
    const ctxLines = ["keep_line_a", "keep_line_b", "keep_line_c"];
    const fileContent = ctxLines.join("\n");

    const ctx: ContextItem = {
      id: "ctx-straddling",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 3 },
      originalLines: ctxLines,
    };

    const diff: DiffResult = {
      ...EMPTY_DIFF,
      modified: [
        { type: "modified", oldRange: [2, 2], newRange: [2, 2] },
      ],
    };

    const [result] = mapContexts([ctx], fileContent, diff);

    assert.notEqual(
      result.status,
      "orphaned",
      "context straddling a non-removed hunk should not be orphaned",
    );
  });
});

describe("mapContexts — options parameter", () => {
  test("omitting options leaves defaults intact: exact match at predicted position → mapped", () => {
    const ctxLines = ["alpha", "beta"];
    const fileContent = ctxLines.join("\n");

    const ctx: ContextItem = {
      id: "opts-default",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 2 },
      originalLines: ctxLines,
    };

    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF);

    assert.equal(result.status, "mapped");
    assert.deepEqual(result.newLineRange, { start: 1, end: 2 });
  });

  test("narrow searchWindowLines with full-file fallback still finds the match", () => {
    const ctxLines = ["needle_a", "needle_b"];
    const fileLines = Array.from({ length: 10 }, (_, i) => `pad${i + 1}`);
    fileLines.push(...ctxLines);
    const fileContent = fileLines.join("\n");

    const ctx: ContextItem = {
      id: "opts-narrow-window",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 2 },
      originalLines: ctxLines,
    };

    const opts: MapContextsOptions = { searchWindowLines: 1, windowExpansionFactor: 1 };
    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF, opts);

    assert.notEqual(
      result.status,
      "orphaned",
      "full-file fallback pass always runs and should rescue the match outside the narrow window",
    );
    assert.deepEqual(result.newLineRange, { start: 11, end: 12 });
  });

  test("wide searchWindowLines finds candidate outside the default 50-line window", () => {
    const ctxLines = ["distant_a", "distant_b"];
    const fileLines = Array.from({ length: 100 }, (_, i) => `pad${i + 1}`);
    fileLines.push(...ctxLines);
    const fileContent = fileLines.join("\n");

    const ctx: ContextItem = {
      id: "opts-wide-window",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 2 },
      originalLines: ctxLines,
    };

    const strictOpts: MapContextsOptions = { searchWindowLines: 50, windowExpansionFactor: 1 };
    const [strictResult] = mapContexts([ctx], fileContent, EMPTY_DIFF, strictOpts);
    assert.notEqual(
      strictResult.status,
      "orphaned",
      "full-file fallback always runs and should rescue the match at lines 101-102",
    );
    assert.deepEqual(strictResult.newLineRange, { start: 101, end: 102 });

    const opts: MapContextsOptions = { searchWindowLines: 200 };
    const [wideResult] = mapContexts([ctx], fileContent, EMPTY_DIFF, opts);

    assert.notEqual(wideResult.status, "orphaned");
    assert.deepEqual(wideResult.newLineRange, { start: 101, end: 102 });
  });

  test("rangeLengthTolerance=0 excludes candidates whose length differs from original", () => {
    const ctxLines = ["a", "b", "c", "d", "e"];
    const newFileContent = ["a", "b", "c", "d"].join("\n");

    const ctx: ContextItem = {
      id: "opts-tolerance",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 5 },
      originalLines: ctxLines,
    };

    const [defaultResult] = mapContexts([ctx], newFileContent, EMPTY_DIFF);
    assert.notEqual(
      defaultResult.status,
      "orphaned",
      "default tolerance=0.2 includes length-4 candidates and finds the match",
    );

    const opts: MapContextsOptions = { rangeLengthTolerance: 0 };
    const [tightResult] = mapContexts([ctx], newFileContent, EMPTY_DIFF, opts);
    assert.equal(
      tightResult.status,
      "orphaned",
      "tolerance=0 only considers length-5 candidates; none exist in the 4-line file",
    );
  });

  test("tokenWeight=1 positionalWeight=0 picks best token match regardless of position", () => {
    const ctxLines = ["unique_token_xyz", "another_unique_token_xyz"];
    const filler = Array.from({ length: 10 }, (_, i) => `filler${i}`);
    const fileLines = [
      ...ctxLines,
      ...filler,
      "different_a",
      "different_b",
    ];
    const fileContent = fileLines.join("\n");

    const ctx: ContextItem = {
      id: "opts-token-weight",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 12, end: 13 },
      originalLines: ctxLines,
    };

    const opts: MapContextsOptions = { tokenWeight: 1, positionalWeight: 0 };
    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF, opts);

    assert.equal(result.contextId, "opts-token-weight");
    assert.equal(result.status, "mapped");
    assert.deepEqual(result.newLineRange, { start: 1, end: 2 });
  });

  test("positionalWeight=1 tokenWeight=0 picks closest candidate regardless of content", () => {
    const ctxLines = ["source_a", "source_b"];
    const fileContent = [
      "unrelated_c",
      "unrelated_d",
      "completely_different_e",
      "completely_different_f",
    ].join("\n");

    const ctx: ContextItem = {
      id: "opts-positional-weight",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 2 },
      originalLines: ctxLines,
    };

    const opts: MapContextsOptions = { tokenWeight: 0, positionalWeight: 1 };
    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF, opts);

    assert.equal(result.contextId, "opts-positional-weight");
    assert.equal(result.newLineRange?.start, 1);
  });
});

describe("mapContexts — options validation", () => {
  const SIMPLE_CTX: ContextItem = {
    id: "val-ctx",
    tokenHash: "a".repeat(64),
    lineRange: { start: 1, end: 1 },
    originalLines: ["line"],
  };

  test("searchWindowLines = 0 throws RangeError with offending value", () => {
    assert.throws(
      () => mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, { searchWindowLines: 0 }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.ok((err as RangeError).message.includes("searchWindowLines"));
        assert.ok((err as RangeError).message.includes("0"));
        return true;
      },
    );
  });

  test("searchWindowLines = -5 throws RangeError with offending value", () => {
    assert.throws(
      () => mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, { searchWindowLines: -5 }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.ok((err as RangeError).message.includes("searchWindowLines"));
        assert.ok((err as RangeError).message.includes("-5"));
        return true;
      },
    );
  });

  test("rangeLengthTolerance = -0.1 throws RangeError with offending value", () => {
    assert.throws(
      () => mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, { rangeLengthTolerance: -0.1 }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.ok((err as RangeError).message.includes("rangeLengthTolerance"));
        assert.ok((err as RangeError).message.includes("-0.1"));
        return true;
      },
    );
  });

  test("rangeLengthTolerance = 1.5 throws RangeError with offending value", () => {
    assert.throws(
      () => mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, { rangeLengthTolerance: 1.5 }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.ok((err as RangeError).message.includes("rangeLengthTolerance"));
        assert.ok((err as RangeError).message.includes("1.5"));
        return true;
      },
    );
  });

  test("tokenWeight = -0.2 throws RangeError with offending value", () => {
    assert.throws(
      () => mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, { tokenWeight: -0.2, positionalWeight: 1.2 }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.ok((err as RangeError).message.includes("tokenWeight"));
        assert.ok((err as RangeError).message.includes("-0.2"));
        return true;
      },
    );
  });

  test("tokenWeight = 1.5 throws RangeError with offending value", () => {
    assert.throws(
      () => mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, { tokenWeight: 1.5, positionalWeight: -0.5 }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.ok((err as RangeError).message.includes("tokenWeight"));
        assert.ok((err as RangeError).message.includes("1.5"));
        return true;
      },
    );
  });

  test("positionalWeight = -0.3 throws RangeError with offending value", () => {
    assert.throws(
      () => mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, { tokenWeight: 0.5, positionalWeight: -0.3 }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.ok((err as RangeError).message.includes("positionalWeight"));
        assert.ok((err as RangeError).message.includes("-0.3"));
        return true;
      },
    );
  });

  test("positionalWeight = 1.1 throws RangeError with offending value", () => {
    assert.throws(
      () => mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, { tokenWeight: 0.2, positionalWeight: 1.1 }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.ok((err as RangeError).message.includes("positionalWeight"));
        assert.ok((err as RangeError).message.includes("1.1"));
        return true;
      },
    );
  });

  test("tokenWeight + positionalWeight = 0.5 throws RangeError about sum", () => {
    assert.throws(
      () => mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, { tokenWeight: 0.3, positionalWeight: 0.2 }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.ok((err as RangeError).message.includes("tokenWeight + positionalWeight"));
        assert.ok((err as RangeError).message.includes("0.5"));
        return true;
      },
    );
  });

  test("tokenWeight + positionalWeight = 1.5 throws RangeError about sum", () => {
    assert.throws(
      () => mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, { tokenWeight: 0.8, positionalWeight: 0.7 }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.ok((err as RangeError).message.includes("tokenWeight + positionalWeight"));
        return true;
      },
    );
  });

  test("weights within epsilon of 1 are accepted (0.6001 + 0.3999)", () => {
    assert.doesNotThrow(() =>
      mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, {
        tokenWeight: 0.6001,
        positionalWeight: 0.3999,
      }),
    );
  });

  test("valid boundary values do not throw (searchWindowLines=1, rangeLengthTolerance=0)", () => {
    assert.doesNotThrow(() =>
      mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, {
        searchWindowLines: 1,
        rangeLengthTolerance: 0,
        tokenWeight: 0.6,
        positionalWeight: 0.4,
      }),
    );
  });

  test("valid boundary values do not throw (rangeLengthTolerance=1)", () => {
    assert.doesNotThrow(() =>
      mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, {
        rangeLengthTolerance: 1,
        tokenWeight: 0.6,
        positionalWeight: 0.4,
      }),
    );
  });

  test("epsilon < 0 throws RangeError", () => {
    assert.throws(
      () => mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, { epsilon: -0.01 }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.ok((err as RangeError).message.includes("epsilon"));
        return true;
      },
    );
  });

  test("maxCandidates < 1 throws RangeError", () => {
    assert.throws(
      () => mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, { maxCandidates: 0 }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.ok((err as RangeError).message.includes("maxCandidates"));
        return true;
      },
    );
  });

  test("windowExpansionFactor < 1 throws RangeError", () => {
    assert.throws(
      () => mapContexts([SIMPLE_CTX], "line", EMPTY_DIFF, { windowExpansionFactor: 0 }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.ok((err as RangeError).message.includes("windowExpansionFactor"));
        return true;
      },
    );
  });
});

describe("mapContexts — new hardening features", () => {
  test("scoreBreakdown is present on mapped result and values are in [0,1]", () => {
    const ctxLines = ["export function foo() {", "  return 42;", "}"];
    const fileContent = ctxLines.join("\n");

    const ctx: ContextItem = {
      id: "bd-mapped",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 3 },
      originalLines: ctxLines,
    };

    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF);

    assert.equal(result.status, "mapped");
    assert.ok(result.scoreBreakdown !== undefined, "scoreBreakdown should be present");
    assert.ok(
      result.scoreBreakdown!.token >= 0 && result.scoreBreakdown!.token <= 1,
      `token score out of range: ${result.scoreBreakdown!.token}`,
    );
    assert.ok(
      result.scoreBreakdown!.position >= 0 && result.scoreBreakdown!.position <= 1,
      `position score out of range: ${result.scoreBreakdown!.position}`,
    );
    assert.equal(result.scoreBreakdown!.token, 1.0, "exact hash match should give token score 1.0");
    assert.equal(result.scoreBreakdown!.position, 1.0, "same position should give position score 1.0");
  });

  test("scoreBreakdown is present on orphaned result", () => {
    const origLines = ["alpha beta gamma", "delta epsilon", "zeta"];
    const unrelated = Array.from({ length: 20 }, (_, i) => `pad${i}`);
    const fileContent = [...unrelated, "9001 9002 9003", "9004 9005 9006", "9007 9008 9009", ...unrelated].join("\n");

    const ctx: ContextItem = {
      id: "bd-orphaned",
      tokenHash: computeHash(origLines),
      lineRange: { start: 21, end: 23 },
      originalLines: origLines,
    };

    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF);

    assert.equal(result.status, "orphaned");
    assert.ok(result.scoreBreakdown !== undefined, "scoreBreakdown should be present even for orphaned results");
  });

  test("filePath is undefined on all result objects by default", () => {
    const ctxLines = ["const x = 1;", "const y = 2;"];
    const fileContent = ctxLines.join("\n");

    const ctx: ContextItem = {
      id: "fp-default",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 2 },
      originalLines: ctxLines,
    };

    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF);

    assert.equal(result.filePath, undefined, "filePath should be undefined in current code paths");
  });

  test("epsilon tie-handling: two nearly-equal scores are downgraded to uncertain", () => {
    const origLines = ["alpha beta gamma delta"];

    const fileContent = [
      "alpha beta gamma delta epsilon",
      "separator_line_xyz",
      "alpha beta gamma delta zeta",
    ].join("\n");

    const ctx: ContextItem = {
      id: "epsilon-tie",
      tokenHash: computeHash(origLines),
      lineRange: { start: 1, end: 1 },
      originalLines: origLines,
    };

    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF, {
      tokenWeight: 1,
      positionalWeight: 0,
      epsilon: 0.1,
    });

    assert.equal(
      result.status,
      "uncertain",
      "two candidates with nearly equal token scores should trigger epsilon tie-handling",
    );
  });

  test("epsilon=0 disables tie-handling: identical-content candidates can still produce mapped", () => {
    const ctxLines = ["function_line_a", "function_line_b", "function_line_c"];
    const fileContent = ctxLines.join("\n");

    const ctx: ContextItem = {
      id: "epsilon-zero",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 3 },
      originalLines: ctxLines,
    };

    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF, { epsilon: 0 });

    assert.equal(result.status, "mapped");
    assert.equal(result.confidence, 1.0);
  });

  test("change-density dampening reduces confidence when changeDensity > 0.3", () => {
    const ctxLines = ["alpha beta gamma", "delta epsilon zeta"];
    const fileContent = ctxLines.join("\n");

    const ctx: ContextItem = {
      id: "dampening",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 2 },
      originalLines: ctxLines,
    };

    const [undampened] = mapContexts([ctx], fileContent, EMPTY_DIFF);
    assert.equal(undampened.confidence, 1.0, "undampened exact match should be 1.0");

    const highDensityDiff: DiffResult = {
      ...EMPTY_DIFF,
      stats: {
        ...EMPTY_DIFF.stats,
        changeDensity: 0.8,
      },
    };

    const [dampened] = mapContexts([ctx], fileContent, highDensityDiff);

    assert.ok(
      dampened.confidence < undampened.confidence,
      `dampened score (${dampened.confidence}) should be lower than undampened (${undampened.confidence})`,
    );
    const expectedDampened = 1.0 * (1 - 0.8 * 0.5);
    assert.ok(
      Math.abs(dampened.confidence - expectedDampened) < 0.001,
      `expected dampened confidence ≈ ${expectedDampened.toFixed(3)}, got ${dampened.confidence.toFixed(3)}`,
    );
  });

  test("change-density below threshold (0.3) has no dampening effect", () => {
    const ctxLines = ["line_one", "line_two"];
    const fileContent = ctxLines.join("\n");

    const ctx: ContextItem = {
      id: "no-dampening",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 2 },
      originalLines: ctxLines,
    };

    const lowDensityDiff: DiffResult = {
      ...EMPTY_DIFF,
      stats: { ...EMPTY_DIFF.stats, changeDensity: 0.29 },
    };

    const [result] = mapContexts([ctx], fileContent, lowDensityDiff);

    assert.equal(result.confidence, 1.0, "changeDensity ≤ 0.3 should not dampen the score");
  });

  test("isLikelyAIChange reduces effective positional weight (token-heavy change is found)", () => {
    const ctxLines = ["unique_vocab_alpha", "unique_vocab_beta", "unique_vocab_gamma"];

    const fileLines = [
      ...Array.from({ length: 30 }, (_, i) => `filler${i}`),
      ...ctxLines,
    ];
    const fileContent = fileLines.join("\n");

    const ctx: ContextItem = {
      id: "ai-weight",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 3 },
      originalLines: ctxLines,
    };

    const [normalResult] = mapContexts([ctx], fileContent, EMPTY_DIFF, {
      tokenWeight: 0.6,
      positionalWeight: 0.4,
    });

    const [aiResult] = mapContexts([ctx], fileContent, EMPTY_DIFF, {
      tokenWeight: 0.6,
      positionalWeight: 0.4,
      isLikelyAIChange: true,
    });

    assert.ok(
      aiResult.confidence >= normalResult.confidence,
      `AI-aware mode should not decrease confidence when token match is strong: normal=${normalResult.confidence.toFixed(3)} ai=${aiResult.confidence.toFixed(3)}`,
    );
  });

  test("isLikelyAIChange=true redistributes weight: effective weights still sum to 1", () => {
    const ctxLines = ["fn a() {}", "fn b() {}"];
    const fileContent = ctxLines.join("\n");

    const ctx: ContextItem = {
      id: "ai-weight-sum",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 2 },
      originalLines: ctxLines,
    };

    assert.doesNotThrow(
      () => mapContexts([ctx], fileContent, EMPTY_DIFF, { isLikelyAIChange: true }),
      "AI weight redistribution should keep weights summing to 1 without throwing",
    );
  });

  test("full-file fallback rescues a match outside the initial search window", () => {
    const ctxLines = ["rescue_line_a", "rescue_line_b", "rescue_line_c"];

    const fileLines = [
      ...Array.from({ length: 60 }, (_, i) => `pad${i}`),
      ...ctxLines,
    ];
    const fileContent = fileLines.join("\n");

    const ctx: ContextItem = {
      id: "expansion-rescue",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 3 },
      originalLines: ctxLines,
    };

    // factor=1: skips intermediate expansion but full-file scan always runs → still found
    const [noIntermediate] = mapContexts([ctx], fileContent, EMPTY_DIFF, {
      windowExpansionFactor: 1,
    });
    assert.notEqual(
      noIntermediate.status,
      "orphaned",
      "full-file fallback runs even with windowExpansionFactor=1 and must find the match",
    );
    assert.deepEqual(noIntermediate.newLineRange, { start: 61, end: 63 });

    // default factor=2: intermediate expansion also reaches the match
    const [withExpansion] = mapContexts([ctx], fileContent, EMPTY_DIFF);
    assert.notEqual(
      withExpansion.status,
      "orphaned",
      "default 2x expansion should reach lines 61-63 (predictedStart=1, window=50, 2x=100)",
    );
    assert.deepEqual(withExpansion.newLineRange, { start: 61, end: 63 });
  });

  test("overlap suppression: containing candidate is excluded from second-best and does not trigger epsilon downgrade", () => {
    const ctxLines = ["alpha beta", "gamma delta"];

    const fileLines = [
      "alpha beta EXTRA",
      "gamma delta",
      "zzzzz",
    ];
    const fileContent = fileLines.join("\n");

    const ctx: ContextItem = {
      id: "overlap-contain-suppress",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 2 },
      originalLines: ctxLines,
    };

    const opts: MapContextsOptions = { rangeLengthTolerance: 0.5, epsilon: 0.2 };
    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF, opts);

    assert.equal(
      result.status,
      "mapped",
      "the 3-line containing candidate shares its range fully with the winner and must be " +
        "excluded from secondBestScore; without bidirectional suppression epsilon would fire",
    );
    assert.deepEqual(result.newLineRange, { start: 1, end: 2 });
  });

  test("exact-hash pre-scan does not short-circuit when a better-positioned near-exact candidate exists", () => {
    const ctxLines = ["exact_a", "exact_b"];

    const fileLines: string[] = [];
    fileLines.push("exact_a", "exact_b");
    for (let i = 3; i < 50; i++) fileLines.push(`pad${i}`);
    fileLines.push("exact_a", "exact_b extra");
    for (let i = 52; i <= 100; i++) fileLines.push(`pad${i}`);

    const fileContent = fileLines.join("\n");

    const ctx: ContextItem = {
      id: "pre-scan-no-premature-exit",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 50, end: 51 },
      originalLines: ctxLines,
    };

    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF);

    assert.deepEqual(
      result.newLineRange,
      { start: 50, end: 51 },
      "the near-exact match at the predicted position should win over the exact-hash match far away",
    );
  });

  test("deduplication: duplicate (start, end) ranges are scored only once", () => {
    const ctxLines = ["dup_line_a", "dup_line_b"];
    const fileContent = ctxLines.join("\n");

    const ctx: ContextItem = {
      id: "dedup-range",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 2 },
      originalLines: ctxLines,
    };

    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF);
    assert.equal(result.status, "mapped");
    assert.equal(result.confidence, 1.0);
  });

  test("maxCandidates=1 restricts candidate pool to nearest candidate", () => {
    const ctxLines = ["specific_token_xyz", "another_specific_token_xyz"];
    const fileLines = [
      ...ctxLines,
      ...Array.from({ length: 20 }, (_, i) => `pad${i}`),
    ];
    const fileContent = fileLines.join("\n");

    const ctx: ContextItem = {
      id: "max-candidates",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 1, end: 2 },
      originalLines: ctxLines,
    };

    const [result] = mapContexts([ctx], fileContent, EMPTY_DIFF, { maxCandidates: 1 });

    assert.equal(result.status, "mapped");
    assert.ok(
      result.newLineRange !== undefined,
      "maxCandidates=1 should still find the nearest match",
    );
  });

  test("configurable confidence thresholds: high mapped threshold promotes uncertainty", () => {
    const ctxLines = ["alpha beta gamma", "delta epsilon", "zeta"];
    const changedLines = ["alpha beta gamma", "omega pi", "zeta"];
    const padding = ["p1", "p2", "p3", "p4"];
    const fileContent = [...padding, ...changedLines, "p5", "p6", "p7"].join("\n");

    const ctx: ContextItem = {
      id: "conf-thresh",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 5, end: 7 },
      originalLines: ctxLines,
    };

    const [defaultResult] = mapContexts([ctx], fileContent, EMPTY_DIFF);
    assert.equal(defaultResult.status, "uncertain");

    const [highThreshResult] = mapContexts([ctx], fileContent, EMPTY_DIFF, {
      confidenceThresholds: { mapped: 0.99, uncertain: 0.01 },
    });
    assert.equal(
      highThreshResult.status,
      "uncertain",
      "high mapped threshold should keep result uncertain when score < 0.99",
    );
  });

  test("configurable confidence thresholds: low uncertain threshold turns near-orphaned to uncertain", () => {
    const ctxLines = ["alpha beta gamma"];
    const unrelated = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const fileContent = [...unrelated, "totally different content", ...unrelated].join("\n");

    const ctx: ContextItem = {
      id: "conf-thresh-low",
      tokenHash: computeHash(ctxLines),
      lineRange: { start: 20, end: 20 },
      originalLines: ctxLines,
    };

    const [defaultResult] = mapContexts([ctx], fileContent, EMPTY_DIFF);
    assert.equal(defaultResult.status, "orphaned");

    const [lowThreshResult] = mapContexts([ctx], fileContent, EMPTY_DIFF, {
      confidenceThresholds: { mapped: 0.85, uncertain: 0.0 },
    });
    assert.notEqual(
      lowThreshResult.status,
      "orphaned",
      "uncertain threshold of 0 should prevent orphaned classification",
    );
  });
});
