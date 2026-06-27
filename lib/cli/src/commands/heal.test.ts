// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runHeal, formatHealResult, applyDiffSignal, parseRenameNameStatus } from "./heal.js";
import { runInit } from "./init.js";
import { runAdd } from "./add.js";
import { KodelaConfigSchema } from "../config/schema.js";
import { readIndex, readContextEntry } from "@kodela/core";

const execFileAsync = promisify(execFile);

/** Initialise a bare git repo so git-based diff lookups work in tests. */
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

/** Stage and commit all current files so HEAD exists. */
async function gitCommitAll(dir: string, message = "initial"): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await gitCommit(dir, message);
}

describe("runHeal", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-heal-test-"));
    await fs.writeFile(
      path.join(tmpDir, "utils.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "utils.ts",
      lineStart: 1,
      lineEnd: 3,
      note: "Add utility",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns heal result with correct totals", async () => {
    const result = await runHeal({ repoRoot: tmpDir });
    assert.equal(result.total, 1);
    assert.equal(result.failed, 0);
    assert.ok(result.healed + result.unchanged === 1);
  });

  test("dry run does not persist changes", async () => {
    const result = await runHeal({ repoRoot: tmpDir, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.ok(typeof result.healed === "number");
  });

  test("returns empty result for repo with no entries", async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-heal-empty-"));
    try {
      await runInit(emptyDir);
      const result = await runHeal({ repoRoot: emptyDir });
      assert.equal(result.total, 0);
      assert.equal(result.healed, 0);
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  test("each heal entry carries a diffSignal field", async () => {
    const result = await runHeal({ repoRoot: tmpDir });
    assert.ok(result.entries.length > 0, "Expected at least one heal entry");
    for (const entry of result.entries) {
      assert.ok(
        ["likely-ai", "possible-rewrite", "minimal", "none"].includes(entry.diffSignal),
        `Unexpected diffSignal value: ${entry.diffSignal}`,
      );
    }
  });

  test("diffSignal is 'none' when no git HEAD exists for the file", async () => {
    const result = await runHeal({ repoRoot: tmpDir });
    for (const entry of result.entries) {
      assert.equal(
        entry.diffSignal,
        "none",
        "Expected 'none' because the test repo has no git HEAD",
      );
    }
  });
});

describe("runHeal – diff signal with git baseline", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-heal-git-"));
    await initGitRepo(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, "src.ts"),
      "export const x = 1;\n",
    );
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "src.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Original constant",
      source: "human",
    });
    await gitCommitAll(tmpDir, "initial");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("diffSignal is 'minimal' when file barely changed", async () => {
    await fs.writeFile(
      path.join(tmpDir, "src.ts"),
      "export const x = 2;\n",
    );
    const result = await runHeal({ repoRoot: tmpDir, filePaths: ["src.ts"] });
    assert.ok(result.entries.length > 0, "Expected at least one entry");
    assert.equal(result.entries[0].diffSignal, "minimal");
  });

  test("diffSignal is 'likely-ai' for a massive rewrite of the file", async () => {
    const bigBlock = Array.from({ length: 60 }, (_, i) =>
      `export const generated_${i} = ${i * 3.14}; // auto-generated line ${i}`,
    ).join("\n");
    await fs.writeFile(path.join(tmpDir, "src.ts"), bigBlock + "\n");

    const result = await runHeal({ repoRoot: tmpDir, filePaths: ["src.ts"] });
    assert.ok(result.entries.length > 0, "Expected at least one entry");
    assert.equal(result.entries[0].diffSignal, "likely-ai");
  });

  test("likely-ai signal caps confidence at 0.6", async () => {
    const bigBlock = Array.from({ length: 60 }, (_, i) =>
      `export const cap_test_${i} = ${i}; // filler`,
    ).join("\n");
    await fs.writeFile(path.join(tmpDir, "src.ts"), bigBlock + "\n");

    const result = await runHeal({ repoRoot: tmpDir, filePaths: ["src.ts"], dryRun: true });
    assert.ok(result.entries.length > 0, "Expected at least one entry");
    const entry = result.entries[0];
    assert.equal(entry.diffSignal, "likely-ai");
    assert.ok(
      entry.after.confidence <= 0.6,
      `Expected confidence <= 0.6 for likely-ai, got ${entry.after.confidence}`,
    );
  });

  test("watcher-triggered heal (filePaths filter) preserves diffSignal end-to-end", async () => {
    // Reset file to a single-line state so the baseline (HEAD) is stable.
    await fs.writeFile(path.join(tmpDir, "src.ts"), "export const x = 1;\n");

    // Simulate the kind of large insertion a watcher batch would trigger.
    const aiBlock = Array.from({ length: 40 }, (_, i) =>
      `export const watcher_${i} = ${i}; // inserted by AI tool`,
    ).join("\n");
    await fs.writeFile(path.join(tmpDir, "src.ts"), aiBlock + "\n");

    // Simulate _healBatch: pass only the changed file paths (deduplicated).
    const changedFiles = ["src.ts"];
    const result = await runHeal({
      repoRoot: tmpDir,
      dryRun: true,
      filePaths: changedFiles,
    });

    assert.ok(result.entries.length > 0, "Watcher heal should find at least one entry");

    for (const entry of result.entries) {
      assert.equal(entry.filePath, "src.ts", "Entry should belong to the triggered file");
      assert.ok(
        ["likely-ai", "possible-rewrite", "minimal", "none"].includes(entry.diffSignal),
        `diffSignal must be a valid value, got: ${entry.diffSignal}`,
      );
    }

    // A 40-line insertion replacing a 1-line original is large enough to trigger likely-ai.
    const signal = result.entries[0].diffSignal;
    assert.ok(
      signal === "likely-ai" || signal === "possible-rewrite",
      `Expected high-signal classification from watcher heal, got: ${signal}`,
    );

    // Confidence should be reduced from the mapping result.
    assert.ok(
      result.entries[0].after.confidence <= 0.6,
      `Watcher heal confidence should be capped for a large AI-style insertion`,
    );
  });
});

