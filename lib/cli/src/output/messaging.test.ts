// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  renderCapturePathBlock,
  renderQuickHelp,
  defaultNextStepsLines,
} from "./messaging.js";

describe("renderCapturePathBlock", () => {
  test("places hooks first, watcher second, manual third (canonical order)", () => {
    const out = renderCapturePathBlock({
      active: "unset",
      hooksInstalled: false,
      watcherRunning: false,
    });
    const hooksIdx = out.indexOf("Claude Code hooks");
    const watcherIdx = out.indexOf("Watcher");
    const manualIdx = out.indexOf("Manual");
    assert.ok(hooksIdx >= 0 && watcherIdx >= 0 && manualIdx >= 0);
    assert.ok(hooksIdx < watcherIdx);
    assert.ok(watcherIdx < manualIdx);
  });

  test("marks the active path with ★ and others with ◆/◇", () => {
    const hooksActive = renderCapturePathBlock({
      active: "hooks",
      hooksInstalled: true,
      watcherRunning: false,
    });
    assert.match(hooksActive, /★ Claude Code hooks/);
    assert.match(hooksActive, /◇ Manual/);

    const watcherActive = renderCapturePathBlock({
      active: "watcher",
      hooksInstalled: false,
      watcherRunning: true,
    });
    assert.match(watcherActive, /★ Watcher/);
    assert.match(watcherActive, /◇ Claude Code hooks/);
  });

  test("includes a docs URL", () => {
    const out = renderCapturePathBlock({
      active: "unset",
      hooksInstalled: false,
      watcherRunning: false,
    });
    assert.match(out, /Docs:\s+https?:\/\//);
  });

  test("respects an override docs URL", () => {
    const out = renderCapturePathBlock({
      active: "unset",
      hooksInstalled: false,
      watcherRunning: false,
      docsUrl: "https://example.com/x",
    });
    assert.match(out, /https:\/\/example\.com\/x/);
  });

  test("appends headline when provided", () => {
    const out = renderCapturePathBlock({
      active: "hooks",
      hooksInstalled: true,
      watcherRunning: false,
      headline: "Kodela initialized",
    });
    assert.match(out, /✔ Kodela initialized/);
  });
});

describe("defaultNextStepsLines", () => {
  test("returns 3 lines in hooks → watcher → manual order", () => {
    const lines = defaultNextStepsLines();
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /★ Claude Code hooks/);
    assert.match(lines[1]!, /◆ Watcher/);
    assert.match(lines[2]!, /◇ Manual/);
  });
});

describe("renderQuickHelp", () => {
  test("mentions setup and doctor", () => {
    const out = renderQuickHelp();
    assert.match(out, /kodela setup/);
    assert.match(out, /kodela doctor/);
  });
});
