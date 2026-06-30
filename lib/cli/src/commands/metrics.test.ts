// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runMetrics, formatMetricsResult, isoWeek } from "./metrics.js";
import { runInit } from "./init.js";
import { runAdd } from "./add.js";

describe("isoWeek", () => {
  test("buckets a date into a sortable year-week key", () => {
    assert.match(isoWeek("2026-06-29T12:00:00.000Z"), /^2026-W\d{2}$/);
    assert.equal(isoWeek("not-a-date"), "unknown");
  });
});

describe("runMetrics", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-metrics-test-"));
    await fs.writeFile(path.join(tmp, "auth.ts"), "export const x = 1;\n");
    await fs.writeFile(path.join(tmp, "log.ts"), "export const y = 2;\n");
    await runInit(tmp);
    // Two captures on the same file, then one more — gives reuse signal.
    await runAdd({ repoRoot: tmp, filePath: "auth.ts", lineStart: 1, lineEnd: 1, note: "first capture here", severity: "high", source: "ai" });
    await runAdd({ repoRoot: tmp, filePath: "log.ts", lineStart: 1, lineEnd: 1, note: "second file capture", severity: "low", source: "human" });
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("computes memory size, coverage, and per-session figures", async () => {
    const r = await runMetrics({ repoRoot: tmp });
    assert.equal(r.memorySize, 2);
    assert.equal(r.filesCovered, 2);
    assert.ok(r.sessions >= 1);
    assert.ok(r.capturesPerSession > 0);
    assert.ok(Array.isArray(r.weekly));
  });

  test("formats text and json", async () => {
    const r = await runMetrics({ repoRoot: tmp });
    const text = formatMetricsResult(r, "text");
    assert.match(text, /Kodela memory/);
    assert.match(text, /Memory size/);
    assert.doesNotThrow(() => JSON.parse(formatMetricsResult(r, "json")));
  });

  test("cold repo returns a friendly zero report", async () => {
    const cold = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-metrics-cold-"));
    try {
      await runInit(cold);
      const r = await runMetrics({ repoRoot: cold });
      assert.equal(r.memorySize, 0);
      assert.match(formatMetricsResult(r, "text"), /No captured context yet/);
    } finally {
      await fs.rm(cold, { recursive: true, force: true });
    }
  });
});
