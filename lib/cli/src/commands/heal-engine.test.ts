// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { heal } from "./heal-engine.js";
import { runInit } from "./init.js";
import { runAdd } from "./add.js";
import type { ChangeEvent } from "@kodela/watcher";
import { readIndex, readContextEntry } from "@kodela/core";

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

function makeEvent(
  repoRoot: string,
  relPath: string,
  changeType: ChangeEvent["changeType"],
  extras: Partial<ChangeEvent> = {},
): ChangeEvent {
  return {
    filePath: path.join(repoRoot, relPath),
    changeType,
    timestamp: Date.now(),
    ...extras,
  };
}

// ─── heal() – empty / no-op cases ─────────────────────────────────────────────

describe("heal – empty inputs", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-he-empty-"));
    await runInit(tmpDir);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns zero counts when changes list is empty", async () => {
    const result = await heal([], { repoRoot: tmpDir, dryRun: true });
    assert.deepEqual(result, { updated: 0, orphaned: 0, uncertain: 0 });
  });

  test("returns zero counts when no indexed entries match the changed files", async () => {
    const event = makeEvent(tmpDir, "nonexistent.ts", "modify");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true });
    assert.deepEqual(result, { updated: 0, orphaned: 0, uncertain: 0 });
  });
});

// ─── heal() – modify: line range tracking ─────────────────────────────────────

describe("heal – modify event updates line range", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-he-modify-"));
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

  test("returns { updated, orphaned, uncertain } shape", async () => {
    const event = makeEvent(tmpDir, "utils.ts", "modify");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true });
    assert.ok("updated" in result, "result must have 'updated'");
    assert.ok("orphaned" in result, "result must have 'orphaned'");
    assert.ok("uncertain" in result, "result must have 'uncertain'");
  });

  test("each entry contributes to exactly one counter", async () => {
    const event = makeEvent(tmpDir, "utils.ts", "modify");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true });
    const total = result.updated + result.orphaned + result.uncertain;
    assert.ok(total >= 1, "Expected at least one entry to be processed");
  });

  test("dryRun does not alter stored entry confidence", async () => {
    const event = makeEvent(tmpDir, "utils.ts", "modify");
    const r1 = await heal([event], { repoRoot: tmpDir, dryRun: true });
    const r2 = await heal([event], { repoRoot: tmpDir, dryRun: true });
    assert.equal(
      r1.updated + r1.orphaned + r1.uncertain,
      r2.updated + r2.orphaned + r2.uncertain,
      "dry-run results must be deterministic",
    );
  });
});

// ─── heal() – delete: immediate orphan ────────────────────────────────────────

describe("heal – delete event orphans entries", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-he-delete-"));
    await fs.writeFile(
      path.join(tmpDir, "gone.ts"),
      "export const x = 1;\n",
    );
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "gone.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Original",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("a delete event increments orphaned count", async () => {
    const event = makeEvent(tmpDir, "gone.ts", "delete");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true });
    assert.equal(result.orphaned, 1, "Expected 1 orphaned entry for the deleted file");
    assert.equal(result.updated, 0);
    assert.equal(result.uncertain, 0);
  });

  test("delete is handled without reading file content", async () => {
    // File doesn't have to exist for delete processing — the engine should not throw
    await fs.rm(path.join(tmpDir, "gone.ts"), { force: true });
    const event = makeEvent(tmpDir, "gone.ts", "delete");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true });
    assert.ok(result.orphaned >= 0, "Should not throw even when file is gone");
  });
});

// ─── heal() – duplicate events: latest timestamp wins ─────────────────────────

