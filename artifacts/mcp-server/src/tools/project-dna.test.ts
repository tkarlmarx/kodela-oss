// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Tests for Project DNA (Phase 3).
 *
 * The headline assertion is the GATE KERNEL: seed a repo with a decision that
 * REJECTS a technology, then assert kodela_get_project_dna actually surfaces it
 * in `rejected_alternatives`. That proves the DNA carries the signal an agent
 * needs to avoid the rejected tech (the testable core of the ≥90% gate) — the
 * full two-arm behavioral benchmark is deferred QA.
 *
 * Also covers the doc 06 §13 integrity gate (a seeded claim that names a
 * rejected alternative is dropped + warned) and deterministic confidence.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import {
  openIndex,
  upsertEntry,
  writeContextEntry,
  type EntryRow,
  type ContextEntry,
} from "@kodela/core";
import { ensureDecisionTables } from "../lib/decisions-store.js";
import { ensureGraphTables } from "../lib/graph-store.js";
import { recordDecision } from "./record-decision.js";
import { getProjectDnaForMcp, type GetProjectDnaToolInput } from "./get-project-dna.js";
import { getRisksForMcp } from "./get-risks.js";

let tmpRepo: string;
let db: DatabaseSync;

const DNA_INPUT: GetProjectDnaToolInput = {
  scope: "project",
  token_budget: 5000,
  include_decisions: true,
  include_recent_incidents: false,
};

async function seedDecisions(repoRoot: string, handle: DatabaseSync): Promise<void> {
  const r = recordDecision(
    repoRoot,
    {
      title: "Stay on Postgres + SQLite — reject MongoDB",
      category: "architecture",
      problem: "We need a primary datastore that powers both local dev and the dashboard without operational sprawl.",
      decision: "Use Postgres (cloud) + SQLite (local) as the storage layer; do not add MongoDB.",
      reason: "A second datastore adds operational overhead and makes the dashboard's relational queries harder; Postgres+SQLite already covers the access patterns.",
      options: [
        { label: "Postgres + SQLite", description: "Relational, one engine family", was_chosen: true },
        { label: "MongoDB", description: "Document store", was_chosen: false, rejection_reason: "Operational overhead of a second datastore; harder to power the relational dashboard." },
      ],
      author_id: "eng@example.com",
      approver_ids: ["lead@example.com"],
      tags: ["storage"],
      visibility: "public-to-org",
      decided_at: "2026-05-01T00:00:00.000Z",
      initial_links: [],
    },
    handle,
  );
  assert.equal(r.ok, true, `record failed: ${r.error}`);
}

before(async () => {
  tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-dna-test-"));
  await fs.mkdir(path.join(tmpRepo, ".kodela"), { recursive: true });
  db = openIndex(path.join(tmpRepo, ".kodela", "index.db"));
  ensureDecisionTables(db);
  ensureGraphTables(db);
  await seedDecisions(tmpRepo, db);
});

after(async () => {
  db.close();
  await fs.rm(tmpRepo, { recursive: true, force: true });
});

describe("get_project_dna — the rejected-tech gate kernel", () => {
  test("surfaces a rejected technology (MongoDB) from a real decision", () => {
    const r = getProjectDnaForMcp(tmpRepo, DNA_INPUT, db);
    assert.equal(r.ok, true, `dna failed: ${r.error}`);
    const alts = r.dna!.payload.rejected_alternatives as Array<{ label: string; reason: string | null; decisions: string[] }>;
    const mongo = alts.find((a) => a.label.toLowerCase() === "mongodb");
    assert.ok(mongo, `expected MongoDB in rejected_alternatives: ${JSON.stringify(alts)}`);
    assert.ok((mongo!.reason ?? "").toLowerCase().includes("operational overhead"));
    assert.ok(mongo!.decisions.length >= 1, "rejected alt must cite the deciding decision");
  });

  test("pocket tier (token_budget ≤ 2048) still carries rejected_alternatives", () => {
    const r = getProjectDnaForMcp(tmpRepo, { ...DNA_INPUT, token_budget: 2000 }, db);
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.dna!.payload.rejected_alternatives));
    // Pocket omits the heavier technical block.
    assert.equal(r.dna!.payload.technical, undefined);
  });

  test("standard tier adds the technical block + active decisions", () => {
    const r = getProjectDnaForMcp(tmpRepo, { ...DNA_INPUT, token_budget: 5000 }, db);
    assert.equal(r.ok, true);
    assert.ok(r.dna!.payload.technical, "standard tier must include technical");
    assert.ok(Array.isArray(r.dna!.payload.active_decisions));
  });
});

describe("get_project_dna — §13 integrity gate (no self-contradiction)", () => {
  test("a seeded stack item that names a rejected alternative is dropped + warned", async () => {
    // Seed a Business DNA that wrongly lists MongoDB in the stack.
    await fs.mkdir(path.join(tmpRepo, ".kodela", "dna"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRepo, ".kodela", "dna", "project.json"),
      JSON.stringify({
        project: "TestProj",
        purpose: "Test project for DNA contradiction handling.",
        stack: ["Postgres", "MongoDB", "TypeScript"],
        non_goals: [],
        key_constraints: ["Use MongoDB for flexible docs"],
      }),
      "utf8",
    );

    const r = getProjectDnaForMcp(tmpRepo, DNA_INPUT, db);
    assert.equal(r.ok, true);
    const stack = r.dna!.payload.stack as string[];
    assert.ok(!stack.some((s) => s.toLowerCase() === "mongodb"), "contradicted stack item must be dropped");
    assert.ok(stack.some((s) => s.toLowerCase() === "postgres"), "non-contradicted items remain");
    const kc = r.dna!.payload.key_constraints as string[];
    assert.ok(!kc.some((c) => /mongodb/i.test(c)), "contradicted constraint must be dropped");
    const warnings = r.dna!.meta.warnings ?? [];
    assert.ok(warnings.some((w) => /MongoDB/i.test(w) && /omitted/i.test(w)), `expected a contradiction warning: ${JSON.stringify(warnings)}`);
    // With a seed + active decision + rejected alt, confidence is high.
    assert.ok(r.dna!.meta.confidence >= 0.6, `expected confidence ≥ 0.6, got ${r.dna!.meta.confidence}`);
  });
});

