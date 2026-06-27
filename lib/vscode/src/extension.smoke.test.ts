// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { runInit } from "@kodela/cli";

describe("extension activation smoke test", () => {
  let tmpDir: string;

  after(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("activate() resolves without throwing given a valid repo root", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-smoke-"));
    await runInit(tmpDir);

    const { activate, deactivate } = await import("./extension.js");
    assert.equal(typeof activate, "function");
    assert.equal(typeof deactivate, "function");

    const subscriptions: { dispose: () => void }[] = [];
    const mockContext = {
      subscriptions,
      extensionUri: { fsPath: tmpDir },
      extensionPath: tmpDir,
      globalStoragePath: tmpDir,
      storagePath: tmpDir,
      logPath: tmpDir,
      extensionMode: 3,
      globalState: { get: () => undefined, update: async () => {}, keys: () => [] },
      workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] },
      secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
      environmentVariableCollection: {},
      asAbsolutePath: (p: string) => path.join(tmpDir, p),
    };

    const vscode = await import("vscode");
    Object.defineProperty((vscode as { workspace: typeof vscode.workspace }).workspace, "workspaceFolders", {
      value: [{ uri: { fsPath: tmpDir }, name: "test", index: 0 }],
      configurable: true,
      writable: true,
    });

    await assert.doesNotReject(
      async () => {
        await activate(mockContext as unknown as import("vscode").ExtensionContext);
      },
      "activate() should not throw for a valid repo root",
    );

    assert.ok(subscriptions.length > 0, "activate() should register disposables");

    deactivate();

    for (const disposable of subscriptions) {
      if (typeof disposable.dispose === "function") {
        disposable.dispose();
      }
    }
  });

  test("deactivate() can be called without error", () => {
    const { deactivate } = require("./extension.js");
    assert.doesNotThrow(() => deactivate());
  });
});

describe("KodelaWorkspace output channel logging", () => {
  let tmpDir: string;

  after(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("_healBatch() appends a [watch] healed line to the output channel after a source file change", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-log-smoke-"));
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

    const { KodelaWorkspace } = await import(
      "./workspace/kodela-workspace.js"
    );

    const lines: string[] = [];
    const spyChannel = {
      appendLine: (line: string) => { lines.push(line); },
      dispose: () => {},
      show: () => {},
    };

    const subscriptions: { dispose: () => void }[] = [];
    const mockContext = { subscriptions };

    const workspace = await KodelaWorkspace.create(
      mockContext as unknown as import("vscode").ExtensionContext,
      spyChannel as unknown as import("vscode").OutputChannel,
    );

    const firstChange = new Promise<void>((resolve) => {
      const sub = workspace.onDidChange(() => {
        resolve();
        (sub as { dispose(): void }).dispose();
      });
    });

    await new Promise((r) => setTimeout(r, 250));
    await fs.writeFile(path.join(tmpDir, "logged.ts"), "export const z = 3;\n");

    await Promise.race([
      firstChange,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("onDidChange did not fire within 3 s")),
          3000,
        ),
      ),
    ]);

    const healLine = lines.find((l) => l.includes("[watch]"));
    assert.ok(
      healLine !== undefined,
      `Expected a [watch] line in the output channel, got: ${JSON.stringify(lines)}`,
    );
    assert.match(
      healLine,
      /^\[\d{2}:\d{2}:\d{2}\] \[watch\] updated=\d+.*in 1 file \(\d+ms\)$/,
      `Log line format mismatch: "${healLine}"`,
    );

    workspace.dispose();
    for (const d of subscriptions) {
      if (typeof d.dispose === "function") d.dispose();
    }
  });
});