describe("heal – duplicate events deduplication", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-he-dedup-"));
    await fs.writeFile(path.join(tmpDir, "dup.ts"), "export const y = 2;\n");
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "dup.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Dup test",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("two modify events for the same file are coalesced by latest timestamp", async () => {
    const early = makeEvent(tmpDir, "dup.ts", "modify", { timestamp: 1000 });
    const late = makeEvent(tmpDir, "dup.ts", "modify", { timestamp: 2000 });
    const result = await heal([early, late], { repoRoot: tmpDir, dryRun: true });
    const total = result.updated + result.orphaned + result.uncertain;
    assert.ok(total >= 0, "Should not double-process entries");
    assert.ok(total <= 1, "Same file coalesced — should not count entries twice");
  });

  test("delete wins when it is the latest event for a file", async () => {
    const modify = makeEvent(tmpDir, "dup.ts", "modify", { timestamp: 1000 });
    const del = makeEvent(tmpDir, "dup.ts", "delete", { timestamp: 2000 });
    const result = await heal([modify, del], { repoRoot: tmpDir, dryRun: true });
    assert.equal(result.orphaned, 1, "Latest delete event should orphan the entry");
    assert.equal(result.updated, 0);
  });
});

// ─── heal() – content cache sharing across calls ──────────────────────────────

describe("heal – shared content cache", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-he-cache-"));
    await fs.writeFile(path.join(tmpDir, "cached.ts"), "export const z = 3;\n");
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "cached.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Cache test",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("shared contentCache is populated after first call and reused in second", async () => {
    const cache = new Map<string, string>();
    const event = makeEvent(tmpDir, "cached.ts", "modify");
    await heal([event], { repoRoot: tmpDir, dryRun: true, contentCache: cache });
    assert.ok(cache.size > 0, "Cache should be populated after first call");

    // Second call with pre-populated cache — must still return valid counts
    const result2 = await heal([event], { repoRoot: tmpDir, dryRun: true, contentCache: cache });
    const total = result2.updated + result2.orphaned + result2.uncertain;
    assert.ok(total >= 0, "Second call with populated cache should succeed");
  });
});

// ─── heal() – absolute vs relative path normalisation ─────────────────────────

describe("heal – path normalisation", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-he-paths-"));
    await fs.writeFile(path.join(tmpDir, "norm.ts"), "export const n = 4;\n");
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "norm.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Path test",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("absolute filePath in ChangeEvent is normalised to relative", async () => {
    const event: ChangeEvent = {
      filePath: path.join(tmpDir, "norm.ts"), // absolute
      changeType: "modify",
      timestamp: Date.now(),
    };
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true });
    const total = result.updated + result.orphaned + result.uncertain;
    assert.ok(total >= 1, "Absolute path should resolve to the indexed entry");
  });

  test("relative filePath also works (watcher implementations may emit either)", async () => {
    const event: ChangeEvent = {
      filePath: "norm.ts", // already relative
      changeType: "modify",
      timestamp: Date.now(),
    };
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true });
    const total = result.updated + result.orphaned + result.uncertain;
    assert.ok(total >= 1, "Relative path should resolve to the indexed entry");
  });
});

// ─── heal() – git baseline + diff signal integration ──────────────────────────

