// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { runInit } from "@kodela/cli";
import { appendTelemetryEvent } from "@kodela/core";
import { TELEMETRY_SCHEMA_VERSION } from "@kodela/core";
import { runHealth, formatHealthResult } from "./health.js";

async function makeRepo(dir: string): Promise<void> {
  await runInit(dir);
}

async function emit(dir: string, type: string, extra: Record<string, unknown> = {}): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await appendTelemetryEvent(dir, { type, schemaVersion: TELEMETRY_SCHEMA_VERSION, timestamp: new Date().toISOString(), ...extra } as any);
}

// ---------------------------------------------------------------------------
// runHealth — pure signal computation
// ---------------------------------------------------------------------------

describe("runHealth — empty repo (no telemetry)", () => {
  let tmpDir: string;
  after(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("reports low-adoption signal (0 annotations < default minAnnotations of 5)", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-health-"));
    await makeRepo(tmpDir);

    const result = await runHealth({ repoRoot: tmpDir });
    assert.equal(result.annotationCount, 0);
    assert.equal(result.hoverCount, 0);

    const adoptionSignal = result.signals.find((s) => s.name === "adoption");
    assert.ok(adoptionSignal, "adoption signal should exist");
    assert.ok(!adoptionSignal!.pass, "adoption should fail with 0 annotations");
    assert.ok(!result.healthy, "repo should not be healthy");
  });

  test("dismissal ratio is null with no events", async () => {
    const result = await runHealth({ repoRoot: tmpDir });
    assert.equal(result.dismissalRatio, null);
    const frictionSignal = result.signals.find((s) => s.name === "friction");
    assert.ok(frictionSignal?.pass, "friction passes when no data (null ratio)");
  });
});

describe("runHealth — sufficient annotations", () => {
  let tmpDir: string;
  after(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("reports healthy when annotation count meets minimum", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-health2-"));
    await makeRepo(tmpDir);

    for (let i = 0; i < 6; i++) {
      await emit(tmpDir, "annotation_added", { noteLength: 30, source: "human", aiToolPresent: false });
    }
    const result = await runHealth({ repoRoot: tmpDir, minAnnotations: 5 });
    assert.equal(result.annotationCount, 6);
    const adoptionSignal = result.signals.find((s) => s.name === "adoption");
    assert.ok(adoptionSignal?.pass, "adoption should pass with 6 annotations");
  });
});

describe("runHealth — friction signal", () => {
  let tmpDir: string;
  after(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("friction triggers when dismissal_ratio exceeds threshold", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-health3-"));
    await makeRepo(tmpDir);

    // 1 added, 9 dismissed → ratio = 0.90 > default 0.70
    await emit(tmpDir, "annotation_added", { noteLength: 20, source: "human", aiToolPresent: false });
    for (let i = 0; i < 9; i++) {
      await emit(tmpDir, "prompt_dismissed", { stage: "note" });
    }

    const result = await runHealth({ repoRoot: tmpDir, minAnnotations: 0 });
    assert.ok(result.dismissalRatio !== null);
    assert.ok(result.dismissalRatio! > 0.7);
    const frictionSignal = result.signals.find((s) => s.name === "friction");
    assert.ok(!frictionSignal?.pass, "friction should fail when ratio > threshold");
  });

  test("friction passes when dismissal_ratio is below threshold", async () => {
    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-health4-"));
    await makeRepo(tmpDir2);

    // 8 added, 2 dismissed → ratio = 0.20 < 0.70
    for (let i = 0; i < 8; i++) {
      await emit(tmpDir2, "annotation_added", { noteLength: 20, source: "human", aiToolPresent: false });
    }
    for (let i = 0; i < 2; i++) {
      await emit(tmpDir2, "prompt_dismissed", {});
    }

    const result = await runHealth({ repoRoot: tmpDir2, minAnnotations: 0 });
    const frictionSignal = result.signals.find((s) => s.name === "friction");
    assert.ok(frictionSignal?.pass, "friction should pass when ratio is low");
    await fs.rm(tmpDir2, { recursive: true, force: true });
  });
});

