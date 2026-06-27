// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 21 — TelemetryService unit tests.
 * No real VS Code or filesystem needed: everything is injected.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TelemetryService } from "./telemetry-service.js";
import type { TelemetryEvent } from "@kodela/core";

function makeService(enabled: boolean = true): {
  service: TelemetryService;
  events: TelemetryEvent[];
} {
  const events: TelemetryEvent[] = [];
  const appendFn = async (_root: string, event: TelemetryEvent): Promise<void> => {
    events.push(event);
  };
  const service = new TelemetryService("/fake/root", appendFn, () => enabled);
  return { service, events };
}

describe("TelemetryService — enabled", () => {
  test("emitAnnotationAdded stores correct fields", async () => {
    const { service, events } = makeService(true);
    await service.emitAnnotationAdded(42, "human", false);
    assert.equal(events.length, 1);
    const e = events[0]!;
    assert.equal(e.type, "annotation_added");
    if (e.type !== "annotation_added") throw new Error("type guard");
    assert.equal(e.noteLength, 42);
    assert.equal(e.source, "human");
    assert.equal(e.aiToolPresent, false);
    assert.ok(e.timestamp, "timestamp should be set");
  });

  test("emitHoverViewed stores correct fields", async () => {
    const { service, events } = makeService(true);
    await service.emitHoverViewed(500_000, true);
    assert.equal(events.length, 1);
    const e = events[0]!;
    assert.equal(e.type, "hover_viewed");
    if (e.type !== "hover_viewed") throw new Error("type guard");
    assert.equal(e.entryAgeMs, 500_000);
    assert.equal(e.hasLink, true);
  });

  test("emitPromptDismissed stores stage when provided", async () => {
    const { service, events } = makeService(true);
    await service.emitPromptDismissed("note");
    assert.equal(events.length, 1);
    const e = events[0]!;
    assert.equal(e.type, "prompt_dismissed");
    if (e.type !== "prompt_dismissed") throw new Error("type guard");
    assert.equal(e.stage, "note");
  });

  test("emitPromptDismissed without stage omits stage field", async () => {
    const { service, events } = makeService(true);
    await service.emitPromptDismissed();
    assert.equal(events.length, 1);
    const e = events[0]!;
    if (e.type !== "prompt_dismissed") throw new Error("type guard");
    assert.equal(e.stage, undefined);
  });

  test("emitNagIgnored stores correct item count", async () => {
    const { service, events } = makeService(true);
    await service.emitNagIgnored(5);
    assert.equal(events.length, 1);
    const e = events[0]!;
    assert.equal(e.type, "nag_ignored");
    if (e.type !== "nag_ignored") throw new Error("type guard");
    assert.equal(e.itemCount, 5);
  });

  test("multiple emits append all events", async () => {
    const { service, events } = makeService(true);
    await service.emitAnnotationAdded(10, "ai", true);
    await service.emitHoverViewed(1000, false);
    await service.emitPromptDismissed("severity");
    assert.equal(events.length, 3);
  });
});

describe("TelemetryService — disabled (telemetry opt-out)", () => {
  test("emitAnnotationAdded does nothing when telemetry is disabled", async () => {
    const { service, events } = makeService(false);
    await service.emitAnnotationAdded(42, "human", false);
    assert.equal(events.length, 0, "no events should be emitted when disabled");
  });

  test("emitHoverViewed does nothing when disabled", async () => {
    const { service, events } = makeService(false);
    await service.emitHoverViewed(1000, true);
    assert.equal(events.length, 0);
  });

  test("emitPromptDismissed does nothing when disabled", async () => {
    const { service, events } = makeService(false);
    await service.emitPromptDismissed("note");
    assert.equal(events.length, 0);
  });

  test("emitNagIgnored does nothing when disabled", async () => {
    const { service, events } = makeService(false);
    await service.emitNagIgnored(3);
    assert.equal(events.length, 0);
  });
});