describe("formatHealResult", () => {
  test("shows summary line with counts", () => {
    const msg = formatHealResult({
      total: 10,
      healed: 3,
      unchanged: 6,
      failed: 1,
      entries: [],
      dryRun: false,
    });
    assert.ok(msg.includes("3 updated"));
    assert.ok(msg.includes("6 unchanged"));
    assert.ok(msg.includes("1 failed"));
  });

  test("includes DRY RUN prefix for dry runs", () => {
    const msg = formatHealResult({
      total: 5, healed: 2, unchanged: 3, failed: 0, entries: [], dryRun: true,
    });
    assert.ok(msg.includes("[DRY RUN]"));
  });

  test("includes diff signal annotation for likely-ai and possible-rewrite entries", () => {
    const msg = formatHealResult({
      total: 2,
      healed: 2,
      unchanged: 0,
      failed: 0,
      dryRun: false,
      entries: [
        {
          id: "a",
          filePath: "foo.ts",
          before: { lineRange: { start: 1, end: 3 }, status: "mapped", confidence: 0.9 },
          after: { lineRange: { start: 1, end: 3 }, status: "uncertain", confidence: 0.5 },
          changed: true,
          diffSignal: "likely-ai",
        },
        {
          id: "b",
          filePath: "bar.ts",
          before: { lineRange: { start: 5, end: 10 }, status: "mapped", confidence: 0.8 },
          after: { lineRange: { start: 5, end: 10 }, status: "mapped", confidence: 0.68 },
          changed: true,
          diffSignal: "possible-rewrite",
        },
      ],
    });
    assert.ok(msg.includes("likely-ai"), "Expected 'likely-ai' annotation in output");
    assert.ok(msg.includes("possible-rewrite"), "Expected 'possible-rewrite' annotation in output");
  });

  test("does not annotate entries with minimal or none diffSignal", () => {
    const msg = formatHealResult({
      total: 1,
      healed: 1,
      unchanged: 0,
      failed: 0,
      dryRun: false,
      entries: [
        {
          id: "c",
          filePath: "baz.ts",
          before: { lineRange: { start: 1, end: 2 }, status: "mapped", confidence: 0.95 },
          after: { lineRange: { start: 2, end: 3 }, status: "mapped", confidence: 0.95 },
          changed: true,
          diffSignal: "minimal",
        },
      ],
    });
    assert.ok(!msg.includes("(minimal)"), "Should not annotate minimal changes");
    assert.ok(!msg.includes("(none)"), "Should not annotate none signal");
  });

  test("verbose mode shows score breakdown when scoreBreakdown is present", () => {
    const msg = formatHealResult(
      {
        total: 1,
        healed: 1,
        unchanged: 0,
        failed: 0,
        dryRun: false,
        entries: [
          {
            id: "d",
            filePath: "src/util.ts",
            before: { lineRange: { start: 10, end: 15 }, status: "mapped", confidence: 0.95 },
            after: { lineRange: { start: 12, end: 17 }, status: "mapped", confidence: 0.88 },
            changed: true,
            diffSignal: "minimal",
            scoreBreakdown: { token: 0.92, position: 0.81 },
          },
        ],
      },
      true,
    );
    assert.ok(msg.includes("score breakdown:"), "Expected score breakdown label in verbose output");
    assert.ok(msg.includes("token=92.0%"), "Expected token score in verbose output");
    assert.ok(msg.includes("position=81.0%"), "Expected position score in verbose output");
  });

  test("verbose mode omits score breakdown line when scoreBreakdown is absent", () => {
    const msg = formatHealResult(
      {
        total: 1,
        healed: 1,
        unchanged: 0,
        failed: 0,
        dryRun: false,
        entries: [
          {
            id: "e",
            filePath: "src/other.ts",
            before: { lineRange: { start: 1, end: 5 }, status: "mapped", confidence: 0.9 },
            after: { lineRange: { start: 3, end: 7 }, status: "mapped", confidence: 0.87 },
            changed: true,
            diffSignal: "none",
          },
        ],
      },
      true,
    );
    assert.ok(!msg.includes("score breakdown:"), "Should not show breakdown line when scoreBreakdown is absent");
  });

  test("non-verbose mode never shows score breakdown even when scoreBreakdown is present", () => {
    const msg = formatHealResult({
      total: 1,
      healed: 1,
      unchanged: 0,
      failed: 0,
      dryRun: false,
      entries: [
        {
          id: "f",
          filePath: "src/foo.ts",
          before: { lineRange: { start: 1, end: 3 }, status: "mapped", confidence: 0.95 },
          after: { lineRange: { start: 2, end: 4 }, status: "mapped", confidence: 0.9 },
          changed: true,
          diffSignal: "minimal",
          scoreBreakdown: { token: 0.85, position: 0.75 },
        },
      ],
    });
    assert.ok(!msg.includes("score breakdown:"), "Should not show breakdown in non-verbose mode");
  });
});

