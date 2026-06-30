// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { runInit } from "@kodela/cli";
import { _testFireConfigChange } from "../__mocks__/vscode.js";

function makeAffectsConfiguration(affected: string) {
  return { affectsConfiguration: (section: string) => section === affected };
}

describe("KodelaWorkspace debounce config reload", () => {
  let tmpDir: string;

  after(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("firing onDidChangeConfiguration for kodela.debounceMs does not throw", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-debounce-"));
    await runInit(tmpDir);

    const vscode = await import("vscode");
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
    const subs: { dispose(): void }[] = [];
    const ws = await KodelaWorkspace.create(
      { subscriptions: subs } as unknown as import("vscode").ExtensionContext,
    );

    assert.doesNotThrow(() => {
      _testFireConfigChange(makeAffectsConfiguration("kodela.debounceMs"));
    });

    ws.dispose();
    for (const s of subs) s.dispose();
  });

  test("new debounceMs value from configuration is applied on restart", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-debounce-val-"));
    await runInit(tmpDir);

    const vscode = await import("vscode");
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
    const subs: { dispose(): void }[] = [];
    const ws = await KodelaWorkspace.create(
      { subscriptions: subs } as unknown as import("vscode").ExtensionContext,
    );

    const initialDebounce = ws.debounceMs;

    const originalGetConfig = (vscode as { workspace: { getConfiguration: unknown } }).workspace.getConfiguration;
    (vscode as { workspace: { getConfiguration: unknown } }).workspace.getConfiguration = () => ({
      get: (key: string, def: unknown) => key === "debounceMs" ? 200 : def,
      has: () => false,
      inspect: () => undefined,
      update: async () => {},
    });

    try {
      _testFireConfigChange(makeAffectsConfiguration("kodela.debounceMs"));
      assert.equal(ws.debounceMs, 200, "debounceMs should be updated to the new config value");
      assert.notEqual(ws.debounceMs, initialDebounce, "debounceMs should differ from the initial value");
    } finally {
      (vscode as { workspace: { getConfiguration: unknown } }).workspace.getConfiguration = originalGetConfig;
    }

    ws.dispose();
    for (const s of subs) s.dispose();
  });

  test("unrelated config change does not restart the watcher", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-debounce2-"));
    await runInit(tmpDir);

    const vscode = await import("vscode");
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
    const subs: { dispose(): void }[] = [];
    const ws = await KodelaWorkspace.create(
      { subscriptions: subs } as unknown as import("vscode").ExtensionContext,
    );

    assert.doesNotThrow(() => {
      _testFireConfigChange(makeAffectsConfiguration("editor.fontSize"));
    });

    ws.dispose();
    for (const s of subs) s.dispose();
  });

  test("watcher remains functional after debounce config change — heals still fire", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-debounce3-"));
    await runInit(tmpDir);

    const vscode = await import("vscode");
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
    const subs: { dispose(): void }[] = [];
    const ws = await KodelaWorkspace.create(
      { subscriptions: subs } as unknown as import("vscode").ExtensionContext,
    );

    _testFireConfigChange(makeAffectsConfiguration("kodela.debounceMs"));

    await new Promise((r) => setTimeout(r, 300));

    const firstChange = new Promise<void>((resolve) => {
      const sub = ws.onDidChange(() => {
        resolve();
        (sub as { dispose(): void }).dispose();
      });
    });

    await fs.writeFile(path.join(tmpDir, "after-restart.ts"), "export const v = 99;\n");

    await Promise.race([
      firstChange,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("onDidChange did not fire within 4 s after watcher restart")),
          4000,
        ),
      ),
    ]);

    ws.dispose();
    for (const s of subs) s.dispose();
  });

  test("spy output channel receives the debounce-change log line on watcher restart", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-debounce-spy-"));
    await runInit(tmpDir);

    const vscode = await import("vscode");
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

    const lines: string[] = [];
    const spyChannel = {
      appendLine: (line: string) => { lines.push(line); },
      dispose: () => {},
      show: () => {},
    };

    const subs: { dispose(): void }[] = [];
    const ws = await KodelaWorkspace.create(
      { subscriptions: subs } as unknown as import("vscode").ExtensionContext,
      spyChannel as unknown as import("vscode").OutputChannel,
    );

    const originalGetConfig = (vscode as { workspace: { getConfiguration: unknown } }).workspace.getConfiguration;
    (vscode as { workspace: { getConfiguration: unknown } }).workspace.getConfiguration = () => ({
      get: (key: string, def: unknown) => key === "debounceMs" ? 750 : def,
      has: () => false,
      inspect: () => undefined,
      update: async () => {},
    });

    try {
      _testFireConfigChange(makeAffectsConfiguration("kodela.debounceMs"));

      const debounceLogLine = lines.find((l) => l.includes("[config] debounce changed to"));
      assert.ok(
        debounceLogLine !== undefined,
        `Expected a [config] debounce log line in the output channel, got: ${JSON.stringify(lines)}`,
      );
      assert.ok(
        debounceLogLine.includes("750 ms"),
        `Expected the log line to mention the new debounce value (750 ms), got: "${debounceLogLine}"`,
      );
      assert.ok(
        debounceLogLine.includes("watcher restarted"),
        `Expected the log line to say 'watcher restarted', got: "${debounceLogLine}"`,
      );
    } finally {
      (vscode as { workspace: { getConfiguration: unknown } }).workspace.getConfiguration = originalGetConfig;
    }

    ws.dispose();
    for (const s of subs) s.dispose();
  });
});
