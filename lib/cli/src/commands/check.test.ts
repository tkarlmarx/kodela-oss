// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runCheck, formatCheckResult, loadLocalDecisions } from "./check.js";

/**
 * Seeds a temp `.kodela/index.db` with a decisions table and exercises the CLI
 * command's real SQLite reader + engine wiring (the pure engine itself is
 * covered by lib/core/src/contradiction/contradiction.test.ts).
 */
let repoRoot: string;

function seed(rows: Array<Record<string, unknown>>): void {
  const dir = path.join(repoRoot, ".kodela");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "index.db"));
  db.exec(
    `CREATE TABLE decisions (
       id TEXT PRIMARY KEY, title TEXT, status TEXT,
       problem TEXT, decision TEXT, reason TEXT, supersedes TEXT
     )`,
  );
  const stmt = db.prepare(
    "INSERT INTO decisions (id,title,status,problem,decision,reason,supersedes) VALUES (?,?,?,?,?,?,?)",
  );
  for (const r of rows) {
    stmt.run(
      r.id as string,
      r.title as string,
      r.status as string,
      (r.problem as string) ?? "",
      (r.decision as string) ?? "",
      (r.reason as string) ?? "",
      JSON.stringify(r.supersedes ?? []),
    );
  }
  db.close();
}

before(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kodela-check-"));
});
after(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe("runCheck", () => {
  test("returns 'no decisions' when the store is empty/absent", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "kodela-empty-"));
    const result = await runCheck({ repoRoot: empty, change: "reintroduce mongodb" });
    assert.equal(result.decisionsChecked, 0);
    assert.equal(result.violationCount, 0);
    assert.match(formatCheckResult(result), /No decisions recorded yet/);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  test("flags a described change that reverses an active decision", async () => {
    seed([
      {
        id: "DEC-1",
        title: "Reject MongoDB for the memory store",
        status: "active",
        decision: "Do not use MongoDB; standardize on Postgres.",
        reason: "We reject MongoDB to avoid a second datastore.",
      },
    ]);
    const result = await runCheck({ repoRoot, change: "Reintroduce MongoDB as the caching layer." });
    assert.equal(result.mode, "change");
    assert.equal(result.decisionsChecked, 1);
    assert.ok(result.violationCount > 0, "expected a violation");
    assert.ok(result.flags!.some((f) => f.decisionId === "DEC-1" && f.entity === "MongoDB"));
    assert.match(formatCheckResult(result), /decision violation/);
  });

  test("does not flag a benign change that merely mentions the tech", async () => {
    const result = await runCheck({ repoRoot, change: "Improve the Postgres connection pool timeout." });
    assert.equal(result.violationCount, 0);
    assert.match(formatCheckResult(result), /No contradiction/);
  });

  test("loadLocalDecisions parses supersedes JSON and status", async () => {
    const decisions = await loadLocalDecisions(repoRoot);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.status, "active");
    assert.deepEqual(decisions[0]!.supersedes, []);
  });

  test("scan mode flags a proposed decision that conflicts with an active one", async () => {
    // Re-seed with an active reject + a proposed re-adopt of the same entity.
    fs.rmSync(path.join(repoRoot, ".kodela"), { recursive: true, force: true });
    seed([
      {
        id: "DEC-1",
        title: "Reject MongoDB for the memory store",
        status: "active",
        decision: "Do not use MongoDB.",
        reason: "We reject MongoDB.",
      },
      {
        id: "DEC-2",
        title: "Adopt MongoDB for caching",
        status: "proposed",
        decision: "Reintroduce MongoDB as the cache.",
        reason: "Adopt MongoDB to speed up recall.",
      },
    ]);
    const result = await runCheck({ repoRoot });
    assert.equal(result.mode, "scan");
    assert.ok(result.scanned!.some((s) => s.decision.id === "DEC-2"), "expected DEC-2 flagged");
    assert.ok(result.violationCount > 0);
  });
});