// ─── runHeal + formatHealResult verbose integration ───────────────────────────

describe("runHeal – scoreBreakdown in verbose output", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-heal-verbose-"));
    await fs.writeFile(
      path.join(tmpDir, "calc.ts"),
      "export function multiply(a: number, b: number): number {\n  return a * b;\n}\n",
    );
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "calc.ts",
      lineStart: 1,
      lineEnd: 3,
      note: "Multiply utility",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("scoreBreakdown is present on heal entries after a real runHeal", async () => {
    const result = await runHeal({ repoRoot: tmpDir });
    assert.ok(result.entries.length > 0, "Expected at least one heal entry");
    for (const entry of result.entries) {
      assert.ok(
        entry.scoreBreakdown !== undefined,
        "Expected scoreBreakdown to be populated by the token-hash layer",
      );
      assert.ok(
        typeof entry.scoreBreakdown!.token === "number",
        "scoreBreakdown.token must be a number",
      );
      assert.ok(
        typeof entry.scoreBreakdown!.position === "number",
        "scoreBreakdown.position must be a number",
      );
    }
  });

  test("formatHealResult with verbose=true shows score breakdown from real heal data", async () => {
    // Modify the file so the entry is updated and scoreBreakdown is from a
    // window-similarity search (not the trivial same-position exact match).
    await fs.writeFile(
      path.join(tmpDir, "calc.ts"),
      "// header comment\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n",
    );
    const result = await runHeal({ repoRoot: tmpDir, dryRun: true });
    const output = formatHealResult(result, true);

    const hasBreakdown = result.entries.some((e) => e.scoreBreakdown !== undefined);
    if (hasBreakdown) {
      assert.ok(
        output.includes("score breakdown:"),
        "Expected verbose output to contain score breakdown when entries have scoreBreakdown",
      );
    }
  });
});