describe("get_risks — surfaces high-severity entries + security decisions", () => {
  test("a high-severity entry and a security decision both appear as risks", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-risks-"));
    await fs.mkdir(path.join(repo, ".kodela"), { recursive: true });
    const rdb = openIndex(path.join(repo, ".kodela", "index.db"));
    ensureDecisionTables(rdb);
    ensureGraphTables(rdb);
    try {
      // A critical-severity entry on a sensitive file (written to disk + index).
      const now = "2026-02-01T00:00:00.000Z";
      const entry: ContextEntry = {
        schemaVersion: "1.1.0",
        id: "33333333-3333-4333-8333-333333333333",
        filePath: "src/auth/token.ts",
        astAnchor: { kind: "function", name: "verify", blockHash: "abc" },
        contentHash: "h1",
        lineRange: { start: 1, end: 20 },
        note: "Reworked token verification.",
        author: "tester",
        createdAt: now,
        updatedAt: now,
        severity: "critical",
        tags: ["security", "tech-debt"],
        source: "ai",
        confidence: 0.8,
        status: "mapped",
        reviewRequired: true,
      };
      await writeContextEntry(repo, entry);
      const row: EntryRow = {
        id: entry.id, filePath: entry.filePath, schemaVersion: entry.schemaVersion,
        status: entry.status, severity: entry.severity, source: entry.source,
        confidence: entry.confidence, scope: null, sessionId: null, clusterId: null,
        reviewRequired: entry.reviewRequired, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
      };
      upsertEntry(rdb, row);

      // A security decision.
      const dec = recordDecision(
        repo,
        {
          title: "Rotate refresh tokens on every use",
          category: "security",
          problem: "Long-lived refresh tokens are a replay risk if exfiltrated from a client.",
          decision: "Rotate the refresh token on every refresh and invalidate the prior one.",
          reason: "Token rotation bounds the blast radius of a stolen refresh token to a single use window.",
          options: [
            { label: "Rotate on use", description: "New token each refresh", was_chosen: true },
            { label: "Static long-lived", description: "Keep one token", was_chosen: false, rejection_reason: "Replayable if stolen." },
          ],
          author_id: "sec@example.com",
          approver_ids: ["lead@example.com"],
          tags: ["auth"],
          visibility: "public-to-org",
          decided_at: "2026-02-02T00:00:00.000Z",
          initial_links: [],
        },
        rdb,
      );
      assert.equal(dec.ok, true, `record failed: ${dec.error}`);

      const r = await getRisksForMcp(repo, { include_tech_debt: true }, rdb);
      assert.equal(r.ok, true, `risks failed: ${r.error}`);
      const fileRisk = r.risks!.find((x) => x.id === "file:src/auth/token.ts");
      assert.ok(fileRisk, `expected the critical entry as a risk: ${JSON.stringify(r.risks)}`);
      assert.equal(fileRisk!.severity, "critical");
      assert.equal(fileRisk!.kind, "tech_debt", "tagged tech-debt → tech_debt kind");
      const secRisk = r.risks!.find((x) => x.kind === "open_risk" && x.title.includes("Rotate refresh tokens"));
      assert.ok(secRisk, "expected the security decision as an open_risk");
      assert.equal(secRisk!.linked_decisions.length, 1);

      // severity_min filters out everything below 'critical' here (decision is 'high').
      const critOnly = await getRisksForMcp(repo, { severity_min: "critical", include_tech_debt: true }, rdb);
      assert.ok(critOnly.risks!.every((x) => x.severity === "critical"));
    } finally {
      rdb.close();
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("get_project_dna — confidence reflects data backing", () => {
  test("empty repo (no seed, no decisions) → low confidence + warnings", async () => {
    const repo2 = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-dna-empty-"));
    await fs.mkdir(path.join(repo2, ".kodela"), { recursive: true });
    const db2 = openIndex(path.join(repo2, ".kodela", "index.db"));
    ensureDecisionTables(db2);
    ensureGraphTables(db2);
    try {
      const r = getProjectDnaForMcp(repo2, DNA_INPUT, db2);
      assert.equal(r.ok, true);
      assert.ok(r.dna!.meta.confidence < 0.6, `expected low confidence, got ${r.dna!.meta.confidence}`);
      const warnings = r.dna!.meta.warnings ?? [];
      assert.ok(warnings.some((w) => /seed/i.test(w)), "expected a no-seed warning");
      assert.ok(warnings.some((w) => /low-confidence/i.test(w)), "expected a low-confidence warning");
    } finally {
      db2.close();
      await fs.rm(repo2, { recursive: true, force: true });
    }
  });
});
