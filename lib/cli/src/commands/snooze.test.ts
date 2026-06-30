// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { runInit, runAdd } from "@kodela/cli";
import { runSnooze, formatSnoozeResult } from "./snooze.js";
import { readContextEntry } from "@kodela/core";

// ---------------------------------------------------------------------------
// Integration: runSnooze against a real temp repo
// ---------------------------------------------------------------------------

describe("runSnooze", () => {
  let tmpDir: string;
  let entryId: string;

  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("setup: create a temp repo and add one entry", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-snooze-"));
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "src/auth.ts",
      lineStart: 1,
      lineEnd: 10,
      note: "Legacy session middleware — needs review",
      severity: "medium",
      source: "human",
      tags: [],
    });
    // Read the entry ID from the index
    const indexPath = path.join(tmpDir, ".kodela", "index.json");
    const index = JSON.parse(await fs.readFile(indexPath, "utf-8")) as { entries: string[] };
    assert.ok(index.entries.length === 1, "one entry should exist");
    entryId = index.entries[0];
  });

  test("snozes entry for default 7 days", async () => {
    const nowMs = Date.now();
    const result = await runSnooze({ repoRoot: tmpDir, entryId, now: nowMs });
    assert.equal(result.action, "snoozed");
    assert.ok(result.snoozedUntil, "snoozedUntil should be set");

    const snoozedTs = new Date(result.snoozedUntil!).getTime();
    const expectedTs = nowMs + 7 * 24 * 60 * 60 * 1000;
    // Allow ±1 second tolerance
    assert.ok(
      Math.abs(snoozedTs - expectedTs) < 1000,
      `snoozedUntil should be ~7 days from now; got ${result.snoozedUntil}`,
    );

    // Verify it was persisted
    const entry = await readContextEntry(tmpDir, entryId);
    assert.ok(entry.snoozedUntil, "snoozedUntil should be persisted on the entry");
  });

  test("snoozes entry for custom number of days", async () => {
    const nowMs = Date.now();
    const result = await runSnooze({ repoRoot: tmpDir, entryId, days: 30, now: nowMs });
    assert.equal(result.action, "snoozed");
    const snoozedTs = new Date(result.snoozedUntil!).getTime();
    const expectedTs = nowMs + 30 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(snoozedTs - expectedTs) < 1000);
  });

  test("clears snooze", async () => {
    const result = await runSnooze({ repoRoot: tmpDir, entryId, clear: true });
    assert.equal(result.action, "cleared");
    assert.equal(result.snoozedUntil, undefined);

    // Verify it was cleared in storage
    const entry = await readContextEntry(tmpDir, entryId);
    assert.equal(entry.snoozedUntil, undefined, "snoozedUntil should be absent after clear");
  });

  test("throws for unknown entry ID", async () => {
    await assert.rejects(
      () => runSnooze({ repoRoot: tmpDir, entryId: "00000000-0000-0000-0000-000000000000" }),
      /not found/i,
    );
  });
});

// ---------------------------------------------------------------------------
// formatSnoozeResult
// ---------------------------------------------------------------------------

describe("formatSnoozeResult", () => {
  test("shows cleared message", () => {
    const msg = formatSnoozeResult({ entryId: "abc-123", action: "cleared" });
    assert.ok(msg.toLowerCase().includes("cleared"), `got: ${msg}`);
    assert.ok(msg.includes("abc-123"));
  });

  test("shows snoozed until date", () => {
    const until = "2024-08-01T00:00:00.000Z";
    const msg = formatSnoozeResult({ entryId: "abc-123", action: "snoozed", snoozedUntil: until });
    assert.ok(msg.toLowerCase().includes("snoozed"), `got: ${msg}`);
    assert.ok(msg.includes("abc-123"));
    assert.ok(msg.includes("2024"), `date year should appear in message; got: ${msg}`);
  });
});
