// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 2 — `kodela tour` end-to-end. Seeds a temp git repo with two source
 * files (one documented + risky, one bare) and confirms runTour produces a
 * dependency-ordered tour that ranks the documented/risky module first, weaves
 * its captured why into the markdown, and that JSON output works. Assertions are
 * file-level so they hold whether or not tree-sitter grammars are present.
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
import { runTour, formatTourResult } from "./tour.js";

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

describe("kodela tour (Phase 2)", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-tour-"));
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.writeFile(path.join(tmp, "src", "auth.ts"), "export function rotate() { return 1; }\n");
    await fs.writeFile(path.join(tmp, "src", "util.ts"), "export function noop() {}\n");
    await execFileAsync("git", ["init", "-q"], { cwd: tmp });
    await execFileAsync("git", ["add", "-A"], { cwd: tmp });
    await writeContextEntry(
      tmp,
      entry({
        id: "11111111-1111-4111-8111-111111111111",
        filePath: "src/auth.ts",
        lineRange: { start: 1, end: 40 },
        note: "Token rotation invalidates the previous id to stop replay of a captured token.",
        severity: "high",
        tags: ["auth", "security"],
      }),
    );
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("ranks the documented, risky module first and weaves its why into markdown", async () => {
    const result = await runTour({ repoRoot: tmp, projectName: "Demo" });
    assert.ok(result.tour.stops.length >= 1);
    assert.equal(result.tour.stops[0]!.filePath, "src/auth.ts", "documented+risky module leads");
    assert.equal(result.tour.stops[0]!.riskLevel, "high");
    assert.ok(result.tour.stats.withWhy >= 1);
    const md = formatTourResult(result, "text");
    assert.match(md, /# Guided tour — Demo/);
    assert.match(md, /Token rotation invalidates the previous id/);
    assert.match(md, /Why here:/);
  });

  test("--documented keeps only modules with captured why", async () => {
    const result = await runTour({ repoRoot: tmp, documentedOnly: true });
    assert.ok(result.tour.stops.every((s) => s.whys.length > 0 || s.decisions.length > 0));
    assert.ok(result.tour.stops.some((s) => s.filePath === "src/auth.ts"));
    assert.ok(!result.tour.stops.some((s) => s.filePath === "src/util.ts"));
  });

  test("json output serialises the tour", async () => {
    const result = await runTour({ repoRoot: tmp });
    const json = JSON.parse(formatTourResult(result, "json"));
    assert.ok(Array.isArray(json.stops));
    assert.equal(typeof json.stats.stops, "number");
  });
});
