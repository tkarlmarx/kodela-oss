// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Regression: entries with no intent cluster (cluster_id NULL) must still be
 * retrieved. This is the exact shape server-side shared-memory retrieval
 * produces — entries materialised from Postgres into an in-memory index have no
 * cluster rows — so if the builder dropped un-clustered entries, `kodela context
 * --read-mode remote` would always return nothing.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openIndex, initSchema, upsertEntry, type EntryRow } from "../storage/sqlite-index.js";
import { buildProjectContext } from "./builder.js";

function row(over: Partial<EntryRow>): EntryRow {
  return {
    id: "e1",
    filePath: "src/a.ts",
    schemaVersion: "1.0.0",
    status: "mapped",
    severity: "info",
    source: "ai",
    confidence: 0.9,
    scope: null,
    sessionId: null,
    clusterId: null,
    reviewRequired: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("buildProjectContext — un-clustered entries surface", () => {
  test("returns entries even when none are attached to a cluster", () => {
    const db = openIndex(":memory:");
    initSchema(db);
    upsertEntry(db, row({ id: "e1", filePath: "src/a.ts", clusterId: null }));
    upsertEntry(db, row({ id: "e2", filePath: "src/b.ts", clusterId: null, confidence: 0.8 }));

    const ctx = buildProjectContext(db, { tokenBudget: 4000 }, process.cwd());

    assert.equal(ctx.meta.selectedClusters, 0, "no clusters exist");
    assert.equal(ctx.meta.selectedEntries, 2, "both un-clustered entries surfaced");
    assert.deepEqual(
      ctx.entries.map((e) => e.id).sort(),
      ["e1", "e2"],
    );
  });

  test("orders un-clustered entries by score (higher confidence first)", () => {
    const db = openIndex(":memory:");
    initSchema(db);
    upsertEntry(db, row({ id: "low", confidence: 0.2 }));
    upsertEntry(db, row({ id: "high", confidence: 0.95 }));

    const ctx = buildProjectContext(db, { tokenBudget: 4000 }, process.cwd());
    assert.equal(ctx.entries[0]?.id, "high", "highest-scored un-clustered entry ranks first");
  });
});
