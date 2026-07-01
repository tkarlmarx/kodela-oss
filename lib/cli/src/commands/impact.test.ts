// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 2 — `kodela impact` end-to-end. Seeds a temp git repo with a small
 * import chain (c → b → a) and a context entry, then confirms runImpact resolves
 * the reverse-dependency blast radius (ESM .js→.ts aware), fuses the captured
 * why, honours --max-depth, and that explicit-file mode + formatters work.
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
import { runImpact, formatImpactResult } from "./impact.js";

const execFileAsync = promisify(execFile);

describe("kodela impact (Phase 2)", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-impact-"));
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    // a is imported by b (via .js specifier), b is imported by c.
    await fs.writeFile(path.join(tmp, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(tmp, "src", "b.ts"), "import { a } from './a.js';\nexport const b = a + 1;\n");
    await fs.writeFile(path.join(tmp, "src", "c.ts"), "import { b } from './b.js';\nexport const c = b + 1;\n");
    await execFileAsync("git", ["init", "-q"], { cwd: tmp });
    await execFileAsync("git", ["add", "-A"], { cwd: tmp });

    const entry: ContextEntry = {
      schemaVersion: "1.1.0",
      id: "22222222-2222-4222-8222-222222222222",
      filePath: "src/c.ts",
      astAnchor: null,
      contentHash: "hash",
      lineRange: { start: 1, end: 3 },
      note: "c is the public entry point — changing what it depends on ripples to callers.",
      author: "ai",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      severity: "high",
      tags: ["api"],
      source: "ai",
      confidence: 0.9,
      status: "mapped",
      reviewRequired: false,
    };
    await writeContextEntry(tmp, entry);
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("resolves the reverse-dependency blast radius (ESM .js→.ts aware) and fuses why", async () => {
    const { report } = await runImpact({ repoRoot: tmp, files: ["src/a.ts"], maxDepth: 2 });
    const byPath = new Map(report.impacted.map((f) => [f.filePath, f.distance]));
    assert.equal(byPath.get("src/a.ts"), 0, "changed file");
    assert.equal(byPath.get("src/b.ts"), 1, "b imports a → distance 1");
    assert.equal(byPath.get("src/c.ts"), 2, "c imports b → distance 2");
    assert.equal(report.stats.dependents, 2);
    // c's high-severity why must be reflected in the radius's highest risk.
    assert.equal(report.highestRisk, "high");
    const c = report.impacted.find((f) => f.filePath === "src/c.ts")!;
    assert.equal(c.whys.length, 1);
  });

  test("--max-depth bounds the radius", async () => {
    const { report } = await runImpact({ repoRoot: tmp, files: ["src/a.ts"], maxDepth: 1 });
    assert.ok(report.impacted.some((f) => f.filePath === "src/b.ts"));
    assert.ok(!report.impacted.some((f) => f.filePath === "src/c.ts"), "c is beyond depth 1");
  });

  test("explicit-file source is reported and formatters render", async () => {
    const result = await runImpact({ repoRoot: tmp, files: ["src/a.ts"] });
    assert.equal(result.source, "args");
    const text = formatImpactResult(result, "text");
    assert.match(text, /Impact of changing 1 file/);
    assert.match(text, /blast radius/);
    const json = JSON.parse(formatImpactResult(result, "json"));
    assert.equal(json.source, "args");
    assert.ok(Array.isArray(json.impacted));
  });

  test("a clean working tree (no changed files) reports nothing to analyse", async () => {
    // No files arg + clean tree → git diff is empty.
    const result = await runImpact({ repoRoot: tmp });
    assert.equal(result.report.changedFiles.length, 0);
    assert.match(formatImpactResult(result, "text"), /No changed files/);
  });
});
