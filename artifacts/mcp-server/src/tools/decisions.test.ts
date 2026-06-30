// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Smoke test for Decision Intelligence MVP.
 *
 * Verifies the end-to-end record → retrieve path on a temporary database.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { ensureDecisionTables } from "../lib/decisions-store.js";
import { ensureGraphTables } from "../lib/graph-store.js";
import { recordDecision } from "./record-decision.js";
import { getDecisionForMcp } from "./get-decision.js";
import { searchDecisionsForMcp } from "./search-decisions.js";
import { supersedeDecisionForMcp } from "./supersede-decision.js";
import { recordDecisionOutcomeForMcp } from "./record-decision-outcome.js";
import { queryForMcp } from "./query.js";

let tmpRepo: string;
let db: DatabaseSync;

before(async () => {
  tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-decisions-test-"));
  await fs.mkdir(path.join(tmpRepo, ".kodela"), { recursive: true });
  db = new DatabaseSync(path.join(tmpRepo, ".kodela", "index.db"));
  ensureDecisionTables(db);
  ensureGraphTables(db); // record_decision now emits graph edges in-txn
});

after(async () => {
  db.close();
  await fs.rm(tmpRepo, { recursive: true, force: true });
});

describe("kodela_record_decision (MVP)", () => {
  test("records a complete decision and assigns a sequential DEC-NNNN id", () => {
    const result = recordDecision(
      tmpRepo,
      {
        title: "Use Drizzle ORM over Prisma",
        category: "architecture",
        problem:
          "Need a TypeScript ORM that runs on both SQLite and Postgres without major rewrites.",
        decision:
          "Adopt Drizzle ORM for both the SqliteStorage and PostgresStorage adapters.",
        reason:
          "Drizzle's type inference, raw SQL escape hatch, and zero runtime dependency " +
          "footprint matched our SqliteStorage default better than Prisma's heavier client.",
        consequences:
          "Locked into Drizzle migration tooling; commits us to maintaining adapter parity.",
        trade_offs: "Less ecosystem tooling than Prisma; weaker GUI story.",
        options: [
          {
            label: "Drizzle ORM",
            description: "Type-safe ORM with raw SQL escape hatch.",
            pros: "Lightweight, both SQLite and Postgres, strong typing.",
            cons: "Smaller community; fewer integrations.",
            was_chosen: true,
          },
          {
            label: "Prisma",
            description: "Schema-first ORM with code generation.",
            pros: "Mature; strong tooling.",
            cons: "Heavier runtime; codegen step in monorepo.",
            was_chosen: false,
            rejection_reason:
              "Heavier client + codegen step incompatible with our build pipeline.",
          },
          {
            label: "Raw SQL only",
            description: "Hand-write parameterized SQL.",
            was_chosen: false,
            rejection_reason: "Type-safety regression.",
          },
        ],
        author_id: "praneeth@blash.uk",
        approver_ids: ["anjan.mukherjee@blash.uk"],
        tags: ["data-layer", "tooling"],
        visibility: "public-to-org",
        decided_at: new Date("2026-03-14T14:00:00Z").toISOString(),
        initial_links: [
          {
            link_type: "ticket",
            external_id: "PLAT-1287",
            display_label: "Pick an ORM for KodelaStorage",
          },
        ],
      },
      db,
    );

    assert.equal(result.ok, true, `record failed: ${result.error}`);
    assert.equal(result.decision_id, "DEC-0001");
    assert.equal(result.status, "active"); // approver_ids non-empty → active
    assert.ok(result.message?.includes("DEC-0001"));
  });

  test("persists a JSON copy to .kodela/decisions/", () => {
    const jsonPath = path.join(tmpRepo, ".kodela", "decisions", "DEC-0001.json");
    assert.ok(existsSync(jsonPath), `expected ${jsonPath} to exist`);
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    assert.equal(parsed.decision.id, "DEC-0001");
    assert.equal(parsed.options.length, 3);
    assert.equal(parsed.links.length, 1);
    assert.equal(parsed.links[0].external_id, "PLAT-1287");
  });

  test("rejects a decision with only one option", () => {
    const result = recordDecision(
      tmpRepo,
      {
        title: "Only one option",
        category: "operational",
        problem: "A decision must consider alternatives; one option is not enough.",
        decision: "We can only do this thing; nothing else exists.",
        reason:
          "Should be rejected by validation because we need to weigh against at least one alternative.",
        options: [
          {
            label: "Only option",
            description: "the only thing",
            was_chosen: true,
          },
        ],
        author_id: "test@example.com",
        decided_at: new Date().toISOString(),
        approver_ids: [],
        tags: [],
        visibility: "public-to-org",
        initial_links: [],
      },
      db,
    );

    assert.equal(result.ok, false);
    assert.ok(
      result.error?.includes("at least 2 options"),
      `unexpected error: ${result.error}`,
    );
  });

  test("rejects an option marked was_chosen=false without a rejection_reason", () => {
    const result = recordDecision(
      tmpRepo,
      {
        title: "Missing rejection_reason",
        category: "operational",
        problem: "Option without a rejection_reason should be rejected by validation.",
        decision: "Choose option A and reject B without saying why.",
        reason:
          "This test asserts that the validator catches the missing rejection_reason on B.",
        options: [
          {
            label: "A",
            description: "chosen one",
            was_chosen: true,
          },
          {
            label: "B",
            description: "rejected without explanation",
            was_chosen: false,
            // intentionally no rejection_reason
          },
        ],
        author_id: "test@example.com",
        decided_at: new Date().toISOString(),
        approver_ids: [],
        tags: [],
        visibility: "public-to-org",
        initial_links: [],
      },
      db,
    );

    assert.equal(result.ok, false);
    assert.ok(
      result.error?.includes("rejection_reason"),
      `unexpected error: ${result.error}`,
    );
  });

  test("assigns DEC-0002 on the second successful record", () => {
    const result = recordDecision(
      tmpRepo,
      {
        title: "Reject MongoDB for analytics workload",
        category: "architecture",
        problem:
          "We considered MongoDB for the analytics aggregation workload but had concerns " +
          "about join performance.",
        decision:
          "Stay on Postgres for analytics; do not adopt MongoDB anywhere in the stack.",
        reason:
          "Joins are central to our aggregation queries; MongoDB's lookup operator is " +
          "materially slower for our shape, and the operational overhead of a second " +
          "datastore outweighs the document-model ergonomics.",
        options: [
          {
            label: "Postgres",
            description: "stay on the existing primary.",
            was_chosen: true,
          },
          {
            label: "MongoDB",
            description: "document store.",
            was_chosen: false,
            rejection_reason:
              "Lookup join performance and operational overhead of two datastores.",
          },
        ],
        author_id: "praneeth@blash.uk",
        approver_ids: ["anjan.mukherjee@blash.uk"],
        decided_at: new Date("2024-11-02T10:00:00Z").toISOString(),
        tags: [],
        visibility: "public-to-org",
        initial_links: [],
      },
      db,
    );

    assert.equal(result.ok, true, `record failed: ${result.error}`);
    assert.equal(result.decision_id, "DEC-0002");
  });
});

