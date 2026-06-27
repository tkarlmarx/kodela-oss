// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ControlCenterView } from "./control-center-view.js";

describe("ControlCenterView", () => {
  test("exposes grouped non-technical action roots", () => {
    const view = new ControlCenterView();
    const roots = view.getChildren();

    const labels = roots.map((n) => String((n as { label?: string }).label ?? ""));
    assert.equal(roots.length, 4, "expected Lifecycle, Metadata, Integrations, Configuration roots");
    assert.ok(labels.includes("Lifecycle"));
    assert.ok(labels.includes("Metadata"));
    assert.ok(labels.includes("Integrations"));
    assert.ok(labels.includes("Configuration"));

    view.dispose();
  });

  test("includes requested operational commands in action nodes", () => {
    const view = new ControlCenterView();
    const roots = view.getChildren();

    const commandIds: string[] = [];
    for (const root of roots) {
      const children = view.getChildren(root);
      for (const node of children) {
        const command = (node as { command?: { command?: string } }).command?.command;
        if (command) commandIds.push(command);
      }
    }

    assert.ok(commandIds.includes("kodela.setup"));
    assert.ok(commandIds.includes("kodela.watchStart"));
    assert.ok(commandIds.includes("kodela.watchStop"));
    assert.ok(commandIds.includes("kodela.watchStatus"));
    assert.ok(commandIds.includes("kodela.showCurrentMetadata"));
    assert.ok(commandIds.includes("kodela.openLinkedUrl"));
    assert.ok(commandIds.includes("kodela.mcpStart"));
    assert.ok(commandIds.includes("kodela.mcpStatus"));
    assert.ok(commandIds.includes("kodela.configureProxyVariables"));

    view.dispose();
  });

  test("shows pending auto-watch indicator by default", () => {
    const view = new ControlCenterView();
    const roots = view.getChildren();
    const lifecycleRoot = roots.find(
      (n) => String((n as { label?: string }).label ?? "") === "Lifecycle",
    );

    assert.ok(lifecycleRoot, "Lifecycle root should exist");

    const lifecycleChildren = view.getChildren(lifecycleRoot);
    const indicator = lifecycleChildren.find(
      (n) => String((n as { label?: string }).label ?? "") === "AI Auto-Watch",
    ) as
      | {
          description?: string;
          command?: unknown;
        }
      | undefined;

    assert.ok(indicator, "AI Auto-Watch indicator should exist");
    assert.equal(
      indicator?.description,
      "Waiting for first activation/setup check",
    );
    assert.equal(indicator?.command, undefined);

    view.dispose();
  });

  test("renders skip reason for non-AI auto-watch decision", () => {
    const view = new ControlCenterView();
    view.setAutoWatchIndicator({
      trigger: "activation",
      decision: "non-ai-context",
      reason: "no AI tool context detected (attribution or installed extension)",
    });

    const roots = view.getChildren();
    const lifecycleRoot = roots.find(
      (n) => String((n as { label?: string }).label ?? "") === "Lifecycle",
    );

    assert.ok(lifecycleRoot, "Lifecycle root should exist");

    const lifecycleChildren = view.getChildren(lifecycleRoot);
    const indicator = lifecycleChildren.find(
      (n) => String((n as { label?: string }).label ?? "") === "AI Auto-Watch",
    ) as
      | {
          description?: string;
          tooltip?: string;
        }
      | undefined;

    assert.ok(indicator, "AI Auto-Watch indicator should exist");
    assert.equal(indicator?.description, "Skipped: no AI context");
    assert.equal(
      indicator?.tooltip,
      "Last check (activation): no AI tool context detected (attribution or installed extension)",
    );

    view.dispose();
  });
});
