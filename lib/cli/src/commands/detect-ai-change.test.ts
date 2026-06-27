// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 58 Phase B — tests for detect-ai-change command.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import {
  parseUnifiedDiff,
  runDetectAiChange,
  formatDetectAiChangeResult,
  formatDetectAiChangeResultJson,
} from "./detect-ai-change.js";
import type { DetectedFile, DetectAiChangeResult } from "./detect-ai-change.js";

// ---------------------------------------------------------------------------
// parseUnifiedDiff — unit tests
// ---------------------------------------------------------------------------

describe("parseUnifiedDiff — empty and no-op inputs", () => {
  test("returns [] for an empty string", () => {
    assert.deepEqual(parseUnifiedDiff(""), []);
  });

  test("returns [] for a string with no file sections", () => {
    assert.deepEqual(parseUnifiedDiff("some random text\nno diff headers here"), []);
  });

  test("skips /dev/null entries (file deletions)", () => {
    const diff = [
      "--- a/removed.ts",
      "+++ /dev/null",
      "@@ -1,5 +0,0 @@",
      "-line1",
      "-line2",
      "-line3",
      "-line4",
      "-line5",
    ].join("\n");
    assert.deepEqual(parseUnifiedDiff(diff), []);
  });
});

describe("parseUnifiedDiff — single file", () => {
  test("counts added and removed lines correctly", () => {
    const diff = [
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1,3 +1,6 @@",
      " context",
      "+added1",
      "+added2",
      "+added3",
      "-removed1",
      " context2",
    ].join("\n");

    const result = parseUnifiedDiff(diff);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.file, "src/auth.ts");
    assert.equal(result[0]!.linesAdded, 3);
    assert.equal(result[0]!.linesRemoved, 1);
  });

  test("strips b/ prefix from git diff format", () => {
    const diff = [
      "+++ b/lib/core/src/index.ts",
      "@@ -0,0 +1,2 @@",
      "+line1",
      "+line2",
    ].join("\n");
    const result = parseUnifiedDiff(diff);
    assert.equal(result[0]!.file, "lib/core/src/index.ts");
  });

  test("detects large contiguous added block (>=20 lines)", () => {
    const hunkLines = Array.from({ length: 25 }, (_, i) => `+line${i}`);
    const diff = [
      "+++ b/large.ts",
      "@@ -0,0 +1,25 @@",
      ...hunkLines,
    ].join("\n");
    const result = parseUnifiedDiff(diff);
    assert.ok(result[0]!.maxHunkAddedLines >= 20, "maxHunkAddedLines should be >=20");
  });

  test("does not falsely flag small hunks as large contiguous blocks", () => {
    const diff = [
      "+++ b/small.ts",
      "@@ -1,3 +1,5 @@",
      " ctx",
      "+add1",
      "+add2",
      "-rem",
    ].join("\n");
    const result = parseUnifiedDiff(diff);
    assert.ok(result[0]!.maxHunkAddedLines < 20, "small hunk should not be flagged");
  });
});

describe("parseUnifiedDiff — multiple files", () => {
  test("parses two files independently", () => {
    const diff = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,1 +1,3 @@",
      "+a",
      "+b",
      "--- a/bar.ts",
      "+++ b/bar.ts",
      "@@ -1,2 +1,1 @@",
      "-removed",
      "+replacement",
    ].join("\n");

    const result = parseUnifiedDiff(diff);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.file, "foo.ts");
    assert.equal(result[0]!.linesAdded, 2);
    assert.equal(result[0]!.linesRemoved, 0);
    assert.equal(result[1]!.file, "bar.ts");
    assert.equal(result[1]!.linesAdded, 1);
    assert.equal(result[1]!.linesRemoved, 1);
  });
});

// ---------------------------------------------------------------------------
// runDetectAiChange — integration tests with temp diff files
// ---------------------------------------------------------------------------

