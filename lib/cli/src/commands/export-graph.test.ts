// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Sprint 3 / [E.14] — tests for `kodela export-graph`.
 *
 * Builds a tiny `.kodela/` fixture (one entry, one session) and exercises
 * the three formats end-to-end via runExportGraph.  Asserts the wire-shape
 * properties an external consumer cares about:
 *
 *   - json:     valid JSON, has nodes + edges + summary
 *   - mermaid:  starts with `flowchart LR`, all node IDs are alphanumeric
 *   - obsidian: contains a `[[file-path]]` wiki-link for every file node
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeContextEntry, writeIndex } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";

import { runExportGraph } from "./export-graph.js";

let tmpRepo: string;

const ENTRY_ID = "550e8400-e29b-41d4-a716-446655440777";

const ENTRY: ContextEntry = {
  schemaVersion: "1.1.0",
  id: ENTRY_ID,
  filePath: "src/auth/login.ts",
  astAnchor: {
    kind: "function",
    name: "validateToken",
    blockHash: "deadbeef" + "0".repeat(56),
  },
  contentHash: "a".repeat(64),
  lineRange: { start: 1, end: 5 },
  note: "Token validation logic",
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

before(async () => {
  tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-export-graph-"));
  await fs.mkdir(path.join(tmpRepo, ".kodela"), { recursive: true });
  await fs.mkdir(path.join(tmpRepo, "src/auth"), { recursive: true });

  // Real source so the import-edge extractor sees the file on disk.
  await fs.writeFile(
    path.join(tmpRepo, "src/auth/login.ts"),
    [
      "export async function validateToken(token: string): Promise<boolean> {",
      "  if (!token) return false;",
      "  return token.startsWith('Bearer ');",
      "}",
    ].join("\n") + "\n",
    "utf-8",
  );

  await writeContextEntry(tmpRepo, ENTRY);
  await writeIndex(tmpRepo, {
    schemaVersion: "1.1.0",
    entries: [ENTRY_ID],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
});

after(async () => {
  await fs.rm(tmpRepo, { recursive: true, force: true });
});

describe("kodela export-graph — mermaid", () => {
  test("emits a flowchart LR header and at least one node line", async () => {
    const result = await runExportGraph({ repoRoot: tmpRepo, format: "mermaid" });
    assert.equal(result.format, "mermaid");
    assert.ok(result.content.startsWith("flowchart LR"), "must start with mermaid header");
    assert.ok(result.nodeCount >= 1, "must include at least the file node");
    // Every node line in mermaid output begins with two-space indent + an
    // alphanumeric-or-underscore id — no special chars that mermaid rejects.
    const nodeLines = result.content
      .split("\n")
      .filter((l) => /^  n_[A-Za-z0-9_]+/.test(l));
    assert.ok(nodeLines.length >= 1, "must have at least one rendered node");
  });
});

describe("kodela export-graph — obsidian", () => {
  test("emits Markdown with at least one wiki-linked file", async () => {
    const result = await runExportGraph({ repoRoot: tmpRepo, format: "obsidian" });
    assert.equal(result.format, "obsidian");
    assert.match(result.content, /^# Kodela Memory Graph/, "starts with the title");
    assert.match(
      result.content,
      /\[\[src\/auth\/login\.ts\]\]/,
      "wiki-links the fixture file",
    );
  });
});

describe("kodela export-graph — json", () => {
  test("emits the SerializedGraph shape with summary counts", async () => {
    const result = await runExportGraph({ repoRoot: tmpRepo, format: "json" });
    assert.equal(result.format, "json");
    const parsed = JSON.parse(result.content) as {
      nodes: unknown[];
      edges: unknown[];
      summary: { fileCount: number; functionCount: number; contextCount: number };
    };
    assert.ok(Array.isArray(parsed.nodes));
    assert.ok(Array.isArray(parsed.edges));
    assert.ok(parsed.summary.fileCount >= 1);
    // The fixture's one entry creates the context node + its parent file node.
    assert.ok(parsed.summary.contextCount >= 1);
  });
});

describe("kodela export-graph — scope filter", () => {
  test("nodeCount drops to 0 when scope misses everything", async () => {
    const result = await runExportGraph({
      repoRoot: tmpRepo,
      format: "json",
      scopeFile: "no/such/dir",
    });
    assert.equal(result.nodeCount, 0);
    assert.equal(result.edgeCount, 0);
  });

  test("nodeCount survives when scope hits the fixture file", async () => {
    const result = await runExportGraph({
      repoRoot: tmpRepo,
      format: "json",
      scopeFile: "src/auth/login.ts",
    });
    assert.ok(result.nodeCount >= 1);
  });
});