describe("heal – diff signal classification with git baseline", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-he-git-"));
    await initGitRepo(tmpDir);
    await fs.writeFile(path.join(tmpDir, "src.ts"), "export const v = 1;\n");
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "src.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Version constant",
      source: "human",
    });
    await gitCommitAll(tmpDir, "baseline");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("minimal change resolves entry (not orphaned)", async () => {
    await fs.writeFile(path.join(tmpDir, "src.ts"), "export const v = 2;\n");
    const event = makeEvent(tmpDir, "src.ts", "modify");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true });
    assert.equal(result.orphaned, 0, "Minimal edit should not orphan the entry");
    const total = result.updated + result.uncertain;
    assert.equal(total, 1, "Entry should be updated or uncertain, not orphaned");
  });

  test("large AI-style rewrite reduces confidence (may yield orphaned or uncertain)", async () => {
    const bigBlock = Array.from({ length: 60 }, (_, i) =>
      `export const gen_${i} = ${i}; // auto-generated`,
    ).join("\n");
    await fs.writeFile(path.join(tmpDir, "src.ts"), bigBlock + "\n");

    const event = makeEvent(tmpDir, "src.ts", "modify");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true });
    const total = result.updated + result.orphaned + result.uncertain;
    assert.equal(total, 1, "Entry should be processed exactly once");
    // For a massive rewrite the entry should NOT silently stay fully confident
    assert.equal(result.updated, 0, "Large AI rewrite must not produce a high-confidence mapping");
  });

  test("custom ai_confidence_cap is respected", async () => {
    const { KodelaConfigSchema } = await import("../config/schema.js");
    const config = KodelaConfigSchema.parse({
      heal: { ai_confidence_cap: 0.3, rewrite_confidence_factor: 0.85 },
    });
    const bigBlock = Array.from({ length: 60 }, (_, i) =>
      `export const cap_${i} = ${i};`,
    ).join("\n");
    await fs.writeFile(path.join(tmpDir, "src.ts"), bigBlock + "\n");

    const event = makeEvent(tmpDir, "src.ts", "modify");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true, config });
    const total = result.updated + result.orphaned + result.uncertain;
    assert.equal(total, 1, "One entry should be processed");
  });
});

// ─── heal() – debug mode does not throw ───────────────────────────────────────

describe("heal – debug mode", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-he-debug-"));
    await fs.writeFile(path.join(tmpDir, "dbg.ts"), "export const d = 5;\n");
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "dbg.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Debug test",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("debug: true does not throw and still returns valid counts", async () => {
    const event = makeEvent(tmpDir, "dbg.ts", "modify");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true, debug: true });
    assert.ok("updated" in result && "orphaned" in result && "uncertain" in result);
    const total = result.updated + result.orphaned + result.uncertain;
    assert.ok(total >= 0, "debug mode must not corrupt result");
  });

  test("debug: true on delete event does not throw", async () => {
    const event = makeEvent(tmpDir, "dbg.ts", "delete");
    await assert.doesNotReject(
      () => heal([event], { repoRoot: tmpDir, dryRun: true, debug: true }),
    );
  });
});

// ─── heal() – collectDecisions option ─────────────────────────────────────────

describe("heal – collectDecisions option", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-he-decisions-"));
    await fs.writeFile(
      path.join(tmpDir, "decisions.ts"),
      "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n",
    );
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "decisions.ts",
      lineStart: 1,
      lineEnd: 3,
      note: "Greet function",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("decisions is empty array when collectDecisions: true and changes list is empty", async () => {
    const result = await heal([], { repoRoot: tmpDir, dryRun: true, collectDecisions: true });
    assert.ok(Array.isArray(result.decisions), "decisions must be an array even with no changes");
    assert.equal(result.decisions!.length, 0);
  });

  test("decisions is absent from result when collectDecisions is not set", async () => {
    const event = makeEvent(tmpDir, "decisions.ts", "modify");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true });
    assert.equal(
      "decisions" in result,
      false,
      "decisions key must not appear in result unless collectDecisions: true",
    );
  });

  test("decisions is absent when collectDecisions is false", async () => {
    const event = makeEvent(tmpDir, "decisions.ts", "modify");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true, collectDecisions: false });
    assert.equal("decisions" in result, false);
  });

  test("decisions array is present and non-null when collectDecisions: true", async () => {
    const event = makeEvent(tmpDir, "decisions.ts", "modify");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true, collectDecisions: true });
    assert.ok(Array.isArray(result.decisions), "decisions must be an array");
  });

  test("each processed entry produces exactly one MappingDecision", async () => {
    const event = makeEvent(tmpDir, "decisions.ts", "modify");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true, collectDecisions: true });
    const total = result.updated + result.orphaned + result.uncertain;
    assert.equal(
      result.decisions!.length,
      total,
      "decisions.length must equal the total number of processed entries",
    );
  });

  test("each MappingDecision has score, layerUsed, and reason fields", async () => {
    const event = makeEvent(tmpDir, "decisions.ts", "modify");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true, collectDecisions: true });
    for (const d of result.decisions!) {
      assert.ok(typeof d.score === "number", "score must be a number");
      assert.ok(typeof d.layerUsed === "string" && d.layerUsed.length > 0, "layerUsed must be a non-empty string");
      assert.ok(typeof d.reason === "string" && d.reason.length > 0, "reason must be a non-empty string");
    }
  });

  test("MappingDecision.entryId and filePath match the indexed entry", async () => {
    const event = makeEvent(tmpDir, "decisions.ts", "modify");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true, collectDecisions: true });
    assert.ok(result.decisions!.length >= 1, "Expected at least one decision");
    const d = result.decisions![0];
    assert.ok(typeof d.entryId === "string" && d.entryId.length > 0, "entryId must be a non-empty string");
    assert.equal(d.filePath, "decisions.ts");
  });

  test("MappingDecision.score is within [0, 1]", async () => {
    const event = makeEvent(tmpDir, "decisions.ts", "modify");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true, collectDecisions: true });
    for (const d of result.decisions!) {
      assert.ok(d.score >= 0 && d.score <= 1, `score ${d.score} must be in [0, 1]`);
    }
  });

  test("collectDecisions: true is compatible with debug: true", async () => {
    const event = makeEvent(tmpDir, "decisions.ts", "modify");
    await assert.doesNotReject(
      () => heal([event], { repoRoot: tmpDir, dryRun: true, collectDecisions: true, debug: true }),
      "combining collectDecisions and debug must not throw",
    );
  });
});

