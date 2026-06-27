// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatDiffResult, formatFileAnalysisResult, runFileAnalysis, runWorkingTreeAnalysis, formatWorkingTreeAnalysisResult, CI_FAILURE_MESSAGE, evaluateCiMode } from "./diff.js";
import type { DiffResult, FileAnalysisResult, WorkingTreeAnalysisResult } from "./diff.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
}

async function gitCommit(dir: string, message: string): Promise<void> {
  // Force hooks off per commit so local/global hook tooling cannot affect tests.
  await execFileAsync(
    "git",
    ["-c", "core.hooksPath=.git/hooks-disabled", "commit", "-m", message],
    { cwd: dir },
  );
}

async function gitCommitAll(dir: string, message = "initial"): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await gitCommit(dir, message);
}

describe("formatDiffResult", () => {
  const emptyResult: DiffResult = {
    from: "HEAD~1",
    to: "HEAD",
    changedFiles: [],
    affectedEntries: [],
  };

  test("shows no changes message when changedFiles is empty", () => {
    const msg = formatDiffResult(emptyResult, "text");
    assert.ok(msg.includes("No changes"));
    assert.ok(msg.includes("HEAD~1"));
  });

  test("json output is valid JSON", () => {
    const msg = formatDiffResult(emptyResult, "json");
    const parsed = JSON.parse(msg) as DiffResult;
    assert.equal(parsed.from, "HEAD~1");
    assert.equal(parsed.to, "HEAD");
  });

  test("text output shows changed file counts", () => {
    const result: DiffResult = {
      from: "abc123",
      to: "def456",
      changedFiles: ["src/foo.ts", "src/bar.ts"],
      affectedEntries: [],
    };
    const msg = formatDiffResult(result, "text");
    assert.ok(msg.includes("Changed files: 2"));
    assert.ok(msg.includes("src/foo.ts"));
  });

  test("text output shows entries for affected files", () => {
    const result: DiffResult = {
      from: "abc",
      to: "def",
      changedFiles: ["src/auth.ts"],
      affectedEntries: [
        {
          filePath: "src/auth.ts",
          entries: [
            {
              schemaVersion: "1.1.0",
              id: "550e8400-e29b-41d4-a716-446655440000",
              filePath: "src/auth.ts",
              astAnchor: null,
              contentHash: "a".repeat(64),
              lineRange: { start: 5, end: 10 },
              note: "Auth logic",
              author: "alice",
              createdAt: "2024-01-01T00:00:00.000Z",
              updatedAt: "2024-01-01T00:00:00.000Z",
              severity: "high",
              tags: [],
              source: "human",
              confidence: 0.9,
              status: "mapped",
              reviewRequired: false,
            },
          ],
        },
      ],
    };
    const msg = formatDiffResult(result, "text");
    assert.ok(msg.includes("src/auth.ts"));
    assert.ok(msg.includes("Auth logic"));
  });
});

