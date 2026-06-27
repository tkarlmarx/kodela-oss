// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { runInit, runAdd } from "@kodela/cli";
import { runNudge, formatNudgeResult } from "./nudge.js";

// ---------------------------------------------------------------------------
// Integration: runNudge against a real temp repo
// ---------------------------------------------------------------------------

describe("runNudge — integration", () => {
  let tmpDir: string;

  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns clean result for fresh repo", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-nudge-"));
    await runInit(tmpDir);
    const result = await runNudge({ repoRoot: tmpDir });
    assert.ok(!result.needsAttention, "fresh repo should have no items needing attention");
    assert.equal(result.orphaned.length, 0);
    assert.equal(result.uncertain.length, 0);
    assert.equal(result.reviewRequired.length, 0);
  });

  test("detects orphaned entries", async () => {
    await runAdd({
      repoRoot: tmpDir,
      filePath: "src/ghost.ts",
      lineStart: 1,
      lineEnd: 10,
      note: "Legacy middleware — may be orphaned",
      severity: "medium",
      source: "human",
      tags: [],
    });
    // Manually set the entry to orphaned status
    const objectsDir = path.join(tmpDir, ".kodela", "objects");
    const objectFiles = await fs.readdir(objectsDir);
    const entryPath = path.join(objectsDir, objectFiles[0]);
    const raw = JSON.parse(await fs.readFile(entryPath, "utf-8")) as { status: string };
    raw.status = "orphaned";
    await fs.writeFile(entryPath, JSON.stringify(raw));

    const result = await runNudge({ repoRoot: tmpDir });
    assert.ok(result.needsAttention, "should detect orphaned entry");
    assert.equal(result.orphaned.length, 1);
    assert.equal(result.uncertain.length, 0);
  });

  test("detects uncertain entries (separate from orphaned)", async () => {
    await runAdd({
      repoRoot: tmpDir,
      filePath: "src/uncertain.ts",
      lineStart: 1,
      lineEnd: 5,
      note: "Uncertain — line drift detected",
      severity: "low",
      source: "human",
      tags: [],
    });
    // Set the new entry to uncertain status
    const objectsDir = path.join(tmpDir, ".kodela", "objects");
    const objectFiles = await fs.readdir(objectsDir);
    // Find the entry that is currently mapped (not the orphaned one)
    for (const f of objectFiles) {
      const p = path.join(objectsDir, f);
      const raw = JSON.parse(await fs.readFile(p, "utf-8")) as { status: string; filePath: string };
      if (raw.filePath === "src/uncertain.ts") {
        raw.status = "uncertain";
        await fs.writeFile(p, JSON.stringify(raw));
        break;
      }
    }

    const result = await runNudge({ repoRoot: tmpDir });
    assert.ok(result.needsAttention);
    assert.equal(result.orphaned.length, 1);
    assert.equal(result.uncertain.length, 1);
  });

  test("detects reviewRequired entries", async () => {
    await runAdd({
      repoRoot: tmpDir,
      filePath: "src/review.ts",
      lineStart: 1,
      lineEnd: 5,
      note: "Needs explicit review before merge",
      severity: "high",
      source: "ai",
      tags: [],
    });
    // Set reviewRequired on the new entry
    const objectsDir = path.join(tmpDir, ".kodela", "objects");
    const objectFiles = await fs.readdir(objectsDir);
    for (const f of objectFiles) {
      const p = path.join(objectsDir, f);
      const raw = JSON.parse(await fs.readFile(p, "utf-8")) as {
        reviewRequired: boolean;
        filePath: string;
        status: string;
      };
      if (raw.filePath === "src/review.ts") {
        raw.reviewRequired = true;
        raw.status = "mapped";
        await fs.writeFile(p, JSON.stringify(raw));
        break;
      }
    }

    const result = await runNudge({ repoRoot: tmpDir });
    assert.ok(result.reviewRequired.length >= 1, "should find at least one reviewRequired entry");
  });
});

// ---------------------------------------------------------------------------
// formatNudgeResult — unit tests (pure)
// ---------------------------------------------------------------------------

describe("formatNudgeResult — clean", () => {
  const cleanResult = {
    orphaned: [],
    uncertain: [],
    reviewRequired: [],
    needsAttention: false,
  };

  test("comment format shows ✅ when clean", () => {
    const out = formatNudgeResult(cleanResult, "comment");
    assert.ok(out.includes("✅") || out.toLowerCase().includes("passed"), `got: ${out}`);
  });

  test("text format shows 'nothing to nudge' when clean", () => {
    const out = formatNudgeResult(cleanResult, "text");
    assert.ok(out.toLowerCase().includes("nothing"), `got: ${out}`);
  });

  test("json format shows needsAttention: false when clean", () => {
    const out = formatNudgeResult(cleanResult, "json");
    const parsed = JSON.parse(out) as { needsAttention: boolean };
    assert.equal(parsed.needsAttention, false);
  });
});

describe("formatNudgeResult — with items", () => {
  const HASH = "a".repeat(64);
  const orphanedEntry = {
    schemaVersion: "1.1.0" as const,
    id: "aaa",
    filePath: "src/login.ts",
    astAnchor: null,
    contentHash: HASH,
    lineRange: { start: 10, end: 20 },
    note: "Orphaned auth middleware",
    author: "alice",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    severity: "medium" as const,
    tags: [],
    source: "human" as const,
    confidence: 0.9,
    status: "orphaned" as const,
    reviewRequired: false,
  };

  const needsResult = {
    orphaned: [orphanedEntry],
    uncertain: [],
    reviewRequired: [],
    needsAttention: true,
  };

  test("comment format includes file path and note", () => {
    const out = formatNudgeResult(needsResult, "comment");
    assert.ok(out.includes("src/login.ts"), `file path should appear; got: ${out}`);
    assert.ok(out.includes("Orphaned auth middleware"), `note should appear; got: ${out}`);
  });

  test("json format includes orphaned entry details", () => {
    const out = formatNudgeResult(needsResult, "json");
    const parsed = JSON.parse(out) as {
      needsAttention: boolean;
      orphaned: { filePath: string }[];
    };
    assert.equal(parsed.needsAttention, true);
    assert.equal(parsed.orphaned[0].filePath, "src/login.ts");
  });

  test("text format includes ✗ orphaned section", () => {
    const out = formatNudgeResult(needsResult, "text");
    assert.ok(out.includes("✗") || out.toLowerCase().includes("orphaned"), `got: ${out}`);
    assert.ok(out.includes("src/login.ts"));
  });
});
