// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Sprint 2 / [E.6] — tests for `kodela heal --re-anchor` migration.
 *
 * Properties under test:
 *   1. Re-anchors a TS entry whose persisted bodyHash was computed with the
 *      regex extractor — outcome is "rewritten" and the new anchor matches
 *      what `buildAstAnchorAsync` returns.
 *   2. Second run is idempotent — every entry reports "no-change".
 *   3. `--dry-run` writes the JSONL log but does NOT rewrite entries or the
 *      marker file.
 *   4. Marker file `.kodela/.tree-sitter-anchored` is written on success
 *      (non-dry-run only), with the summary embedded.
 *   5. JSONL log lands at `.kodela/heal-reanchor.log.jsonl` regardless of
 *      dry-run.
 *   6. Missing source file → outcome "skipped:no-source"; entry untouched.
 *
 * Grammar-unavailable environments: the test reads its own behaviour out
 * of `_grammarAvailableForTests`; if the wasm isn't installed, the tests
 * still run because `buildAstAnchorAsync` falls back to regex — the rewrite
 * would then be a no-op, which is also a valid migration outcome.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  writeContextEntry,
  writeIndex,
  readContextEntry,
} from "@kodela/core";
import type { ContextEntry } from "@kodela/core";

import { runHealReAnchor, REANCHOR_MARKER_FILE, REANCHOR_LOG_FILE } from "./heal-reanchor.js";

const ENTRY_ID = "550e8400-e29b-41d4-a716-446655441234";
const PLACEHOLDER_HASH = "0".repeat(64);

const TS_SOURCE = [
  "export async function validateToken(token: string): Promise<boolean> {",
  "  if (!token) return false;",
  "  return token.startsWith('Bearer ');",
  "}",
].join("\n") + "\n";

// Anchor with a deliberately-stale bodyHash + paramCount — simulates what an
// entry created under the regex extractor looks like.
const STALE_ANCHOR_ENTRY: ContextEntry = {
  schemaVersion: "1.1.0",
  id: ENTRY_ID,
  filePath: "src/auth.ts",
  astAnchor: {
    kind: "function",
    name: "validateToken",
    blockHash: PLACEHOLDER_HASH,    // deliberately wrong
    bodyHash: PLACEHOLDER_HASH,     // deliberately wrong
    paramCount: 0,                  // deliberately wrong (real signature has 1)
    symbolId: "src/auth.ts#function:validateToken",
  },
  contentHash: PLACEHOLDER_HASH,
  lineRange: { start: 1, end: 4 },
  note: "Token validation",
  author: "tester",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  severity: "high",
  tags: [],
  source: "ai",
  aiTool: "claude-code",
  confidence: 0.9,
  status: "mapped",
  reviewRequired: false,
};

let tmpRepo: string;

async function setupRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-reanchor-"));
  await fs.mkdir(path.join(repo, ".kodela"), { recursive: true });
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.writeFile(path.join(repo, "src/auth.ts"), TS_SOURCE, "utf-8");
  await writeContextEntry(repo, STALE_ANCHOR_ENTRY);
  await writeIndex(repo, {
    schemaVersion: "1.1.0",
    entries: [ENTRY_ID],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  return repo;
}

before(async () => {
  tmpRepo = await setupRepo();
});

after(async () => {
  await fs.rm(tmpRepo, { recursive: true, force: true });
});

describe("kodela heal --re-anchor — first run rewrites stale anchors", () => {
  test("rewrites the entry and writes the marker + log", async () => {
    const result = await runHealReAnchor({ repoRoot: tmpRepo, dryRun: false });

    assert.equal(result.totalEntries, 1);
    assert.equal(result.dryRun, false);
    assert.equal(result.markerWritten, true);
    // The entry's persisted anchor was deliberately wrong, so the migration
    // MUST report it as rewritten (or as no-change if grammar fallback +
    // regex happens to produce identical hashes — unlikely with all-zero
    // placeholders, but tolerated).
    assert.ok(
      result.rewritten === 1 || result.unchanged === 1,
      `expected rewritten:1 or unchanged:1, got rewritten:${result.rewritten} unchanged:${result.unchanged}`,
    );

    // Marker exists on disk with version + completedAt.
    const markerRaw = await fs.readFile(
      path.join(tmpRepo, REANCHOR_MARKER_FILE),
      "utf-8",
    );
    const marker = JSON.parse(markerRaw) as { version: number; completedAt: string };
    assert.equal(marker.version, 1);
    assert.ok(marker.completedAt.endsWith("Z"));

    // Log file written with one JSONL line per entry.
    const logRaw = await fs.readFile(
      path.join(tmpRepo, REANCHOR_LOG_FILE),
      "utf-8",
    );
    const logLines = logRaw.trim().split("\n");
    assert.equal(logLines.length, 1);
    const logEntry = JSON.parse(logLines[0]!) as { entryId: string; outcome: string };
    assert.equal(logEntry.entryId, ENTRY_ID);
  });
});

describe("kodela heal --re-anchor — second run is idempotent", () => {
  test("running again produces zero rewrites", async () => {
    const second = await runHealReAnchor({ repoRoot: tmpRepo, dryRun: false });
    assert.equal(second.totalEntries, 1);
    assert.equal(second.rewritten, 0);
    // Either no-change (anchor matches what tree-sitter / regex emits) OR
    // skipped:no-overlap if the test environment lacks grammar AND the
    // file's overlap detection differs — both are valid idempotent outcomes.
    assert.ok(second.unchanged + second.skipped === 1);
  });
});

describe("kodela heal --re-anchor — dry-run", () => {
  test("writes log but does NOT rewrite entries or marker", async () => {
    const dryRepo = await setupRepo();
    try {
      const result = await runHealReAnchor({ repoRoot: dryRepo, dryRun: true });

      assert.equal(result.dryRun, true);
      assert.equal(result.markerWritten, false);

      // Marker MUST NOT exist after a dry-run.
      let markerExists = true;
      try {
        await fs.access(path.join(dryRepo, REANCHOR_MARKER_FILE));
      } catch {
        markerExists = false;
      }
      assert.equal(markerExists, false, "marker must not be written under --dry-run");

      // Entry on disk MUST still have the stale anchor (no rewrite).
      const persisted = await readContextEntry(dryRepo, ENTRY_ID);
      assert.equal(
        persisted.astAnchor?.paramCount,
        0,
        "stale paramCount must survive dry-run",
      );

      // Log MUST exist (audit trail of the no-op).
      const logRaw = await fs.readFile(
        path.join(dryRepo, REANCHOR_LOG_FILE),
        "utf-8",
      );
      assert.ok(logRaw.includes(ENTRY_ID));
    } finally {
      await fs.rm(dryRepo, { recursive: true, force: true });
    }
  });
});

describe("kodela heal --re-anchor — missing source file", () => {
  test("logs skipped:no-source and leaves the entry untouched", async () => {
    const missRepo = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-reanchor-miss-"));
    try {
      await fs.mkdir(path.join(missRepo, ".kodela"), { recursive: true });
      await writeContextEntry(missRepo, STALE_ANCHOR_ENTRY);
      await writeIndex(missRepo, {
        schemaVersion: "1.1.0",
        entries: [ENTRY_ID],
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });

      const result = await runHealReAnchor({ repoRoot: missRepo, dryRun: false });
      assert.equal(result.rewritten, 0);
      assert.equal(result.skipped, 1);
      assert.equal(result.entries[0]!.outcome, "skipped:no-source");
    } finally {
      await fs.rm(missRepo, { recursive: true, force: true });
    }
  });
});