describe("kodela_get_decision (MVP)", () => {
  test("retrieves a decision by id with options and links", () => {
    const result = getDecisionForMcp(tmpRepo, { decision_id: "DEC-0001" }, db);
    assert.equal(result.ok, true);
    assert.ok(result.decision);
    assert.equal(result.decision!.decision.id, "DEC-0001");
    assert.equal(result.decision!.decision.title, "Use Drizzle ORM over Prisma");
    assert.equal(result.decision!.decision.status, "active");
    assert.equal(result.decision!.options.length, 3);
    assert.equal(
      result.decision!.options.filter((o) => o.was_chosen).length,
      1,
    );
    assert.equal(result.decision!.links.length, 1);
    assert.equal(result.decision!.links[0].external_id, "PLAT-1287");
  });

  test("returns ok:false for a missing decision", () => {
    const result = getDecisionForMcp(tmpRepo, { decision_id: "DEC-9999" }, db);
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("not found"));
  });
});

describe("kodela_search_decisions (MVP)", () => {
  test("finds decisions by free-text query in reason", () => {
    const result = searchDecisionsForMcp(tmpRepo, { query: "Drizzle", limit: 25 }, db);
    assert.equal(result.ok, true);
    assert.ok(result.total! >= 1, `expected ≥1 match, got ${result.total}`);
    const titles = result.results!.map((r) => r.title);
    assert.ok(
      titles.some((t) => t.toLowerCase().includes("drizzle")),
      `expected a Drizzle title in: ${JSON.stringify(titles)}`,
    );
  });

  test("filters by category", () => {
    const result = searchDecisionsForMcp(tmpRepo, { category: "architecture", limit: 25 }, db);
    assert.equal(result.ok, true);
    assert.ok(result.total! >= 2);
    for (const r of result.results!) {
      assert.equal(r.category, "architecture");
    }
  });

  test("filters by status", () => {
    const result = searchDecisionsForMcp(tmpRepo, { status: "active", limit: 25 }, db);
    assert.equal(result.ok, true);
    for (const r of result.results!) {
      assert.equal(r.status, "active");
    }
  });

  test("returns an empty result set on no-match query", () => {
    const result = searchDecisionsForMcp(
      tmpRepo,
      { query: "thisstringshouldnotmatchanything12345", limit: 25 },
      db,
    );
    assert.equal(result.ok, true);
    assert.equal(result.total, 0);
    assert.equal(result.results!.length, 0);
  });

  test("filters by tag", () => {
    const result = searchDecisionsForMcp(
      tmpRepo,
      { tags: ["data-layer"], limit: 25 },
      db,
    );
    assert.equal(result.ok, true);
    assert.ok(result.total! >= 1);
  });
});