describe("formatFileAnalysisResult", () => {
  const baseResult: FileAnalysisResult = {
    filePath: "src/utils.ts",
    baseline: "HEAD",
    baselineAvailable: true,
    stats: {
      added: 3,
      removed: 1,
      modified: 2,
      moved: 0,
      changeDensity: 0.25,
      contentSimilarity: 0.75,
      totalLinesOld: 40,
      totalLinesNew: 45,
    },
    isLikelyAIChange: false,
  };

  test("text output includes file path and baseline ref", () => {
    const msg = formatFileAnalysisResult(baseResult, "text");
    assert.ok(msg.includes("src/utils.ts"), "should show file path");
    assert.ok(msg.includes("HEAD"), "should show baseline ref");
  });

  test("text output includes all four hunk type counts", () => {
    const msg = formatFileAnalysisResult(baseResult, "text");
    assert.ok(msg.includes("Added    : 3"), "should show added hunk count");
    assert.ok(msg.includes("Removed  : 1"), "should show removed hunk count");
    assert.ok(msg.includes("Modified : 2"), "should show modified hunk count");
    assert.ok(msg.includes("Moved    : 0"), "should show moved hunk count");
  });

  test("text output shows changeDensity as percentage and contentSimilarity", () => {
    const msg = formatFileAnalysisResult(baseResult, "text");
    assert.ok(msg.includes("25.0%"), "should show changeDensity as percentage");
    assert.ok(msg.includes("75.0%"), "should show contentSimilarity as percentage");
  });

  test("text output shows AI-change signal as 'no' when not flagged", () => {
    const msg = formatFileAnalysisResult(baseResult, "text");
    assert.ok(
      msg.includes("AI-change signal: no"),
      "should show no AI-change signal",
    );
  });

  test("text output shows AI-change signal message when flagged", () => {
    const flagged: FileAnalysisResult = { ...baseResult, isLikelyAIChange: true };
    const msg = formatFileAnalysisResult(flagged, "text");
    assert.ok(
      msg.includes("YES — likely AI-generated change"),
      "should highlight AI-change signal",
    );
  });

  test("text output warns when baseline is unavailable", () => {
    const noBaseline: FileAnalysisResult = {
      ...baseResult,
      baselineAvailable: false,
    };
    const msg = formatFileAnalysisResult(noBaseline, "text");
    assert.ok(
      msg.includes("not found") || msg.includes("new file"),
      "should warn baseline was not found",
    );
  });

  test("json output is valid JSON with all required fields", () => {
    const raw = formatFileAnalysisResult(baseResult, "json");
    const parsed = JSON.parse(raw) as FileAnalysisResult;
    assert.equal(parsed.filePath, "src/utils.ts");
    assert.equal(parsed.baseline, "HEAD");
    assert.equal(parsed.baselineAvailable, true);
    assert.equal(parsed.isLikelyAIChange, false);
    assert.ok(typeof parsed.stats.changeDensity === "number");
    assert.ok(typeof parsed.stats.contentSimilarity === "number");
    assert.ok(typeof parsed.stats.added === "number");
    assert.ok(typeof parsed.stats.removed === "number");
    assert.ok(typeof parsed.stats.modified === "number");
    assert.ok(typeof parsed.stats.moved === "number");
  });
});