// ─── applyDiffSignal – configurable threshold unit tests ──────────────────────

describe("applyDiffSignal – configurable thresholds", () => {
  test("default thresholds: likely-ai caps at 0.6", () => {
    const result = applyDiffSignal("likely-ai", 0.9, false);
    assert.equal(result.confidence, 0.6);
    assert.equal(result.reviewRequired, true);
  });

  test("default thresholds: possible-rewrite multiplies by 0.85", () => {
    const result = applyDiffSignal("possible-rewrite", 1.0, false);
    assert.ok(
      Math.abs(result.confidence - 0.85) < 0.001,
      `Expected 0.85, got ${result.confidence}`,
    );
    assert.equal(result.reviewRequired, true);
  });

  test("custom ai_confidence_cap of 0.4 applies a stricter cap", () => {
    const result = applyDiffSignal("likely-ai", 0.9, false, 0.4);
    assert.equal(result.confidence, 0.4, "custom cap of 0.4 should apply");
    assert.equal(result.reviewRequired, true);
  });

  test("custom ai_confidence_cap does not lower confidence already below the cap", () => {
    const result = applyDiffSignal("likely-ai", 0.3, false, 0.4);
    assert.equal(result.confidence, 0.3, "confidence already below cap must not be raised");
  });

  test("custom rewrite_confidence_factor of 0.5 halves the confidence", () => {
    const result = applyDiffSignal("possible-rewrite", 0.8, false, 0.6, 0.5);
    assert.ok(
      Math.abs(result.confidence - 0.4) < 0.001,
      `Expected 0.4, got ${result.confidence}`,
    );
  });

  test("minimal signal returns unchanged confidence regardless of custom thresholds", () => {
    const result = applyDiffSignal("minimal", 0.9, false, 0.1, 0.1);
    assert.equal(result.confidence, 0.9);
    assert.equal(result.reviewRequired, false);
  });
});

// ─── runHeal – rewrite_confidence_factor integration test ─────────────────────