describe("kodela_supersede_decision (MVP)", () => {
  test("supersedes DEC-0001 with a new decision and creates the link", () => {
    const result = supersedeDecisionForMcp(
      tmpRepo,
      {
        old_decision_id: "DEC-0001",
        new_decision: {
          title: "Use Drizzle ORM v0.50 with extended migrations workflow",
          category: "architecture",
          problem:
            "DEC-0001 (Drizzle ORM v0.45) does not cover the new migration " +
            "directory layout we need for multi-tenant schema variants.",
          decision:
            "Upgrade to Drizzle ORM v0.50+ and adopt the new migrations " +
            "directory layout with per-tenant variants.",
          reason:
            "Drizzle v0.50 added schema-scoped migrations and improved type " +
            "inference for jsonb columns. The new workflow eliminates a " +
            "long-standing pain point with our multi-tenant testing path.",
          options: [
            {
              label: "Drizzle v0.50+ (chosen)",
              description: "Upgrade to the new major release.",
              was_chosen: true,
            },
            {
              label: "Stay on v0.45",
              description: "Don't upgrade.",
              was_chosen: false,
              rejection_reason: "Misses the new migrations workflow we need.",
            },
          ],
          author_id: "praneeth@blash.uk",
          approver_ids: ["anjan.mukherjee@blash.uk"],
          tags: ["data-layer", "tooling"],
          visibility: "public-to-org",
          decided_at: new Date("2026-05-01T00:00:00Z").toISOString(),
          initial_links: [],
        },
      },
      db,
    );

    assert.equal(result.ok, true, `supersede failed: ${result.error}`);
    assert.equal(result.result!.old_decision_id, "DEC-0001");
    assert.equal(result.result!.status_old, "superseded");
    assert.match(result.result!.new_decision_id, /^DEC-\d{4}$/);

    // Verify old decision is now superseded
    const oldDecision = getDecisionForMcp(tmpRepo, { decision_id: "DEC-0001" }, db);
    assert.equal(oldDecision.decision!.decision.status, "superseded");
    assert.equal(
      oldDecision.decision!.decision.superseded_by,
      result.result!.new_decision_id,
    );

    // Verify new decision has supersedes=[DEC-0001]
    const newDecision = getDecisionForMcp(
      tmpRepo,
      { decision_id: result.result!.new_decision_id },
      db,
    );
    assert.ok(newDecision.decision!.decision.supersedes.includes("DEC-0001"));
  });

  test("rejects supersede of an already-superseded decision", () => {
    const result = supersedeDecisionForMcp(
      tmpRepo,
      {
        old_decision_id: "DEC-0001", // already superseded by previous test
        new_decision: {
          title: "Should fail because DEC-0001 is already superseded",
          category: "operational",
          problem:
            "This test asserts the supersede transition rejects when the source " +
            "decision is no longer in an active state.",
          decision:
            "Attempt to supersede DEC-0001 a second time; the operation should fail.",
          reason:
            "A decision can only be superseded once. Subsequent supersedes must " +
            "target the latest active decision in the chain.",
          options: [
            {
              label: "A",
              description: "chosen",
              was_chosen: true,
            },
            {
              label: "B",
              description: "rejected",
              was_chosen: false,
              rejection_reason: "test placeholder",
            },
          ],
          author_id: "test@example.com",
          approver_ids: [],
          tags: [],
          visibility: "public-to-org",
          decided_at: new Date().toISOString(),
          initial_links: [],
        },
      },
      db,
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.error?.includes("superseded") || result.error?.includes("status"),
      `unexpected error: ${result.error}`,
    );
  });

  test("rejects supersede of a non-existent decision", () => {
    const result = supersedeDecisionForMcp(
      tmpRepo,
      {
        old_decision_id: "DEC-9999",
        new_decision: {
          title: "Should fail because DEC-9999 does not exist",
          category: "operational",
          problem:
            "This test asserts the supersede transition rejects when the source " +
            "decision id is unknown to the system.",
          decision:
            "Attempt to supersede a non-existent decision id; the operation should fail.",
          reason:
            "We must never silently create a decision when the target supersede " +
            "id does not resolve to an existing row.",
          options: [
            {
              label: "A",
              description: "chosen",
              was_chosen: true,
            },
            {
              label: "B",
              description: "rejected",
              was_chosen: false,
              rejection_reason: "placeholder",
            },
          ],
          author_id: "test@example.com",
          approver_ids: [],
          tags: [],
          visibility: "public-to-org",
          decided_at: new Date().toISOString(),
          initial_links: [],
        },
      },
      db,
    );
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("not found"));
  });
});

