// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  formatRetroactiveResult,
  pickFilesFromCommit,
} from "./retroactive.js";
import type { RetroactiveResult } from "./retroactive.js";

// ─── formatRetroactiveResult ───────────────────────────────────────────────

describe("formatRetroactiveResult", () => {
  test("needsConfirmation: prints stub count and --yes hint", () => {
    const result: RetroactiveResult = {
      scanned: 50,
      flagged: 10,
      skipped: 0,
      created: 0,
      stubs: [],
      dryRun: false,
      needsConfirmation: true,
      pendingCount: 42,
    };
    const output = formatRetroactiveResult(result);
    assert.ok(output.includes("42"), "includes pending count");
    assert.ok(output.includes("--yes"), "mentions --yes flag");
    assert.ok(output.includes("Re-run"), "instructs user to re-run");
  });

  test("needsConfirmation: includes licenseWarning when present", () => {
    const result: RetroactiveResult = {
      scanned: 50,
      flagged: 10,
      skipped: 0,
      created: 0,
      stubs: [],
      dryRun: false,
      needsConfirmation: true,
      pendingCount: 25,
      licenseWarning: "retroactive_scan requires an Enterprise license.",
    };
    const output = formatRetroactiveResult(result);
    assert.ok(output.includes("Enterprise"), "includes license warning");
    assert.ok(output.includes("--yes"), "still shows --yes hint");
  });

  test("no flagged commits: prints 'No likely-AI commits found'", () => {
    const result: RetroactiveResult = {
      scanned: 20,
      flagged: 0,
      skipped: 0,
      created: 0,
      stubs: [],
      dryRun: false,
    };
    const output = formatRetroactiveResult(result);
    assert.ok(output.includes("No likely-AI commits"), "prints no-op message");
    assert.ok(output.includes("20"), "includes scanned count");
  });

  test("normal result: prints scanned, flagged, created, skipped counts", () => {
    const result: RetroactiveResult = {
      scanned: 30,
      flagged: 5,
      skipped: 2,
      created: 3,
      stubs: [
        { filePath: "src/auth.ts", commitSha: "abc123", entryId: "id-1" },
        { filePath: "src/api.ts", commitSha: "abc123", entryId: "id-2" },
        { filePath: "src/utils.ts", commitSha: "def456", entryId: "id-3" },
      ],
      dryRun: false,
    };
    const output = formatRetroactiveResult(result);
    assert.ok(output.includes("30"), "includes scanned count");
    assert.ok(output.includes("5"), "includes flagged count");
    assert.ok(output.includes("3"), "includes created count");
    assert.ok(output.includes("2"), "includes skipped count");
    assert.ok(output.includes("src/auth.ts"), "lists first stub file");
    assert.ok(output.includes("src/utils.ts"), "lists last stub file");
    assert.ok(output.includes("abc123"), "lists commit sha");
  });

  test("dry-run result: includes [DRY RUN] prefix", () => {
    const result: RetroactiveResult = {
      scanned: 10,
      flagged: 2,
      skipped: 0,
      created: 2,
      stubs: [
        { filePath: "src/a.ts", commitSha: "sha1", entryId: "e1" },
        { filePath: "src/b.ts", commitSha: "sha2", entryId: "e2" },
      ],
      dryRun: true,
    };
    const output = formatRetroactiveResult(result);
    assert.ok(output.includes("[DRY RUN]"), "includes DRY RUN prefix");
    assert.ok(output.includes("Run without --dry-run"), "includes dry-run hint");
  });

  test("dry-run: needsConfirmation is bypassed (dry-run always shows stubs)", () => {
    const result: RetroactiveResult = {
      scanned: 50,
      flagged: 10,
      skipped: 0,
      created: 25,
      stubs: Array.from({ length: 25 }, (_, i) => ({
        filePath: `src/file${i}.ts`,
        commitSha: "sha",
        entryId: `id-${i}`,
      })),
      dryRun: true,
    };
    const output = formatRetroactiveResult(result);
    assert.ok(!output.includes("--yes"), "dry-run does not show --yes hint");
    assert.ok(output.includes("[DRY RUN]"), "shows DRY RUN prefix");
  });
});

// ─── pickFilesFromCommit ────────────────────────────────────────────────────

describe("pickFilesFromCommit", () => {
  test("cross-commit dedup: same file appearing in two commits is queued only once", () => {
    const seenPaths = new Set<string>();
    const existingFiles = new Set<string>();
    const opts = { maxFilesPerCommit: 5, seenPaths, existingFiles, force: false };

    // Simulate commit A touching foo.ts and bar.ts
    const firstPick = pickFilesFromCommit(["src/foo.ts", "src/bar.ts"], opts);
    assert.deepEqual(firstPick, ["src/bar.ts", "src/foo.ts"], "first commit picks both files alphabetically");

    // Simulate commit B also touching foo.ts (plus a new file)
    const secondPick = pickFilesFromCommit(["src/foo.ts", "src/new.ts"], opts);
    assert.ok(!secondPick.includes("src/foo.ts"), "foo.ts is not queued again from second commit");
    assert.ok(secondPick.includes("src/new.ts"), "new.ts from second commit is queued");
  });

  test("sort before cap: per-commit cap always selects the alphabetically-first N files", () => {
    const seenPaths = new Set<string>();
    const existingFiles = new Set<string>();
    const opts = { maxFilesPerCommit: 2, seenPaths, existingFiles, force: false };

    // git might return files in any order; the cap should always take the first 2 alphabetically
    const files = ["src/z.ts", "src/a.ts", "src/m.ts", "src/b.ts"];
    const picked = pickFilesFromCommit(files, opts);

    assert.equal(picked.length, 2, "exactly 2 files picked (cap respected)");
    assert.deepEqual(picked, ["src/a.ts", "src/b.ts"], "picks the alphabetically-first two files");
  });
});