describe("runFileAnalysis", () => {
  let tmpDir: string;
  const originalContent = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-fileanalysis-"));
    await initGitRepo(tmpDir);
    await fs.writeFile(path.join(tmpDir, "utils.ts"), originalContent);
    await gitCommitAll(tmpDir, "initial commit");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns baselineAvailable=true when file exists in git HEAD", async () => {
    const result = await runFileAnalysis({
      repoRoot: tmpDir,
      filePath: "utils.ts",
      baseline: "HEAD",
    });
    assert.equal(result.baselineAvailable, true);
    assert.equal(result.filePath, "utils.ts");
    assert.equal(result.baseline, "HEAD");
  });

  test("unchanged file reports zero change density", async () => {
    const result = await runFileAnalysis({
      repoRoot: tmpDir,
      filePath: "utils.ts",
      baseline: "HEAD",
    });
    assert.equal(result.stats.changeDensity, 0, "no edits = zero change density");
    assert.equal(result.stats.contentSimilarity, 1, "identical content = similarity 1");
    assert.equal(result.isLikelyAIChange, false);
  });

  test("modified file reports non-zero change density", async () => {
    const modifiedContent =
      "export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n" +
      "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
    await fs.writeFile(path.join(tmpDir, "utils.ts"), modifiedContent);

    try {
      const result = await runFileAnalysis({
        repoRoot: tmpDir,
        filePath: "utils.ts",
        baseline: "HEAD",
      });
      assert.ok(result.stats.changeDensity > 0, "edit should produce positive change density");
      assert.ok(result.stats.totalLinesNew > result.stats.totalLinesOld, "new file should have more lines");
    } finally {
      await fs.writeFile(path.join(tmpDir, "utils.ts"), originalContent);
    }
  });

  test("new file (no git baseline) reports baselineAvailable=false and full add density", async () => {
    const newFilePath = path.join(tmpDir, "brand-new.ts");
    await fs.writeFile(newFilePath, "export const x = 42;\n");

    try {
      const result = await runFileAnalysis({
        repoRoot: tmpDir,
        filePath: "brand-new.ts",
        baseline: "HEAD",
      });
      assert.equal(result.baselineAvailable, false, "brand-new file has no git baseline");
      assert.equal(result.stats.totalLinesOld, 0, "old file treated as empty");
      assert.ok(result.stats.totalLinesNew > 0, "new content should be counted");
    } finally {
      await fs.rm(newFilePath, { force: true });
    }
  });

  test("AI-like large rewrite is flagged as isLikelyAIChange", async () => {
    const aiRewrite = Array.from(
      { length: 60 },
      (_, i) => `export const line${i} = ${i} * Math.PI;`,
    ).join("\n") + "\n";

    const rewrittenPath = path.join(tmpDir, "utils.ts");
    await fs.writeFile(rewrittenPath, aiRewrite);

    try {
      const result = await runFileAnalysis({
        repoRoot: tmpDir,
        filePath: "utils.ts",
        baseline: "HEAD",
      });
      assert.equal(result.isLikelyAIChange, true, "large rewrite should flag as likely AI change");
    } finally {
      await fs.writeFile(rewrittenPath, originalContent);
    }
  });

  test("json output from formatFileAnalysisResult round-trips cleanly", async () => {
    const result = await runFileAnalysis({
      repoRoot: tmpDir,
      filePath: "utils.ts",
      baseline: "HEAD",
    });
    const json = formatFileAnalysisResult(result, "json");
    const parsed = JSON.parse(json) as FileAnalysisResult;
    assert.equal(parsed.filePath, result.filePath);
    assert.equal(parsed.baseline, result.baseline);
    assert.equal(parsed.isLikelyAIChange, result.isLikelyAIChange);
    assert.equal(parsed.stats.added, result.stats.added);
    assert.equal(parsed.stats.changeDensity, result.stats.changeDensity);
  });

  test("invalid baseline ref throws a clear error rather than silently treating file as new", async () => {
    await assert.rejects(
      () =>
        runFileAnalysis({
          repoRoot: tmpDir,
          filePath: "utils.ts",
          baseline: "INVALID_REF_THAT_DOES_NOT_EXIST",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "should throw an Error");
        assert.ok(
          err.message.includes("Invalid git baseline") || err.message.includes("INVALID_REF"),
          `error message should mention invalid baseline, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ─── CI mode exit-code path tests ─────────────────────────────────────────────

describe("CI mode exit-code path", () => {
  test("CI_FAILURE_MESSAGE is the exact expected string", () => {
    assert.equal(
      CI_FAILURE_MESSAGE,
      "AI-change signal triggered — add a context note before merging",
    );
  });

  test("evaluateCiMode returns exitCode 0 and pass:true when isLikelyAIChange is false", () => {
    const mockResult: FileAnalysisResult = {
      filePath: "src/utils.ts",
      baseline: "HEAD",
      baselineAvailable: true,
      stats: {
        added: 1, removed: 0, modified: 0, moved: 0,
        changeDensity: 0.05, contentSimilarity: 0.95,
        totalLinesOld: 20, totalLinesNew: 21,
      },
      isLikelyAIChange: false,
    };
    const ci = evaluateCiMode(mockResult);
    assert.equal(ci.pass, true, "no AI signal → CI passes");
    assert.equal(ci.exitCode, 0, "exit code must be 0 when no AI signal");
    assert.equal(ci.message, null, "no failure message when passing");
  });

  test("evaluateCiMode returns exitCode 1, pass:false, and CI_FAILURE_MESSAGE when isLikelyAIChange is true", () => {
    const mockResult: FileAnalysisResult = {
      filePath: "src/generated.ts",
      baseline: "HEAD",
      baselineAvailable: true,
      stats: {
        added: 50, removed: 3, modified: 0, moved: 0,
        changeDensity: 0.9, contentSimilarity: 0.1,
        totalLinesOld: 5, totalLinesNew: 52,
      },
      isLikelyAIChange: true,
    };
    const ci = evaluateCiMode(mockResult);
    assert.equal(ci.pass, false, "AI signal → CI fails");
    assert.equal(ci.exitCode, 1, "exit code must be 1 when AI signal detected");
    assert.equal(ci.message, CI_FAILURE_MESSAGE, "failure message must be CI_FAILURE_MESSAGE");
  });

  let ciTmpDir: string;
  const ciOriginalContent =
    "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n";

  before(async () => {
    ciTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ci-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd: ciTmpDir });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: ciTmpDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: ciTmpDir });
    await fs.writeFile(path.join(ciTmpDir, "greet.ts"), ciOriginalContent);
    await execFileAsync("git", ["add", "-A"], { cwd: ciTmpDir });
    await gitCommit(ciTmpDir, "initial");
  });

  after(async () => {
    await fs.rm(ciTmpDir, { recursive: true, force: true });
  });

  test("evaluateCiMode(runFileAnalysis(...)) → exitCode 0 for an unchanged file", async () => {
    const result = await runFileAnalysis({
      repoRoot: ciTmpDir,
      filePath: "greet.ts",
      baseline: "HEAD",
    });
    const ci = evaluateCiMode(result);
    assert.equal(ci.exitCode, 0, "unchanged file must produce CI exit code 0");
    assert.equal(ci.pass, true);
    assert.equal(ci.message, null);
  });

  test("evaluateCiMode(runFileAnalysis(...)) → exitCode 1 + message for a large AI-like rewrite", async () => {
    const aiRewrite =
      Array.from({ length: 60 }, (_, i) => `export const auto${i} = ${i} * Math.E;`).join("\n") + "\n";
    const greetPath = path.join(ciTmpDir, "greet.ts");
    await fs.writeFile(greetPath, aiRewrite);

    try {
      const result = await runFileAnalysis({
        repoRoot: ciTmpDir,
        filePath: "greet.ts",
        baseline: "HEAD",
      });
      const ci = evaluateCiMode(result);
      assert.equal(ci.exitCode, 1, "AI rewrite must produce CI exit code 1");
      assert.equal(ci.pass, false);
      assert.equal(ci.message, CI_FAILURE_MESSAGE);
    } finally {
      await fs.writeFile(greetPath, ciOriginalContent);
    }
  });
});

// ─── runWorkingTreeAnalysis multi-file tests ──────────────────────────────────

describe("runWorkingTreeAnalysis", () => {
  let wtDir: string;
  const fileA = "module-a.ts";
  const fileB = "module-b.ts";
  const contentA = "export const a = 1;\nexport const a2 = 2;\nexport const a3 = 3;\n";
  const contentB = "export const b = 10;\nexport const b2 = 20;\nexport const b3 = 30;\n";

  before(async () => {
    wtDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-wt-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd: wtDir });
    await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: wtDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: wtDir });
    await fs.writeFile(path.join(wtDir, fileA), contentA);
    await fs.writeFile(path.join(wtDir, fileB), contentB);
    await execFileAsync("git", ["add", "-A"], { cwd: wtDir });
    await gitCommit(wtDir, "initial");
  });

  after(async () => {
    await fs.rm(wtDir, { recursive: true, force: true });
  });

  test("returns empty result when no working-tree changes exist", async () => {
    const result = await runWorkingTreeAnalysis({ repoRoot: wtDir });
    assert.equal(result.totalFiles, 0, "clean working tree has no dirty files");
    assert.equal(result.files.length, 0);
    assert.equal(result.aiChangedCount, 0);
  });

  test("returns one FileAnalysisResult when one file is dirty", async () => {
    const pathA = path.join(wtDir, fileA);
    await fs.writeFile(pathA, contentA + "export const a4 = 4;\n");

    try {
      const result = await runWorkingTreeAnalysis({ repoRoot: wtDir });
      assert.equal(result.totalFiles, 1, "one dirty file should produce one result");
      assert.equal(result.files.length, 1);
      assert.ok(result.files[0]!.filePath.includes("module-a"), "result should reference module-a.ts");
    } finally {
      await fs.writeFile(pathA, contentA);
    }
  });

  test("returns multiple FileAnalysisResults when multiple files are dirty", async () => {
    const pathA = path.join(wtDir, fileA);
    const pathB = path.join(wtDir, fileB);
    await fs.writeFile(pathA, contentA + "export const a4 = 4;\n");
    await fs.writeFile(pathB, contentB + "export const b4 = 40;\n");

    try {
      const result = await runWorkingTreeAnalysis({ repoRoot: wtDir });
      assert.equal(result.totalFiles, 2, "two dirty files should produce two results");
      assert.equal(result.files.length, 2);
    } finally {
      await fs.writeFile(pathA, contentA);
      await fs.writeFile(pathB, contentB);
    }
  });

  test("flags an AI-like large rewrite in the working tree", async () => {
    const pathA = path.join(wtDir, fileA);
    const aiRewrite =
      Array.from({ length: 60 }, (_, i) => `export const generated${i} = ${i} * 3.14;`).join("\n") + "\n";
    await fs.writeFile(pathA, aiRewrite);

    try {
      const result = await runWorkingTreeAnalysis({ repoRoot: wtDir });
      assert.ok(result.totalFiles >= 1, "should detect the dirty file");
      const flagged = result.files.find((f) => f.filePath.includes("module-a"));
      assert.ok(flagged, "module-a.ts should appear in results");
      assert.equal(flagged!.isLikelyAIChange, true, "large AI rewrite should be flagged");
      assert.equal(result.aiChangedCount, 1, "aiChangedCount should reflect the flagged file");
    } finally {
      await fs.writeFile(pathA, contentA);
    }
  });

  test("does not crash when a tracked file is deleted in the working tree", async () => {
    const pathB = path.join(wtDir, fileB);
    await fs.rm(pathB, { force: true });

    try {
      const result = await runWorkingTreeAnalysis({ repoRoot: wtDir });
      // Deleted file must be excluded (--diff-filter=d) — result should not contain it
      const deleted = result.files.find((f) => f.filePath.includes("module-b"));
      assert.equal(deleted, undefined, "deleted file should be excluded, not cause ENOENT crash");
    } finally {
      await fs.writeFile(pathB, contentB);
    }
  });
});

// ─── formatWorkingTreeAnalysisResult tests ────────────────────────────────────

describe("formatWorkingTreeAnalysisResult", () => {
  const emptyResult: WorkingTreeAnalysisResult = {
    files: [],
    totalFiles: 0,
    aiChangedCount: 0,
  };

  const singleResult: WorkingTreeAnalysisResult = {
    files: [
      {
        filePath: "src/api.ts",
        baseline: "HEAD",
        baselineAvailable: true,
        stats: {
          added: 2,
          removed: 1,
          modified: 0,
          moved: 0,
          changeDensity: 0.1,
          contentSimilarity: 0.9,
          totalLinesOld: 10,
          totalLinesNew: 11,
        },
        isLikelyAIChange: false,
      },
    ],
    totalFiles: 1,
    aiChangedCount: 0,
  };

  const aiResult: WorkingTreeAnalysisResult = {
    ...singleResult,
    files: [{ ...singleResult.files[0]!, filePath: "src/generated.ts", isLikelyAIChange: true }],
    aiChangedCount: 1,
  };

  test("text output shows 'No working-tree changes' for empty result", () => {
    const msg = formatWorkingTreeAnalysisResult(emptyResult, "text");
    assert.ok(msg.includes("No working-tree changes"), "should report no changes");
  });

  test("text output shows file path and density for a single dirty file", () => {
    const msg = formatWorkingTreeAnalysisResult(singleResult, "text");
    assert.ok(msg.includes("src/api.ts"), "should show the file path");
    assert.ok(msg.includes("10.0%"), "should show change density as percentage");
  });

  test("text output marks AI-flagged file with [AI] tag", () => {
    const msg = formatWorkingTreeAnalysisResult(aiResult, "text");
    assert.ok(msg.includes("[AI]"), "should mark AI-flagged file");
    assert.ok(msg.includes("flagged"), "should mention AI flagging in summary line");
  });

  test("json output emits a valid JSON array of FileAnalysisResult objects", () => {
    const raw = formatWorkingTreeAnalysisResult(singleResult, "json");
    const parsed = JSON.parse(raw) as FileAnalysisResult[];
    assert.ok(Array.isArray(parsed), "json output should be an array");
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.filePath, "src/api.ts");
    assert.equal(typeof parsed[0]!.stats.changeDensity, "number");
  });
});