describe("runHealth — nag_fatigue signal", () => {
  let tmpDir: string;
  after(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("nag_fatigue triggers when nag_ignored_ratio exceeds threshold", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-health5-"));
    await makeRepo(tmpDir);

    // 1 annotation added, 2 nag ignored → ratio = 2/3 ≈ 0.67 > 0.50
    await emit(tmpDir, "annotation_added", { noteLength: 15, source: "human", aiToolPresent: false });
    await emit(tmpDir, "nag_ignored", { itemCount: 3 });
    await emit(tmpDir, "nag_ignored", { itemCount: 2 });

    const result = await runHealth({ repoRoot: tmpDir, minAnnotations: 0 });
    assert.ok(result.nagIgnoredRatio !== null);
    assert.ok(result.nagIgnoredRatio! > 0.5);
    const nagSignal = result.signals.find((s) => s.name === "nag_fatigue");
    assert.ok(!nagSignal?.pass, "nag_fatigue should fail when ratio > threshold");
  });
});

describe("runHealth — window filtering", () => {
  let tmpDir: string;
  after(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("events outside the window are excluded", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-health6-"));
    await makeRepo(tmpDir);

    // Write an old event (60 days ago) directly
    const oldTs = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const telPath = path.join(tmpDir, ".kodela", "telemetry.jsonl");
    await fs.writeFile(
      telPath,
      JSON.stringify({ type: "annotation_added", schemaVersion: TELEMETRY_SCHEMA_VERSION, timestamp: oldTs, noteLength: 50, source: "human", aiToolPresent: false }) + "\n",
    );

    const now = Date.now();
    const result = await runHealth({ repoRoot: tmpDir, windowDays: 30, now });
    assert.equal(result.annotationCount, 0, "old event should be filtered out by the window");
  });
});

// ---------------------------------------------------------------------------
// formatHealthResult
// ---------------------------------------------------------------------------

describe("formatHealthResult", () => {
  test("text format includes signal names and overall verdict", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-health7-"));
    await makeRepo(tmpDir);
    const result = await runHealth({ repoRoot: tmpDir });
    const text = formatHealthResult(result, "text");
    assert.ok(text.includes("Kill-switch signals"), `got: ${text}`);
    assert.ok(text.includes("adoption") || text.includes("KILL-SWITCH"), `got: ${text}`);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("json format is valid JSON with required fields", async () => {
    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-health8-"));
    await makeRepo(tmpDir2);
    const result = await runHealth({ repoRoot: tmpDir2 });
    const json = formatHealthResult(result, "json");
    const parsed = JSON.parse(json) as { healthy: boolean; signals: unknown[] };
    assert.equal(typeof parsed.healthy, "boolean");
    assert.ok(Array.isArray(parsed.signals));
    await fs.rm(tmpDir2, { recursive: true, force: true });
  });

  test("healthy flag is true only when all signals pass", () => {
    const mockResult = {
      windowDays: 30,
      annotationCount: 10,
      hoverCount: 5,
      dismissalCount: 1,
      nagIgnoredCount: 0,
      dismissalRatio: 0.10,
      nagIgnoredRatio: null,
      signals: [
        { name: "adoption", pass: true, value: 10, threshold: 5, message: "ok" },
        { name: "friction", pass: true, value: 0.10, threshold: 0.70, message: "ok" },
        { name: "nag_fatigue", pass: true, value: null, threshold: null, message: "ok" },
        { name: "merge_conflicts", pass: true, value: null, threshold: null, message: "manual" },
      ],
      healthy: true,
    };
    const text = formatHealthResult(mockResult, "text");
    assert.ok(text.includes("HEALTHY"), `expected HEALTHY, got: ${text}`);
  });
});
