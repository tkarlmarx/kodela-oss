// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { runInit } from "@kodela/cli";
import { _testFireExecuteCommand } from "../__mocks__/vscode.js";

type GetFn = (key: string, defaultVal?: unknown) => unknown;

function withConfig(overrides: Record<string, unknown>, fn: GetFn): GetFn {
  return (key: string, defaultVal?: unknown) =>
    key in overrides ? overrides[key] : fn(key, defaultVal);
}

describe("KodelaWorkspace.getAiToolAttribution()", () => {
  let tmpDir: string;
  let ws: import("./kodela-workspace.js").KodelaWorkspace;
  let subs: { dispose(): void }[];
  let vscode: typeof import("vscode");

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-attr-"));
    await runInit(tmpDir);

    vscode = await import("vscode");
    Object.defineProperty(
      (vscode as { workspace: typeof vscode.workspace }).workspace,
      "workspaceFolders",
      {
        value: [{ uri: { fsPath: tmpDir }, name: "test", index: 0 }],
        configurable: true,
        writable: true,
      },
    );

    const { KodelaWorkspace } = await import("./kodela-workspace.js");
    subs = [];
    ws = await KodelaWorkspace.create(
      { subscriptions: subs } as unknown as import("vscode").ExtensionContext,
    );
  });

  after(() => {
    ws?.dispose();
    for (const s of subs ?? []) s.dispose();
    if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("returns undefined when preferredAiTool is 'none'", () => {
    const origGetConfig = vscode.workspace.getConfiguration;
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
      get: withConfig({ preferredAiTool: "none" }, (k, d) => d),
      has: () => false,
      inspect: () => undefined,
      update: async () => {},
    });
    try {
      const result = ws.getAiToolAttribution();
      assert.equal(result, undefined);
    } finally {
      (vscode.workspace as { getConfiguration: unknown }).getConfiguration = origGetConfig;
    }
  });

  test("returns undefined when preferredAiTool is 'NONE' (case-insensitive)", () => {
    const origGetConfig = vscode.workspace.getConfiguration;
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
      get: withConfig({ preferredAiTool: "NONE" }, (k, d) => d),
      has: () => false,
      inspect: () => undefined,
      update: async () => {},
    });
    try {
      const result = ws.getAiToolAttribution();
      assert.equal(result, undefined);
    } finally {
      (vscode.workspace as { getConfiguration: unknown }).getConfiguration = origGetConfig;
    }
  });

  test("returns pinned tool attribution when preferredAiTool is 'copilot'", () => {
    const origGetConfig = vscode.workspace.getConfiguration;
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
      get: withConfig({ preferredAiTool: "copilot" }, (k, d) => d),
      has: () => false,
      inspect: () => undefined,
      update: async () => {},
    });
    try {
      const result = ws.getAiToolAttribution();
      assert.ok(result !== undefined);
      assert.equal(result!.aiTool, "copilot");
      assert.equal(result!.link, "https://github.com/features/copilot");
    } finally {
      (vscode.workspace as { getConfiguration: unknown }).getConfiguration = origGetConfig;
    }
  });

  test("returns pinned tool attribution with empty link for unknown tool name", () => {
    const origGetConfig = vscode.workspace.getConfiguration;
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
      get: withConfig({ preferredAiTool: "my-custom-llm" }, (k, d) => d),
      has: () => false,
      inspect: () => undefined,
      update: async () => {},
    });
    try {
      const result = ws.getAiToolAttribution();
      assert.ok(result !== undefined);
      assert.equal(result!.aiTool, "my-custom-llm");
      assert.equal(result!.link, "");
    } finally {
      (vscode.workspace as { getConfiguration: unknown }).getConfiguration = origGetConfig;
    }
  });

  test("preferredAiTool override wins over tracker recency when set", () => {
    _testFireExecuteCommand("continue.acceptDiff");

    const origGetConfig = vscode.workspace.getConfiguration;
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
      get: withConfig({ preferredAiTool: "copilot" }, (k, d) => d),
      has: () => false,
      inspect: () => undefined,
      update: async () => {},
    });
    try {
      const result = ws.getAiToolAttribution();
      assert.ok(result !== undefined);
      assert.equal(result!.aiTool, "copilot", "preferredAiTool pin should win over tracker");
    } finally {
      (vscode.workspace as { getConfiguration: unknown }).getConfiguration = origGetConfig;
    }
  });

  test("falls back to tracker recency when preferredAiTool is null (unset)", () => {
    _testFireExecuteCommand("github.copilot.generate");

    const origGetConfig = vscode.workspace.getConfiguration;
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
      get: withConfig({ preferredAiTool: null, aiDetectionWindowMs: 60_000 }, (k, d) => d),
      has: () => false,
      inspect: () => undefined,
      update: async () => {},
    });
    try {
      const result = ws.getAiToolAttribution();
      assert.ok(result !== undefined);
      assert.equal(result!.aiTool, "copilot");
    } finally {
      (vscode.workspace as { getConfiguration: unknown }).getConfiguration = origGetConfig;
    }
  });

  test("returns undefined when preferredAiTool is null and window is 0ms (no recency)", () => {
    _testFireExecuteCommand("continue.acceptDiff");

    const origGetConfig = vscode.workspace.getConfiguration;
    (vscode.workspace as { getConfiguration: unknown }).getConfiguration = () => ({
      get: withConfig({ preferredAiTool: null, aiDetectionWindowMs: 0 }, (k, d) => d),
      has: () => false,
      inspect: () => undefined,
      update: async () => {},
    });
    try {
      const result = ws.getAiToolAttribution();
      assert.equal(result, undefined, "0ms window should exclude all tracker entries");
    } finally {
      (vscode.workspace as { getConfiguration: unknown }).getConfiguration = origGetConfig;
    }
  });
});
