// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { appendTelemetryEvent, readTelemetryEvents, countTelemetryLines } from "./telemetry-storage.js";
import { TELEMETRY_SCHEMA_VERSION } from "./telemetry-schema.js";
import type { TelemetryEvent } from "./telemetry-schema.js";

async function makeKodelaDir(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, ".kodela"), { recursive: true });
}

describe("appendTelemetryEvent", () => {
  let tmpDir: string;
  after(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("creates telemetry.jsonl inside .kodela/ when it does not exist", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-tel-"));
    await makeKodelaDir(tmpDir);

    const event: TelemetryEvent = {
      type: "annotation_added",
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      timestamp: "2024-01-15T10:00:00.000Z",
      noteLength: 42,
      source: "human",
      aiToolPresent: false,
    };
    await appendTelemetryEvent(tmpDir, event);

    const telPath = path.join(tmpDir, ".kodela", "telemetry.jsonl");
    const raw = await fs.readFile(telPath, "utf-8");
    assert.ok(raw.trim().length > 0, "file should have content");
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
    assert.equal(parsed["type"], "annotation_added");
    assert.equal(parsed["noteLength"], 42);
  });

  test("silently does nothing when .kodela/ directory does not exist", async () => {
    const missingRoot = path.join(os.tmpdir(), "kodela-no-dir-" + Date.now());
    const event: TelemetryEvent = {
      type: "prompt_dismissed",
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      timestamp: "2024-01-15T10:00:00.000Z",
    };
    await assert.doesNotReject(
      () => appendTelemetryEvent(missingRoot, event),
      "should not throw when .kodela/ is absent",
    );
  });

  test("appends multiple events on separate lines", async () => {
    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-tel2-"));
    await makeKodelaDir(tmpDir2);

    const events: TelemetryEvent[] = [
      { type: "annotation_added", schemaVersion: TELEMETRY_SCHEMA_VERSION, timestamp: "2024-01-01T00:00:00.000Z", noteLength: 20, source: "ai", aiToolPresent: true },
      { type: "hover_viewed", schemaVersion: TELEMETRY_SCHEMA_VERSION, timestamp: "2024-01-02T00:00:00.000Z", entryAgeMs: 86400000, hasLink: true },
    ];
    for (const e of events) await appendTelemetryEvent(tmpDir2, e);

    const lines = (await countTelemetryLines(tmpDir2));
    assert.equal(lines, 2, "should have 2 lines");
    await fs.rm(tmpDir2, { recursive: true, force: true });
  });
});

describe("readTelemetryEvents", () => {
  let tmpDir: string;
  after(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }); });

  test("returns empty array when telemetry.jsonl does not exist", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-tel3-"));
    await makeKodelaDir(tmpDir);
    const events = await readTelemetryEvents(tmpDir);
    assert.deepEqual(events, []);
  });

  test("reads and parses all events", async () => {
    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-tel4-"));
    await makeKodelaDir(tmpDir2);

    await appendTelemetryEvent(tmpDir2, { type: "annotation_added", schemaVersion: TELEMETRY_SCHEMA_VERSION, timestamp: "2024-03-01T00:00:00.000Z", noteLength: 55, source: "human", aiToolPresent: false });
    await appendTelemetryEvent(tmpDir2, { type: "hover_viewed", schemaVersion: TELEMETRY_SCHEMA_VERSION, timestamp: "2024-03-02T00:00:00.000Z", entryAgeMs: 100_000, hasLink: false });
    await appendTelemetryEvent(tmpDir2, { type: "prompt_dismissed", schemaVersion: TELEMETRY_SCHEMA_VERSION, timestamp: "2024-03-03T00:00:00.000Z" });

    const events = await readTelemetryEvents(tmpDir2);
    assert.equal(events.length, 3);
    assert.equal(events[0]?.type, "annotation_added");
    assert.equal(events[1]?.type, "hover_viewed");
    assert.equal(events[2]?.type, "prompt_dismissed");
    await fs.rm(tmpDir2, { recursive: true, force: true });
  });

  test("filters by event type", async () => {
    const tmpDir3 = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-tel5-"));
    await makeKodelaDir(tmpDir3);
    await appendTelemetryEvent(tmpDir3, { type: "annotation_added", schemaVersion: TELEMETRY_SCHEMA_VERSION, timestamp: "2024-01-01T00:00:00.000Z", noteLength: 30, source: "ai", aiToolPresent: true });
    await appendTelemetryEvent(tmpDir3, { type: "nag_ignored", schemaVersion: TELEMETRY_SCHEMA_VERSION, timestamp: "2024-01-02T00:00:00.000Z", itemCount: 3 });

    const filtered = await readTelemetryEvents(tmpDir3, { types: ["nag_ignored"] });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.type, "nag_ignored");
    await fs.rm(tmpDir3, { recursive: true, force: true });
  });

  test("filters by afterMs window", async () => {
    const tmpDir4 = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-tel6-"));
    await makeKodelaDir(tmpDir4);
    // One old event (Jan) and one recent (Mar)
    await appendTelemetryEvent(tmpDir4, { type: "annotation_added", schemaVersion: TELEMETRY_SCHEMA_VERSION, timestamp: "2024-01-01T00:00:00.000Z", noteLength: 10, source: "human", aiToolPresent: false });
    await appendTelemetryEvent(tmpDir4, { type: "hover_viewed", schemaVersion: TELEMETRY_SCHEMA_VERSION, timestamp: "2024-03-01T00:00:00.000Z", entryAgeMs: 0, hasLink: false });

    const cutoff = new Date("2024-02-01T00:00:00.000Z").getTime();
    const events = await readTelemetryEvents(tmpDir4, { afterMs: cutoff });
    assert.equal(events.length, 1, "only the March event should pass the filter");
    assert.equal(events[0]?.type, "hover_viewed");
    await fs.rm(tmpDir4, { recursive: true, force: true });
  });

  test("silently skips malformed lines", async () => {
    const tmpDir5 = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-tel7-"));
    await makeKodelaDir(tmpDir5);
    const telPath = path.join(tmpDir5, ".kodela", "telemetry.jsonl");
    await fs.writeFile(telPath, 'GARBAGE_LINE\n{"type":"prompt_dismissed","schemaVersion":"1.0.0","timestamp":"2024-01-01T00:00:00.000Z"}\n', "utf-8");
    const events = await readTelemetryEvents(tmpDir5);
    assert.equal(events.length, 1, "malformed line should be silently skipped");
    await fs.rm(tmpDir5, { recursive: true, force: true });
  });

  test("silently skips lines that fail Zod schema validation", async () => {
    const tmpDir6 = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-tel8-"));
    await makeKodelaDir(tmpDir6);
    const telPath = path.join(tmpDir6, ".kodela", "telemetry.jsonl");
    // valid JSON but unknown type
    await fs.writeFile(telPath, '{"type":"unknown_event","schemaVersion":"1.0.0","timestamp":"2024-01-01T00:00:00.000Z"}\n', "utf-8");
    const events = await readTelemetryEvents(tmpDir6);
    assert.equal(events.length, 0, "invalid schema should be silently skipped");
    await fs.rm(tmpDir6, { recursive: true, force: true });
  });
});

describe("countTelemetryLines", () => {
  test("returns 0 when file does not exist", async () => {
    const count = await countTelemetryLines("/nonexistent/path");
    assert.equal(count, 0);
  });
});