describe("runHeal – configurable rewrite_confidence_factor via config", () => {
  let tmpDir: string;

  // Committed baseline: 7 identical comment lines + 3 unique anchor lines (10 total).
  // Working-tree replacement: 3 anchor lines kept + 8 new unique export lines (no comments).
  //
  // This yields:
  //   changeDensity   = 7/10 = 0.70  → isPossibleRewrite = true  (> 0.6)
  //   addedLines      = 8            → largeInsertion    = false  (≤ 20)
  //   contentSimilarity = 2×3/15 = 0.4 → lowSimilarity  = false  (not < 0.4)
  //
  // Only 1 AI signal (highDensity) → isLikelyAIChange = false → signal = "possible-rewrite"
  const committed =
    Array.from({ length: 7 }, () => "// auto-comment\n").join("") +
    "export const KEEP_A = 1;\n" +
    "export const KEEP_B = 2;\n" +
    "export const KEEP_C = 3;\n";

  const workingTree =
    "export const KEEP_A = 1;\n" +
    "export const KEEP_B = 2;\n" +
    "export const KEEP_C = 3;\n" +
    Array.from({ length: 8 }, (_, i) => `export const NEW_${i + 1} = ${i + 1};\n`).join("");

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-heal-rwf-"));
    await initGitRepo(tmpDir);
    await fs.writeFile(path.join(tmpDir, "module.ts"), committed);
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "module.ts",
      lineStart: 1,
      lineEnd: 10,
      note: "Original module",
      source: "human",
    });
    await gitCommitAll(tmpDir, "initial");
    await fs.writeFile(path.join(tmpDir, "module.ts"), workingTree);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("diffSignal is possible-rewrite for the crafted fixture", async () => {
    const result = await runHeal({ repoRoot: tmpDir, dryRun: true });
    const entry = result.entries.find((e) => e.filePath === "module.ts");
    assert.ok(entry, "Expected a heal entry for module.ts");
    assert.equal(
      entry!.diffSignal,
      "possible-rewrite",
      `Expected possible-rewrite, got ${entry!.diffSignal}`,
    );
  });

  test("custom rewrite_confidence_factor of 0.5 yields lower confidence than default 0.85", async () => {
    const defaultResult = await runHeal({ repoRoot: tmpDir, dryRun: true });
    const customConfig = KodelaConfigSchema.parse({
      heal: { ai_confidence_cap: 0.6, rewrite_confidence_factor: 0.5 },
    });
    const customResult = await runHeal({ repoRoot: tmpDir, dryRun: true, config: customConfig });

    const defaultEntry = defaultResult.entries.find((e) => e.filePath === "module.ts");
    const customEntry = customResult.entries.find((e) => e.filePath === "module.ts");

    assert.ok(defaultEntry && customEntry, "Expected heal entries for module.ts");
    assert.equal(defaultEntry!.diffSignal, "possible-rewrite");
    assert.equal(customEntry!.diffSignal, "possible-rewrite");
    assert.ok(
      customEntry!.after.confidence < defaultEntry!.after.confidence,
      `factor=0.5 confidence (${customEntry!.after.confidence}) must be < factor=0.85 confidence (${defaultEntry!.after.confidence})`,
    );
  });
});

// ─── runHeal – configurable thresholds integration tests ──────────────────────

describe("runHeal – configurable heal thresholds via config", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-heal-cfg-"));
    await initGitRepo(tmpDir);
    await fs.writeFile(path.join(tmpDir, "src.ts"), "export const x = 1;\n");
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "src.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Original constant",
      source: "human",
    });
    await gitCommitAll(tmpDir, "initial");

    // Write a large AI-like rewrite so the diff signal is "likely-ai".
    const bigBlock = Array.from({ length: 60 }, (_, i) =>
      `export const cfg_${i} = ${i}; // filler`,
    ).join("\n");
    await fs.writeFile(path.join(tmpDir, "src.ts"), bigBlock + "\n");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("default config caps likely-ai confidence at 0.6", async () => {
    const result = await runHeal({ repoRoot: tmpDir, dryRun: true });
    const entry = result.entries.find((e) => e.filePath === "src.ts");
    assert.ok(entry, "Expected a heal entry for src.ts");
    assert.equal(entry!.diffSignal, "likely-ai");
    assert.ok(
      entry!.after.confidence <= 0.6,
      `Default cap: expected confidence <= 0.6, got ${entry!.after.confidence}`,
    );
  });

  test("custom ai_confidence_cap of 0.3 produces lower confidence than default", async () => {
    const config = KodelaConfigSchema.parse({
      heal: { ai_confidence_cap: 0.3, rewrite_confidence_factor: 0.85 },
    });
    const result = await runHeal({ repoRoot: tmpDir, dryRun: true, config });
    const entry = result.entries.find((e) => e.filePath === "src.ts");
    assert.ok(entry, "Expected a heal entry for src.ts");
    assert.equal(entry!.diffSignal, "likely-ai");
    assert.ok(
      entry!.after.confidence <= 0.3,
      `Custom cap 0.3: expected confidence <= 0.3, got ${entry!.after.confidence}`,
    );
  });

  test("a stricter cap (0.3) produces confidence <= a looser cap (0.9) for the same file", async () => {
    const strictConfig = KodelaConfigSchema.parse({
      heal: { ai_confidence_cap: 0.3, rewrite_confidence_factor: 0.85 },
    });
    const looseConfig = KodelaConfigSchema.parse({
      heal: { ai_confidence_cap: 0.9, rewrite_confidence_factor: 0.85 },
    });

    const strictResult = await runHeal({ repoRoot: tmpDir, dryRun: true, config: strictConfig });
    const looseResult = await runHeal({ repoRoot: tmpDir, dryRun: true, config: looseConfig });

    const strictEntry = strictResult.entries.find((e) => e.filePath === "src.ts");
    const looseEntry = looseResult.entries.find((e) => e.filePath === "src.ts");

    assert.ok(strictEntry && looseEntry, "Expected heal entries for src.ts");
    assert.equal(strictEntry!.diffSignal, "likely-ai");
    assert.ok(
      strictEntry!.after.confidence <= looseEntry!.after.confidence,
      `Stricter cap must yield confidence <= looser cap: ${strictEntry!.after.confidence} vs ${looseEntry!.after.confidence}`,
    );
    assert.ok(
      strictEntry!.after.confidence <= 0.3,
      `Strict cap 0.3 must hold: got ${strictEntry!.after.confidence}`,
    );
  });
});

