// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runGovernance, formatGovernance } from "./governance.js";

let repoRoot: string;

function seed(): void {
  const dir = path.join(repoRoot, ".kodela");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "index.db"));
  db.exec(
    `CREATE TABLE decisions (id TEXT PRIMARY KEY, title TEXT, status TEXT, problem TEXT, decision TEXT, reason TEXT, supersedes TEXT);
     CREATE TABLE entries (id TEXT PRIMARY KEY, file_path TEXT, status TEXT, source TEXT, session_id TEXT);`,
  );
  db.prepare("INSERT INTO decisions VALUES (?,?,?,?,?,?,?)").run(
    "DEC-1", "Reject MongoDB", "active", "", "Do not use MongoDB.", "We reject MongoDB.", "[]",
  );
  db.prepare("INSERT INTO decisions VALUES (?,?,?,?,?,?,?)").run(
    "DEC-2", "Re-adopt MongoDB", "proposed", "", "Reintroduce MongoDB.", "Adopt MongoDB.", "[]",
  );
  const e = db.prepare("INSERT INTO entries VALUES (?,?,?,?,?)");
  e.run("e1", "a.ts", "mapped", "ai", "s1"); // AI + intent
  e.run("e2", "b.ts", "unmapped", "ai", null); // AI, no intent
  e.run("e3", "c.ts", "mapped", "human", "s1"); // human
  db.close();
}

before(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kodela-gov-"));
  seed();
});
after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

describe("runGovernance", () => {
  test("computes the scorecard from the local store", async () => {
    const { scorecard, hasStore } = await runGovernance({ repoRoot });
    assert.equal(hasStore, true);
    assert.equal(scorecard.decisions.total, 2);
    assert.equal(scorecard.decisions.active, 1);
    assert.equal(scorecard.proposedConflicts, 1, "DEC-2 reverses active DEC-1");
    assert.equal(scorecard.aiChanges, 2);
    assert.equal(scorecard.aiChangesWithIntent, 1);
    assert.equal(scorecard.intentCoveragePct, 50);
  });

  test("formats a human scorecard", async () => {
    const result = await runGovernance({ repoRoot });
    const out = formatGovernance(result);
    assert.match(out, /Governance score/);
    assert.match(out, /Proposed conflicts\s+1/);
    assert.match(out, /captured intent/);
  });

  test("empty store reports nothing to govern", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "kodela-gov-empty-"));
    const result = await runGovernance({ repoRoot: empty });
    assert.equal(result.hasStore, false);
    assert.match(formatGovernance(result), /nothing to govern/);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