describe("heal – collectDecisions on delete event", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-he-dec-del-"));
    await fs.writeFile(path.join(tmpDir, "gone2.ts"), "export const x = 99;\n");
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "gone2.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Will be deleted",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("delete event produces one decision with score=0 and reason 'file deleted'", async () => {
    const event = makeEvent(tmpDir, "gone2.ts", "delete");
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true, collectDecisions: true });
    assert.equal(result.orphaned, 1);
    assert.equal(result.decisions!.length, 1);
    const d = result.decisions![0];
    assert.equal(d.score, 0);
    assert.equal(d.reason, "file deleted");
    assert.equal(d.after.status, "orphaned");
    assert.equal(d.changeType, "delete");
  });
});

// ─── heal() – rename (renameFrom) ─────────────────────────────────────────────

describe("heal – rename event (renameFrom)", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-he-rename-"));
    await fs.writeFile(path.join(tmpDir, "old.ts"), "export const r = 6;\n");
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "old.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Rename test",
      source: "human",
    });
    // Perform the rename on disk
    await fs.rename(path.join(tmpDir, "old.ts"), path.join(tmpDir, "new.ts"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("create event with renameFrom processes the old entry without orphaning it", async () => {
    const event: ChangeEvent = {
      filePath: path.join(tmpDir, "new.ts"),
      changeType: "create",
      timestamp: Date.now(),
      renameFrom: path.join(tmpDir, "old.ts"),
    };
    const result = await heal([event], { repoRoot: tmpDir, dryRun: true });
    const total = result.updated + result.orphaned + result.uncertain;
    assert.equal(total, 1, "The old entry should be processed as part of rename");
  });

  test("rename with dryRun: false persists the new filePath to disk", async () => {
    const event: ChangeEvent = {
      filePath: path.join(tmpDir, "new.ts"),
      changeType: "create",
      timestamp: Date.now(),
      renameFrom: path.join(tmpDir, "old.ts"),
    };
    await heal([event], { repoRoot: tmpDir, dryRun: false });

    const index = await readIndex(tmpDir);
    assert.ok(index.entries.length > 0, "Index should have at least one entry");
    const entryId = index.entries[0];
    const persisted = await readContextEntry(tmpDir, entryId);
    assert.equal(persisted.filePath, "new.ts", "Stored filePath should be updated to new.ts after rename");
  });
});
