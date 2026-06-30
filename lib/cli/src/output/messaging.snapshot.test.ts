// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultNextStepsLines,
  renderCapturePathBlock,
  renderQuickHelp,
} from "./messaging.js";

/**
 * Snapshot tests for the shared CLI messaging contract.
 *
 * The exact rendered string is the public contract — multiple commands
 * (`init`, `setup`, `hook install`, `install-hooks`, `watch --detach`)
 * compose this output, and downstream tooling (the dashboard, future
 * enterprise reporters) parses it.  Any change here is intentional and
 * must update these snapshots in lockstep with code changes.
 */

const DOCS_URL = "https://kodela.dev/getting-started";

describe("renderCapturePathBlock — canonical snapshot contract", () => {
  test("active=hooks (the example from the spec)", () => {
    const out = renderCapturePathBlock({
      headline: "Kodela initialized",
      active: "hooks",
      hooksInstalled: true,
      watcherRunning: false,
    });
    const expected = [
      "✔ Kodela initialized",
      "",
      "Capture path:",
      "★ Claude Code hooks (installed)",
      "  → Captures prompts, sessions, and reasoning directly from Claude Code",
      "",
      "Next steps:",
      "- Run your AI workflow as usual",
      "- Inspect captured entries with: kodela explain <file>",
      "",
      "Other options:",
      "◆ Watcher (any AI tool)",
      "  kodela watch --auto-annotate --detach",
      "",
      "◇ Manual",
      '  kodela add <file> -s <line> -e <line> -n "..."',
      "",
      `Docs: ${DOCS_URL}`,
    ].join("\n");
    assert.equal(out, expected);
  });

  test("active=hooks, no headline", () => {
    const out = renderCapturePathBlock({
      active: "hooks",
      hooksInstalled: true,
      watcherRunning: false,
    });
    const expected = [
      "Capture path:",
      "★ Claude Code hooks (installed)",
      "  → Captures prompts, sessions, and reasoning directly from Claude Code",
      "",
      "Next steps:",
      "- Run your AI workflow as usual",
      "- Inspect captured entries with: kodela explain <file>",
      "",
      "Other options:",
      "◆ Watcher (any AI tool)",
      "  kodela watch --auto-annotate --detach",
      "",
      "◇ Manual",
      '  kodela add <file> -s <line> -e <line> -n "..."',
      "",
      `Docs: ${DOCS_URL}`,
    ].join("\n");
    assert.equal(out, expected);
  });

  test("active=watcher, watcher running", () => {
    const out = renderCapturePathBlock({
      active: "watcher",
      hooksInstalled: false,
      watcherRunning: true,
    });
    const expected = [
      "Capture path:",
      "★ Watcher (running)",
      "  → Auto-annotates AI changes detected in the filesystem",
      "",
      "Next steps:",
      "- Run your AI workflow as usual",
      "- Check status with: kodela watch status",
      "- Inspect captured entries with: kodela explain <file>",
      "",
      "Other options:",
      "◇ Claude Code hooks (not installed)",
      "  kodela hook install --claude",
      "",
      "◇ Manual",
      '  kodela add <file> -s <line> -e <line> -n "..."',
      "",
      `Docs: ${DOCS_URL}`,
    ].join("\n");
    assert.equal(out, expected);
  });

  test("active=watcher, hooks ALSO installed (◆ marker on hooks)", () => {
    const out = renderCapturePathBlock({
      active: "watcher",
      hooksInstalled: true,
      watcherRunning: true,
    });
    const expected = [
      "Capture path:",
      "★ Watcher (running)",
      "  → Auto-annotates AI changes detected in the filesystem",
      "",
      "Next steps:",
      "- Run your AI workflow as usual",
      "- Check status with: kodela watch status",
      "- Inspect captured entries with: kodela explain <file>",
      "",
      "Other options:",
      "◆ Claude Code hooks (installed)",
      "  → Available — prompts, sessions, and reasoning captured automatically",
      "",
      "◇ Manual",
      '  kodela add <file> -s <line> -e <line> -n "..."',
      "",
      `Docs: ${DOCS_URL}`,
    ].join("\n");
    assert.equal(out, expected);
  });

  test("active=manual", () => {
    const out = renderCapturePathBlock({
      active: "manual",
      hooksInstalled: false,
      watcherRunning: false,
    });
    const expected = [
      "Capture path:",
      "★ Manual",
      "  → Operator-driven annotation via `kodela add`",
      "",
      "Next steps:",
      "- Add a first annotation with `kodela add`",
      "- Or run `kodela setup` for guided capture-path selection",
      "",
      "Other options:",
      "◇ Claude Code hooks (not installed)",
      "  kodela hook install --claude",
      "",
      "◆ Watcher (any AI tool)",
      "  kodela watch --auto-annotate --detach",
      "",
      `Docs: ${DOCS_URL}`,
    ].join("\n");
    assert.equal(out, expected);
  });

  test("active=unset (post-init, nothing chosen yet)", () => {
    const out = renderCapturePathBlock({
      active: "unset",
      hooksInstalled: false,
      watcherRunning: false,
    });
    const expected = [
      "Capture path:",
      "◇ (none chosen yet)",
      "",
      "Next steps:",
      "- Run `kodela setup` for guided capture-path selection",
      "- Or pick a path above explicitly",
      "",
      "Other options:",
      "◇ Claude Code hooks (not installed)",
      "  kodela hook install --claude",
      "",
      "◆ Watcher (any AI tool)",
      "  kodela watch --auto-annotate --detach",
      "",
      "◇ Manual",
      '  kodela add <file> -s <line> -e <line> -n "..."',
      "",
      `Docs: ${DOCS_URL}`,
    ].join("\n");
    assert.equal(out, expected);
  });

  test("custom docsUrl is honored", () => {
    const out = renderCapturePathBlock({
      active: "hooks",
      hooksInstalled: true,
      watcherRunning: false,
      docsUrl: "https://internal.example.com/kodela",
    });
    assert.match(out, /Docs: https:\/\/internal\.example\.com\/kodela$/);
  });
});

describe("renderQuickHelp — snapshot", () => {
  test("exact contents", () => {
    const expected = [
      "Tip: run `kodela setup` for guided capture-path selection,",
      "  or `kodela doctor` to verify your installation.",
    ].join("\n");
    assert.equal(renderQuickHelp(), expected);
  });
});

describe("defaultNextStepsLines — snapshot", () => {
  test("exact ordered list embedded in kodela.config.json", () => {
    assert.deepEqual(defaultNextStepsLines(), [
      "★ Claude Code hooks (preferred) — kodela hook install --claude",
      "◆ Watcher (any AI tool)         — kodela watch --auto-annotate --detach",
      '◇ Manual                        — kodela add <file> -s <line> -e <line> -n "..."',
    ]);
  });
});