// ─── parseRenameNameStatus – unit tests ───────────────────────────────────────

describe("parseRenameNameStatus", () => {
  test("returns new path for a matching rename line", () => {
    const output = "R100\tsrc/old.ts\tsrc/new.ts\n";
    assert.equal(parseRenameNameStatus(output, "src/old.ts"), "src/new.ts");
  });

  test("returns null when old path does not match", () => {
    const output = "R100\tsrc/other.ts\tsrc/new.ts\n";
    assert.equal(parseRenameNameStatus(output, "src/old.ts"), null);
  });

  test("returns null for empty output", () => {
    assert.equal(parseRenameNameStatus("", "src/old.ts"), null);
  });

  test("ignores non-rename lines (added, modified, deleted)", () => {
    const output = "A\tsrc/added.ts\nM\tsrc/modified.ts\nD\tsrc/old.ts\n";
    assert.equal(parseRenameNameStatus(output, "src/old.ts"), null);
  });

  test("handles multiple rename lines and returns the correct match", () => {
    const output = [
      "R100\tsrc/a.ts\tsrc/b.ts",
      "R95\tsrc/old.ts\tsrc/moved.ts",
      "R80\tsrc/c.ts\tsrc/d.ts",
    ].join("\n");
    assert.equal(parseRenameNameStatus(output, "src/old.ts"), "src/moved.ts");
  });
});

// ─── runHeal – same-file move (no-op) ─────────────────────────────────────────

describe("runHeal – same-file content move (file still at original path)", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-heal-samefile-"));
    await fs.writeFile(
      path.join(tmpDir, "widget.ts"),
      "export const PI = 3.14;\n",
    );
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "widget.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "PI constant",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("newFilePath is undefined when the file exists at its stored path", async () => {
    const result = await runHeal({ repoRoot: tmpDir });
    assert.ok(result.entries.length > 0);
    for (const entry of result.entries) {
      assert.equal(
        entry.newFilePath,
        undefined,
        "newFilePath must be absent when the file has not moved",
      );
    }
  });
});

// ─── runHeal – cross-file move via committed git rename ────────────────────────