describe("kodela_record_decision_outcome (MVP)", () => {
  test("records an outcome with evidence and persists it", () => {
    const r = recordDecisionOutcomeForMcp(
      tmpRepo,
      {
        decision_id: "DEC-0002",
        outcome:
          "Shipped the Drizzle migration; query latency dropped ~30% in staging.",
        evidence_links: [
          { kind: "metric", url: "https://grafana/x", label: "p95 latency" },
        ],
      },
      db,
    );
    assert.equal(r.ok, true, `outcome failed: ${r.error}`);
    assert.equal(r.decision!.decision.outcome_evidence.length, 1);

    // Re-read to confirm durability.
    const got = getDecisionForMcp(tmpRepo, { decision_id: "DEC-0002" }, db);
    assert.ok(got.decision!.decision.outcome?.includes("Shipped the Drizzle"));
    assert.ok(got.decision!.decision.outcome_recorded_at);
    assert.equal(got.decision!.decision.outcome_evidence[0].kind, "metric");
  });

  test("returns ok:false for a missing decision", () => {
    const r = recordDecisionOutcomeForMcp(
      tmpRepo,
      { decision_id: "DEC-9999", outcome: "x".repeat(30), evidence_links: [] },
      db,
    );
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes("not found"));
  });
});

describe("kodela_query (MVP — decisions branch)", () => {
  test("finds a decision by keyword and reports keyword mode", async () => {
    const r = await queryForMcp(
      tmpRepo,
      {
        query: "Drizzle",
        mode: "hybrid",
        include: { entries: false, decisions: true, sessions: false },
        limit: 20,
        token_budget: 8000,
      },
      db,
    );
    assert.equal(r.ok, true, `query failed: ${r.error}`);
    assert.equal(r.meta!.mode_used, "keyword");
    assert.ok(
      r.results!.some((x) => x.kind === "decision"),
      "expected at least one decision result",
    );
    // 'hybrid' was requested but downgraded → a meta note must say so.
    assert.ok(r.meta!.notes.some((n) => n.includes("keyword")));
  });

  test("returns empty results for a no-match query", async () => {
    const r = await queryForMcp(
      tmpRepo,
      {
        query: "zzzznomatch12345",
        mode: "keyword",
        include: { entries: false, decisions: true, sessions: false },
        limit: 20,
        token_budget: 8000,
      },
      db,
    );
    assert.equal(r.ok, true);
    assert.equal(r.results!.length, 0);
  });
});
