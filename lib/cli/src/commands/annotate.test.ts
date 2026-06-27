// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runAnnotate, formatAnnotateResult } from "./annotate.js";
import { runInit } from "./init.js";
import { runAdd } from "./add.js";

describe("runAnnotate", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-annotate-test-"));
    await fs.writeFile(
      path.join(tmpDir, "service.ts"),
      "export class AuthService {\n  login() {}\n  logout() {}\n}\n",
    );
    await runInit(tmpDir);
    await runAdd({
      repoRoot: tmpDir,
      filePath: "service.ts",
      lineStart: 2,
      lineEnd: 2,
      note: "Login method — critical auth path",
      severity: "high",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns annotated lines for a tracked file", async () => {
    const result = await runAnnotate({ repoRoot: tmpDir, filePath: "service.ts" });
    assert.ok(result.lines.length > 0);
    assert.equal(result.totalEntries, 1);

    const annotatedLine = result.lines.find((l) => l.lineNum === 2);
    assert.ok(annotatedLine);
    assert.equal(annotatedLine!.entries.length, 1);
    assert.ok(annotatedLine!.entries[0]?.note.includes("Login method"));
  });

  test("returns empty for non-existent file", async () => {
    const result = await runAnnotate({ repoRoot: tmpDir, filePath: "notexist.ts" });
    assert.equal(result.lines.length, 0);
    assert.equal(result.totalEntries, 0);
  });

  test("lines without annotations have empty entries array", async () => {
    const result = await runAnnotate({ repoRoot: tmpDir, filePath: "service.ts" });
    const unannotated = result.lines.filter((l) => l.lineNum !== 2);
    for (const line of unannotated) {
      assert.equal(line.entries.length, 0);
    }
  });
});

describe("formatAnnotateResult", () => {
  test("shows file not found for empty result", () => {
    const msg = formatAnnotateResult({ filePath: "missing.ts", lines: [], totalEntries: 0 });
    assert.ok(msg.includes("File not found"));
    assert.ok(msg.includes("missing.ts"));
  });

  test("shows line numbers and content", () => {
    const result = {
      filePath: "test.ts",
      totalEntries: 0,
      lines: [
        { lineNum: 1, content: "const x = 1;", entries: [] },
        { lineNum: 2, content: "export default x;", entries: [] },
      ],
    };
    const msg = formatAnnotateResult(result);
    assert.ok(msg.includes("const x = 1;"));
    assert.ok(msg.includes("export default x;"));
  });
});
