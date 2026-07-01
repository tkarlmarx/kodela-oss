// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 2 — `kodela comprehend` end-to-end. Seeds a temp git repo with a source
 * file and a context entry, then confirms runComprehend walks tracked files,
 * emits a file node, fuses the captured why onto it, and that --file scoping,
 * --documented filtering, and the formatters work. Assertions avoid depending on
 * tree-sitter grammars (optional deps) by checking file-level behaviour, which
 * holds whether or not functions parse.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { runComprehend, formatComprehendResult } from "./comprehend.js";

const execFileAsync = promisify(execFile);

function entry(over: Partial<ContextEntry>): ContextEntry {
  return {
    schemaVersion: "1.1.0",
    id: "00000000-0000-0000-0000-000000000000",
    filePath: "src/auth.ts",
    astAnchor: null,
    contentHash: "hash",
    lineRange: { start: 1, end: 40 },
    note: "note",
    author: "ai",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    severity: "low",
    tags: [],
    source: "ai",
    confidence: 0.9,
    status: "mapped",
    reviewRequired: false,
    ...over,
  };
}

describe("kodela comprehend (Phase 2)", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-comprehend-"));
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, "src", "auth.ts"),
      "export function rotate() { return 1; }\nexport function verify() { return 2; }\n",
    );
    await fs.writeFile(path.join(tmp, "src", "readme.md"), "# not source\n");
    // git repo with the files tracked so `git ls-files` sees them.
    await execFileAsync("git", ["init", "-q"], { cwd: tmp });
    await execFileAsync("git", ["add", "-A"], { cwd: tmp });
    await writeContextEntry(
      tmp,
      entry({
        id: "11111111-1111-4111-8111-111111111111",
        filePath: "src/auth.ts",
        lineRange: { start: 1, end: 40 },
        note: "Token rotation invalidates the previous id so a captured token cannot be replayed.",
        severity: "high",
        tags: ["auth"],
      }),
    );
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("walks tracked source files and emits a file node with fused why", async () => {
    const { graph, filesParsed } = await runComprehend({ repoRoot: tmp });
    assert.equal(filesParsed, 1, "only the .ts file is a supported source file");
    const fileNode = graph.nodes.find((n) => n.kind === "file" && n.filePath === "src/auth.ts");
    assert.ok(fileNode, "a file node exists for src/auth.ts");
    assert.equal(fileNode!.whys.length, 1, "the captured why is fused onto the file");
    assert.equal(fileNode!.riskLevel, "high");
    assert.match(fileNode!.description, /auth\.ts/);
  });

  test("--file scoping restricts to the matching path", async () => {
    const hit = await runComprehend({ repoRoot: tmp, filter: "auth" });
    assert.ok(hit.graph.nodes.some((n) => n.filePath === "src/auth.ts"));
    const miss = await runComprehend({ repoRoot: tmp, filter: "does-not-exist" });
    assert.equal(miss.filesParsed, 0);
    assert.equal(miss.graph.nodes.length, 0);
  });

  test("--documented keeps only nodes carrying captured why", async () => {
    const { graph } = await runComprehend({ repoRoot: tmp, documentedOnly: true });
    assert.ok(graph.nodes.length >= 1);
    assert.ok(graph.nodes.every((n) => n.whys.length > 0 || n.decisions.length > 0));
  });

  test("text and json formatters render", async () => {
    const result = await runComprehend({ repoRoot: tmp });
    const text = formatComprehendResult(result, "text");
    assert.match(text, /Comprehension graph —/);
    assert.match(text, /src\/auth\.ts/);
    const json = JSON.parse(formatComprehendResult(result, "json"));
    assert.ok(Array.isArray(json.nodes));
    assert.equal(typeof json.stats.coverage, "number");
  });
});
