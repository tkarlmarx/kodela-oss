// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { runInit, runAdd, heal } from "@kodela/cli";
import { readContextEntry } from "@kodela/core";

describe("heal() engine — delete-event orphaning", () => {
  let tmpDir: string;

  after(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("delete event marks all entries for that file as orphaned", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-heal-delete-"));
    await runInit(tmpDir);

    const absPath = path.join(tmpDir, "target.ts");
    await fs.writeFile(absPath, "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n");

    const { entry } = await runAdd({
      repoRoot: tmpDir,
      filePath: "target.ts",
      lineStart: 1,
      lineEnd: 2,
      note: "exports x and y",
      severity: "low",
      source: "human",
      tags: [],
    });

    assert.equal(entry.status, "mapped", "entry should start as mapped");

    await fs.rm(absPath);

    const result = await heal(
      [{ filePath: absPath, changeType: "delete", timestamp: Date.now() }],
      { repoRoot: tmpDir },
    );

    assert.equal(result.orphaned, 1, "one entry should be orphaned after file deletion");
    assert.equal(result.updated, 0, "no entries should be updated");
    assert.equal(result.uncertain, 0, "no entries should be uncertain");

    const updated = await readContextEntry(tmpDir, entry.id);
    assert.equal(updated.status, "orphaned", "persisted entry status should be orphaned");
    assert.equal(updated.reviewRequired, true, "orphaned entry should require review");
  });

  test("delete event with multiple entries orphans all of them", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-heal-delete-multi-"));
    await runInit(tmpDir);

    const absPath = path.join(tmpDir, "multi.ts");
    await fs.writeFile(absPath, [
      "export const a = 1;",
      "export const b = 2;",
      "export const c = 3;",
      "export const d = 4;",
      "",
    ].join("\n"));

    const { entry: e1 } = await runAdd({
      repoRoot: tmpDir,
      filePath: "multi.ts",
      lineStart: 1,
      lineEnd: 2,
      note: "a and b constants",
      severity: "low",
      source: "human",
      tags: [],
    });
    const { entry: e2 } = await runAdd({
      repoRoot: tmpDir,
      filePath: "multi.ts",
      lineStart: 3,
      lineEnd: 4,
      note: "c and d constants",
      severity: "low",
      source: "human",
      tags: [],
    });

    await fs.rm(absPath);

    const result = await heal(
      [{ filePath: absPath, changeType: "delete", timestamp: Date.now() }],
      { repoRoot: tmpDir },
    );

    assert.equal(result.orphaned, 2, "both entries should be orphaned");
    assert.equal(result.updated + result.uncertain, 0, "no entry should be updated or uncertain");

    const u1 = await readContextEntry(tmpDir, e1.id);
    const u2 = await readContextEntry(tmpDir, e2.id);
    assert.equal(u1.status, "orphaned");
    assert.equal(u2.status, "orphaned");
  });
});

describe("heal() engine — rename-event relocation", () => {
  let tmpDir: string;

  after(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("create event with renameFrom relocates entries to new file path", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-heal-rename-"));
    await runInit(tmpDir);

    const fileContent = [
      "export function greet(name: string): string {",
      "  return `Hello, ${name}!`;",
      "}",
      "",
    ].join("\n");

    const absOldPath = path.join(tmpDir, "greet-old.ts");
    const absNewPath = path.join(tmpDir, "greet-new.ts");

    await fs.writeFile(absOldPath, fileContent);

    const { entry } = await runAdd({
      repoRoot: tmpDir,
      filePath: "greet-old.ts",
      lineStart: 1,
      lineEnd: 3,
      note: "greet function",
      severity: "low",
      source: "human",
      tags: [],
    });

    assert.equal(entry.filePath, "greet-old.ts");

    await fs.writeFile(absNewPath, fileContent);
    await fs.rm(absOldPath);

    const result = await heal(
      [
        {
          filePath: absNewPath,
          changeType: "create",
          timestamp: Date.now(),
          renameFrom: absOldPath,
        },
      ],
      { repoRoot: tmpDir },
    );

    assert.ok(
      result.updated + result.uncertain >= 1,
      `entry should be relocated (updated or uncertain); got updated=${result.updated} uncertain=${result.uncertain} orphaned=${result.orphaned}`,
    );
    assert.equal(result.orphaned, 0, "rename should not orphan the entry");

    const relocated = await readContextEntry(tmpDir, entry.id);
    assert.equal(
      relocated.filePath,
      "greet-new.ts",
      "entry filePath should be updated to the new file path after rename",
    );
  });

  test("rename of file with no indexed entries produces zero counts", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-heal-rename-empty-"));
    await runInit(tmpDir);

    const absOldPath = path.join(tmpDir, "unused-old.ts");
    const absNewPath = path.join(tmpDir, "unused-new.ts");

    await fs.writeFile(absOldPath, "export const noop = () => {};\n");
    await fs.writeFile(absNewPath, "export const noop = () => {};\n");
    await fs.rm(absOldPath);

    const result = await heal(
      [
        {
          filePath: absNewPath,
          changeType: "create",
          timestamp: Date.now(),
          renameFrom: absOldPath,
        },
      ],
      { repoRoot: tmpDir },
    );

    assert.equal(result.updated, 0);
    assert.equal(result.orphaned, 0);
    assert.equal(result.uncertain, 0);
  });
});
