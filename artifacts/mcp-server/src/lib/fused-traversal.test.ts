// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { openIndex } from "@kodela/core";
import {
  ensureGraphTables,
  insertEdges,
  edgesForCodeFunctions,
  codeFunctionNodeId,
} from "./graph-store.js";
import { fuseFunctionContext } from "./fused-traversal.js";

describe("fuseFunctionContext", () => {
  let tmp: string;
  let db: DatabaseSync;
  const FILE = "src/billing/aggregator.ts";
  const ANCHOR = "function:roundToDecimals";
  const ENTRY = "entry-1";
  const SESSION = "session-1";
  const DECISION = "DEC-0007";
  const PR = "PR-42";
  const INCIDENT = "INC-9";

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-fuse-"));
    await fs.mkdir(path.join(tmp, ".kodela"), { recursive: true });
    db = openIndex(path.join(tmp, ".kodela", "index.db"));
    ensureGraphTables(db);

    const now = "2026-06-29T00:00:00.000Z";
    // The full fused chain, as the annotate/decision/webhook paths would build it:
    insertEdges(
      db,
      [
        // session produced the entry
        { edge_type: "PRODUCED", source_node_type: "AI_SESSION", source_node_id: SESSION, target_node_type: "FILE_CHANGE", target_node_id: ENTRY },
        // entry implements a decision
        { edge_type: "IMPLEMENTS", source_node_type: "FILE_CHANGE", source_node_id: ENTRY, target_node_type: "DECISION", target_node_id: DECISION },
        // decision is included in a PR; an incident motivated the decision
        { edge_type: "INCLUDED_IN", source_node_type: "DECISION", source_node_id: DECISION, target_node_type: "PULL_REQUEST", target_node_id: PR },
        { edge_type: "MOTIVATES", source_node_type: "INCIDENT", source_node_id: INCIDENT, target_node_type: "DECISION", target_node_id: DECISION },
      ],
      now,
    );
    // the bridge edge: entry contains the function
    insertEdges(
      db,
      edgesForCodeFunctions({
        entryId: ENTRY,
        filePath: FILE,
        functions: [{ astAnchor: ANCHOR, name: "roundToDecimals", kind: "function", startLine: 10, endLine: 24 }],
      }),
      now,
    );
  });

  after(async () => {
    db.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("traverses function → entry → session → decision → PR/incident", () => {
    const ctx = fuseFunctionContext(db, { filePath: FILE, astAnchor: ANCHOR });
    assert.equal(ctx.functionNodeId, codeFunctionNodeId(FILE, ANCHOR));
    assert.deepEqual(ctx.sessions, [SESSION]);
    assert.deepEqual(ctx.decisions, [DECISION]);
    assert.deepEqual(ctx.pullRequests, [PR]);
    assert.deepEqual(ctx.incidents, [INCIDENT]);
    assert.equal(ctx.entries.length, 1);
    assert.equal(ctx.entries[0]?.entryId, ENTRY);
  });

  test("an unknown function resolves to an empty context, not an error", () => {
    const ctx = fuseFunctionContext(db, { filePath: FILE, astAnchor: "function:doesNotExist" });
    assert.equal(ctx.entries.length, 0);
    assert.deepEqual(ctx.sessions, []);
    assert.deepEqual(ctx.decisions, []);
  });
});