describe("runDetectAiChange — from patch file", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-detect-"));
    await fs.mkdir(path.join(tmpDir, ".git"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".kodela"), { recursive: true });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty result for an empty diff file", async () => {
    const patchFile = path.join(tmpDir, "empty.patch");
    await fs.writeFile(patchFile, "");

    const result = await runDetectAiChange({ repoRoot: tmpDir, diffFile: patchFile });
    assert.equal(result.files.length, 0);
    assert.equal(result.anyLikelyAi, false);
    assert.equal(result.anyUncovered, false);
    assert.equal(result.diffSource, "file");
  });

  test("classifies a 60-line single-hunk addition as likely AI at low threshold", async () => {
    const addedLines = Array.from({ length: 60 }, (_, i) => `+line${i + 1}`);
    const patchContent = [
      "+++ b/src/auth/session.ts",
      "@@ -0,0 +1,60 @@",
      ...addedLines,
    ].join("\n");
    const patchFile = path.join(tmpDir, "big.patch");
    await fs.writeFile(patchFile, patchContent);

    const result = await runDetectAiChange({ repoRoot: tmpDir, diffFile: patchFile }, 0.4);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.file, "src/auth/session.ts");
    assert.equal(result.files[0]!.linesAdded, 60);
    assert.equal(result.anyLikelyAi, true);
  });

  test("classifies a 1-line change as NOT likely AI", async () => {
    const patchContent = [
      "+++ b/src/utils.ts",
      "@@ -5,1 +5,2 @@",
      "+one extra line",
    ].join("\n");
    const patchFile = path.join(tmpDir, "small.patch");
    await fs.writeFile(patchFile, patchContent);

    const result = await runDetectAiChange({ repoRoot: tmpDir, diffFile: patchFile }, 0.6);
    assert.equal(result.files[0]!.likelyAi, false);
    assert.equal(result.anyLikelyAi, false);
  });
});

// ---------------------------------------------------------------------------
// formatDetectAiChangeResult — output formatter tests
// ---------------------------------------------------------------------------

describe("formatDetectAiChangeResult", () => {
  test("returns no-changes message for empty result", () => {
    const result: DetectAiChangeResult = {
      files: [],
      anyLikelyAi: false,
      anyUncovered: false,
      diffSource: "staged",
    };
    const output = formatDetectAiChangeResult(result);
    assert.ok(output.includes("No changes found"), "should say no changes");
  });

  test("shows WARNING when uncovered AI changes are present", () => {
    const result = {
      files: [
        {
          file: "src/auth.ts",
          linesChanged: 70,
          linesAdded: 70,
          linesRemoved: 0,
          ubaScore: 0.75,
          likelyAi: true,
          hasCoveringEntry: false,
          signals: {
            editPattern: 0.9,
            temporalSignature: 0.8,
            fileScope: 0.3,
            structuralChange: 0.7,
            environment: 0.2,
          },
        },
      ],
      anyLikelyAi: true,
      anyUncovered: true,
      diffSource: "staged" as const,
    };
    const output = formatDetectAiChangeResult(result);
    assert.ok(output.includes("WARNING"), "should show WARNING");
    assert.ok(output.includes("src/auth.ts"), "should show file name");
    assert.ok(output.includes("NO ANNOTATION"), "should show NO ANNOTATION");
  });

  test("shows success message when all AI changes are annotated", () => {
    const result = {
      files: [
        {
          file: "src/utils.ts",
          linesChanged: 55,
          linesAdded: 55,
          linesRemoved: 0,
          ubaScore: 0.72,
          likelyAi: true,
          hasCoveringEntry: true,
          signals: {
            editPattern: 0.9,
            temporalSignature: 0.5,
            fileScope: 0.3,
            structuralChange: 0.7,
            environment: 0.2,
          },
        },
      ],
      anyLikelyAi: true,
      anyUncovered: false,
      diffSource: "working-tree" as const,
    };
    const output = formatDetectAiChangeResult(result);
    assert.ok(output.includes("annotated"), "should show annotated");
    assert.ok(!output.includes("WARNING"), "should not show WARNING");
  });

  test("formatDetectAiChangeResultJson returns valid JSON", () => {
    const result: DetectAiChangeResult = {
      files: [],
      anyLikelyAi: false,
      anyUncovered: false,
      diffSource: "file",
    };
    const json = formatDetectAiChangeResultJson(result);
    let parsed: unknown;
    assert.doesNotThrow(() => { parsed = JSON.parse(json); });
    assert.equal((parsed as DetectAiChangeResult).diffSource, "file");
  });
});