describe("KodelaWorkspace source-file watcher", () => {
  let tmpDir: string;

  after(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("writing a source file triggers onDidChange within the debounce window", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-watch-smoke-"));
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

    const { KodelaWorkspace } = await import(
      "./workspace/kodela-workspace.js"
    );

    const subscriptions: { dispose: () => void }[] = [];
    const mockContext = { subscriptions };

    const workspace = await KodelaWorkspace.create(
      mockContext as unknown as import("vscode").ExtensionContext,
    );

    let changeCount = 0;
    const firstExtraChange = new Promise<void>((resolve) => {
      const sub = workspace.onDidChange(() => {
        changeCount++;
        resolve();
        (sub as { dispose(): void }).dispose();
      });
    });

    await new Promise((r) => setTimeout(r, 250));

    await fs.writeFile(path.join(tmpDir, "source.ts"), "export const x = 1;\n");

    await Promise.race([
      firstExtraChange,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("onDidChange did not fire within 3 s")),
          3000,
        ),
      ),
    ]);

    assert.ok(changeCount > 0, "onDidChange fired at least once after source file write");

    workspace.dispose();
    for (const d of subscriptions) {
      if (typeof d.dispose === "function") d.dispose();
    }
  });

  test("dispose() stops the source watcher — no callbacks fire after deactivation", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-dispose-smoke-"));
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

    const { KodelaWorkspace } = await import(
      "./workspace/kodela-workspace.js"
    );

    const subscriptions: { dispose: () => void }[] = [];
    const mockContext = { subscriptions };

    const workspace = await KodelaWorkspace.create(
      mockContext as unknown as import("vscode").ExtensionContext,
    );

    await new Promise((r) => setTimeout(r, 250));

    workspace.dispose();
    for (const d of subscriptions) {
      if (typeof d.dispose === "function") d.dispose();
    }

    let firedAfterDispose = false;
    workspace.onDidChange(() => {
      firedAfterDispose = true;
    });

    await fs.writeFile(path.join(tmpDir, "post-dispose.ts"), "export const y = 2;\n");

    await new Promise((r) => setTimeout(r, 800));

    assert.equal(firedAfterDispose, false, "no onDidChange callbacks should fire after dispose()");
  });
});

describe("KodelaWorkspace error-path observability", () => {
  let tmpDir: string;

  after(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("outputChannel.show(true) is called when _healBatch catches an error", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-err-smoke-"));
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

    const { KodelaWorkspace } = await import("./workspace/kodela-workspace.js");

    const lines: string[] = [];
    let showCalls = 0;
    const spyChannel = {
      appendLine: (line: string) => { lines.push(line); },
      dispose: () => {},
      show: (_preserveFocus?: boolean) => { showCalls++; },
    };

    const subscriptions: { dispose: () => void }[] = [];
    const mockContext = { subscriptions };

    const workspace = await KodelaWorkspace.create(
      mockContext as unknown as import("vscode").ExtensionContext,
      spyChannel as unknown as import("vscode").OutputChannel,
    );

    // Wait for the watcher to be ready, then corrupt the kodela index so runHeal throws
    // (readIndex will call parseJsonFile which throws on invalid JSON).
    await new Promise((r) => setTimeout(r, 300));
    await fs.writeFile(path.join(tmpDir, ".kodela", "index.json"), "{ not valid json }");

    // The healing state change to false fires in the finally block after the error.
    const healingDone = new Promise<void>((resolve) => {
      const sub = workspace.onHealingStateChange((active) => {
        if (!active) {
          resolve();
          (sub as { dispose(): void }).dispose();
        }
      });
    });

    await fs.writeFile(path.join(tmpDir, "trigger.ts"), "export const t = 1;\n");

    await Promise.race([
      healingDone,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("onHealingStateChange(false) did not fire within 4 s")),
          4000,
        ),
      ),
    ]);

    assert.ok(
      showCalls > 0,
      `Expected outputChannel.show() to be called at least once after heal error, got ${showCalls} calls. Lines: ${JSON.stringify(lines)}`,
    );
    const errorLine = lines.find((l) => l.includes("[watch] Error during auto-heal"));
    assert.ok(
      errorLine !== undefined,
      `Expected an error log line, got: ${JSON.stringify(lines)}`,
    );
    assert.match(
      errorLine!,
      /^\[\d{2}:\d{2}:\d{2}\] \[watch\] Error during auto-heal:/,
      `Error line should carry a [HH:MM:SS] prefix: "${errorLine}"`,
    );

    workspace.dispose();
    for (const d of subscriptions) {
      if (typeof d.dispose === "function") d.dispose();
    }
  });
});