describe("runHeal – cross-file move detected from committed git rename", () => {
  let tmpDir: string;
  let entryId: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-heal-xfile-"));
    await initGitRepo(tmpDir);

    // Create and commit the original file with an annotation.
    await fs.writeFile(
      path.join(tmpDir, "alpha.ts"),
      "export function greet(): string {\n  return 'hello';\n}\n",
    );
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "alpha.ts",
      lineStart: 1,
      lineEnd: 3,
      note: "Greet function",
      source: "human",
    });

    // Capture the entry id for later persistence check.
    const index = await readIndex(tmpDir);
    entryId = index.entries[0];

    await gitCommitAll(tmpDir, "initial");

    // Rename the file and commit so git records the rename.
    await execFileAsync("git", ["mv", "alpha.ts", "beta.ts"], { cwd: tmpDir });
    await gitCommit(tmpDir, "rename alpha.ts to beta.ts");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("heal entry reports newFilePath matching the renamed destination", async () => {
    const result = await runHeal({ repoRoot: tmpDir, dryRun: true });
    assert.ok(result.entries.length > 0, "Expected at least one heal entry");
    const entry = result.entries.find((e) => e.filePath === "alpha.ts");
    assert.ok(entry, "Expected a heal entry for the original path 'alpha.ts'");
    assert.equal(
      entry!.newFilePath,
      "beta.ts",
      `Expected newFilePath to be 'beta.ts', got ${entry!.newFilePath}`,
    );
  });

  test("heal entry is marked changed when a cross-file move is detected", async () => {
    const result = await runHeal({ repoRoot: tmpDir, dryRun: true });
    const entry = result.entries.find((e) => e.filePath === "alpha.ts");
    assert.ok(entry, "Expected heal entry for alpha.ts");
    assert.equal(entry!.changed, true, "Cross-file move must mark the entry as changed");
  });

  test("formatHealResult includes file-moved annotation for cross-file moves", async () => {
    const result = await runHeal({ repoRoot: tmpDir, dryRun: true });
    const output = formatHealResult(result);
    assert.ok(
      output.includes("file moved") || output.includes("beta.ts"),
      "formatHealResult should indicate the cross-file move",
    );
  });

  test("persists new filePath to the context entry on disk when not a dry run", async () => {
    await runHeal({ repoRoot: tmpDir, dryRun: false });
    const persisted = await readContextEntry(tmpDir, entryId);
    assert.equal(
      persisted.filePath,
      "beta.ts",
      `Persisted filePath should be 'beta.ts', got '${persisted.filePath}'`,
    );
  });
});

// ─── runHeal – cross-file move via staged git rename ──────────────────────────

describe("runHeal – cross-file move detected from staged (uncommitted) git rename", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-heal-staged-"));
    await initGitRepo(tmpDir);

    await fs.writeFile(
      path.join(tmpDir, "service.ts"),
      "export const VERSION = '1.0';\n",
    );
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "service.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Version constant",
      source: "human",
    });
    await gitCommitAll(tmpDir, "initial");

    // Stage the rename without committing it.
    await execFileAsync("git", ["mv", "service.ts", "core-service.ts"], { cwd: tmpDir });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("heal detects staged rename and sets newFilePath", async () => {
    const result = await runHeal({ repoRoot: tmpDir });
    const entry = result.entries.find((e) => e.filePath === "service.ts");
    assert.ok(entry, "Expected a heal entry for the original path 'service.ts'");
    assert.equal(
      entry!.newFilePath,
      "core-service.ts",
      `Expected newFilePath to be 'core-service.ts', got ${entry!.newFilePath}`,
    );
  });
});

// ─── runHeal – missing file with no git history (graceful fallback) ────────────

describe("runHeal – missing file with no git history (graceful fallback)", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-heal-nohist-"));
    // No git init — git commands will fail gracefully.
    await fs.writeFile(
      path.join(tmpDir, "ephemeral.ts"),
      "export const X = 42;\n",
    );
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "ephemeral.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Will be deleted",
      source: "human",
    });
    // Delete the file so the entry becomes orphanable.
    await fs.rm(path.join(tmpDir, "ephemeral.ts"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("heal does not throw and newFilePath is undefined when no git history exists", async () => {
    const result = await runHeal({ repoRoot: tmpDir });
    assert.equal(result.failed, 0, "heal must not fail — it should degrade gracefully");
    assert.ok(result.entries.length > 0, "Entry should still be processed");
    const entry = result.entries[0];
    assert.equal(
      entry.newFilePath,
      undefined,
      "newFilePath must be absent when no git rename is detected",
    );
  });

  test("entry status is orphaned when the file is missing and no rename is found", async () => {
    const result = await runHeal({ repoRoot: tmpDir });
    assert.ok(result.entries.length > 0);
    const entry = result.entries[0];
    assert.equal(
      entry.after.status,
      "orphaned",
      `Expected status 'orphaned', got '${entry.after.status}'`,
    );
  });
});
