// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { runInit } from "@kodela/cli";
import type { ContextEntry } from "@kodela/core";

const HASH = "a".repeat(64);

function makeEntry(overrides: Partial<ContextEntry> & { id: string }): ContextEntry {
  return {
    schemaVersion: "1.1.0",
    id: overrides.id,
    filePath: overrides.filePath ?? "src/auth.ts",
    astAnchor: null,
    contentHash: HASH,
    lineRange: overrides.lineRange ?? { start: 5, end: 10 },
    note: overrides.note ?? "Test note",
    author: "alice",
    createdAt: "2024-01-15T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-15T00:00:00.000Z",
    severity: overrides.severity ?? "medium",
    tags: [],
    source: "human",
    confidence: 0.9,
    status: overrides.status ?? "mapped",
    reviewRequired: false,
    ...(overrides.link ? { link: overrides.link } : {}),
    ...(overrides.externalRef ? { externalRef: overrides.externalRef } : {}),
  };
}

describe("kodela.revealEntry command", () => {
  let tmpDir: string;

  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("calls revealRange and sets selection on the active editor", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-cmd-reveal-"));
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

    const { registerCommands } = await import("./index.js");

    const entry = makeEntry({ id: "rev1", filePath: "src/auth.ts", lineRange: { start: 5, end: 10 } });

    const revealRangeCalls: { range: { start: { line: number }; end: { line: number } }; type: number }[] = [];
    let lastSelectionLine: number | undefined;

    const spyEditor = {
      document: {
        uri: vscode.Uri.file(path.join(tmpDir, "src/auth.ts")),
        fileName: path.join(tmpDir, "src/auth.ts"),
        lineCount: 100,
        getText: (): string => "",
      },
      get selection() { return new vscode.Selection(lastSelectionLine ?? 0, 0, lastSelectionLine ?? 0, 0); },
      set selection(v: unknown) { lastSelectionLine = (v as { start: { line: number } }).start.line; },
      selections: [],
      revealRange(range: unknown, type?: number): void {
        revealRangeCalls.push({
          range: range as { start: { line: number }; end: { line: number } },
          type: type ?? 0,
        });
      },
      edit: async (): Promise<boolean> => true,
      setDecorations: (): void => {},
    };

    const origShowTextDocument = vscode.window.showTextDocument;
    (vscode.window as { showTextDocument: unknown }).showTextDocument = async (): Promise<unknown> => spyEditor;

    const subscriptions: { dispose(): void }[] = [];
    const mockContext = { subscriptions } as unknown as import("vscode").ExtensionContext;
    const mockWorkspace = {
      repoRoot: tmpDir,
      refresh: async () => {},
      allEntries: [] as ReadonlyArray<ContextEntry>,
      config: {},
    } as unknown as import("../workspace/kodela-workspace.js").KodelaWorkspace;

    const spyChannel = {
      name: "Kodela",
      append: (): void => {},
      appendLine: (): void => {},
      replace: (): void => {},
      clear: (): void => {},
      show: (): void => {},
      hide: (): void => {},
      dispose: (): void => {},
    } as unknown as import("vscode").OutputChannel;

    registerCommands(mockContext, mockWorkspace, undefined, spyChannel);

    await vscode.commands.executeCommand("kodela.revealEntry", entry);

    assert.ok(
      revealRangeCalls.length > 0,
      "revealRange should have been called at least once",
    );
    assert.equal(
      revealRangeCalls[0].type,
      vscode.TextEditorRevealType.InCenter,
      "revealRange should use InCenter reveal type",
    );
    assert.equal(
      revealRangeCalls[0].range.start.line,
      4,
      "revealRange start line should be entry.lineRange.start - 1 = 4",
    );

    assert.ok(lastSelectionLine !== undefined, "editor.selection should have been set");
    assert.equal(lastSelectionLine, 4, "selection start line should match the annotation start");

    (vscode.window as { showTextDocument: unknown }).showTextDocument = origShowTextDocument;
    for (const d of subscriptions) d.dispose();
  });
});

describe("kodela.archive command", () => {
  let tmpDir: string;

  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("shows warning modal and short-circuits when user dismisses", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-cmd-archive-"));
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

    const { runAdd } = await import("@kodela/cli");
    await runAdd({
      repoRoot: tmpDir,
      filePath: "src/ghost.ts",
      lineStart: 5,
      lineEnd: 10,
      note: "Ghost annotation",
      severity: "medium",
      source: "human",
      tags: [],
    });
    const objectsDir = path.join(tmpDir, ".kodela", "objects");
    const objectFiles = await fs.readdir(objectsDir);
    const entryFilePath = path.join(objectsDir, objectFiles[0]);
    const entryRaw = JSON.parse(await fs.readFile(entryFilePath, "utf-8"));
    entryRaw.status = "orphaned";
    entryRaw.updatedAt = "2020-01-01T00:00:00.000Z";
    await fs.writeFile(entryFilePath, JSON.stringify(entryRaw));

    let warningModalCalls = 0;
    const origShowWarning = vscode.window.showWarningMessage;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = async (): Promise<undefined> => {
      warningModalCalls++;
      return undefined;
    };

    const { registerCommands } = await import("./index.js");

    let refreshCalls = 0;
    const spyChannel = {
      name: "Kodela",
      append: (): void => {},
      appendLine: (): void => {},
      replace: (): void => {},
      clear: (): void => {},
      show: (): void => {},
      hide: (): void => {},
      dispose: (): void => {},
    } as unknown as import("vscode").OutputChannel;

    const subscriptions: { dispose(): void }[] = [];
    const mockContext = { subscriptions } as unknown as import("vscode").ExtensionContext;
    const mockWorkspace = {
      repoRoot: tmpDir,
      refresh: async (): Promise<void> => { refreshCalls++; },
      allEntries: [] as ReadonlyArray<ContextEntry>,
      config: {},
    } as unknown as import("../workspace/kodela-workspace.js").KodelaWorkspace;

    registerCommands(mockContext, mockWorkspace, undefined, spyChannel);

    await vscode.commands.executeCommand("kodela.archive");

    assert.ok(
      warningModalCalls > 0,
      `expected showWarningMessage to be called at least once (called ${warningModalCalls} times)`,
    );
    assert.equal(
      refreshCalls,
      0,
      "workspace.refresh should not have been called when user dismisses the archive modal",
    );

    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = origShowWarning;
    for (const d of subscriptions) d.dispose();
  });
});

describe("kodela.openLinkedUrl command", () => {
  let tmpDir: string;

  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("opens external link for the provided annotation entry", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-cmd-url-"));
    await runInit(tmpDir);

    const vscode = await import("vscode");
    const { registerCommands } = await import("./index.js");

    let openedUrl = "";
    const origOpenExternal = vscode.env.openExternal;
    (vscode.env as { openExternal: unknown }).openExternal = async (uri: { toString(): string }) => {
      openedUrl = uri.toString();
      return true;
    };

    const subscriptions: { dispose(): void }[] = [];
    const mockContext = { subscriptions } as unknown as import("vscode").ExtensionContext;
    const mockWorkspace = {
      repoRoot: tmpDir,
      refresh: async (): Promise<void> => {},
      allEntries: [] as ReadonlyArray<ContextEntry>,
      config: {},
    } as unknown as import("../workspace/kodela-workspace.js").KodelaWorkspace;

    const spyChannel = {
      name: "Kodela",
      append: (): void => {},
      appendLine: (): void => {},
      replace: (): void => {},
      clear: (): void => {},
      show: (): void => {},
      hide: (): void => {},
      dispose: (): void => {},
    } as unknown as import("vscode").OutputChannel;

    registerCommands(mockContext, mockWorkspace, undefined, spyChannel);

    const entry = makeEntry({
      id: "url-entry",
      link: "https://example.com/work-item/123",
    });

    await vscode.commands.executeCommand("kodela.openLinkedUrl", entry);

    assert.equal(
      openedUrl,
      "https://example.com/work-item/123",
      "expected openExternal to receive the annotation link URL",
    );

    (vscode.env as { openExternal: unknown }).openExternal = origOpenExternal;
    for (const d of subscriptions) d.dispose();
  });
});

describe("kodela.showCurrentMetadata command", () => {
  let tmpDir: string;

  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("writes selected entry metadata to output channel", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-cmd-meta-"));
    await runInit(tmpDir);

    const vscode = await import("vscode");
    const { registerCommands } = await import("./index.js");

    const output: string[] = [];
    const spyChannel = {
      name: "Kodela",
      append: (): void => {},
      appendLine: (line: string): void => { output.push(line); },
      replace: (): void => {},
      clear: (): void => {},
      show: (): void => {},
      hide: (): void => {},
      dispose: (): void => {},
    } as unknown as import("vscode").OutputChannel;

    const subscriptions: { dispose(): void }[] = [];
    const mockContext = { subscriptions } as unknown as import("vscode").ExtensionContext;
    const mockWorkspace = {
      repoRoot: tmpDir,
      refresh: async (): Promise<void> => {},
      allEntries: [] as ReadonlyArray<ContextEntry>,
      config: {},
    } as unknown as import("../workspace/kodela-workspace.js").KodelaWorkspace;

    registerCommands(mockContext, mockWorkspace, undefined, spyChannel);

    const entry = makeEntry({ id: "meta-1", filePath: "src/meta.ts" });
    await vscode.commands.executeCommand("kodela.showCurrentMetadata", entry);

    const joined = output.join("\n");
    assert.ok(joined.includes("Current Kodela Metadata"));
    assert.ok(joined.includes("meta-1"));
    assert.ok(joined.includes("src/meta.ts"));

    for (const d of subscriptions) d.dispose();
  });
});

describe("ensureCopilotAutoWatch", () => {
  after(async () => {
    const vscode = await import("vscode");
    (
      vscode as unknown as {
        _testResetInstalledExtensions?: () => void;
      }
    )._testResetInstalledExtensions?.();
  });

  test("starts detached watcher with --auto-annotate when AI context is detected", async () => {
    const { ensureCopilotAutoWatch } = await import("./index.js");

    const workspace = {
      repoRoot: "/tmp/kodela-test",
      getAiToolAttribution: () => ({ aiTool: "copilot", link: "https://github.com/features/copilot" }),
    } as unknown as import("../workspace/kodela-workspace.js").KodelaWorkspace;

    let receivedArgs: string[] = [];
    let receivedEnv: Record<string, string> | undefined;
    const result = await ensureCopilotAutoWatch(workspace, {
      trigger: "activation",
      dependencies: {
        readStatus: async () => ({ state: "stopped" } as Awaited<ReturnType<typeof import("@kodela/cli").runWatchStatus>>),
        startDetach: async (opts) => {
          receivedArgs = opts.extraArgs ?? [];
          receivedEnv = opts.envOverrides;
          return {
            started: true,
            alreadyRunning: false,
            pid: 1234,
            pidFile: ".kodela/watcher.pid",
            metaFile: ".kodela/watcher.meta",
            logFile: ".kodela/watcher.log",
            reason: "started",
          };
        },
        getConfig: () =>
          ({
            get: ((_key: string, defaultVal?: unknown) => defaultVal) as import("vscode").WorkspaceConfiguration["get"],
            has: () => false,
            inspect: () => undefined,
            update: async () => {},
          }) as import("vscode").WorkspaceConfiguration,
      },
    });

    assert.equal(result.decision, "started");
    assert.deepEqual(receivedArgs, ["--auto-annotate"]);
    assert.equal(receivedEnv?.KODELA_AGENT, "copilot");
  });

  test("skips startup when watcher is already running", async () => {
    const { ensureCopilotAutoWatch } = await import("./index.js");

    const workspace = {
      repoRoot: "/tmp/kodela-test",
      getAiToolAttribution: () => ({ aiTool: "copilot", link: "https://github.com/features/copilot" }),
    } as unknown as import("../workspace/kodela-workspace.js").KodelaWorkspace;

    let startCalls = 0;
    const result = await ensureCopilotAutoWatch(workspace, {
      trigger: "setup",
      dependencies: {
        readStatus: async () =>
          ({
            state: "running",
            pid: 777,
            startedAt: new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
            uptimeMs: 1000,
            heartbeatAgeMs: 100,
            logFile: ".kodela/watcher.log",
          }) as Awaited<ReturnType<typeof import("@kodela/cli").runWatchStatus>>,
        startDetach: async () => {
          startCalls++;
          return {
            started: false,
            alreadyRunning: true,
            pid: 777,
            pidFile: ".kodela/watcher.pid",
            metaFile: ".kodela/watcher.meta",
            logFile: ".kodela/watcher.log",
            reason: "already running",
          };
        },
        getConfig: () =>
          ({
            get: ((_key: string, defaultVal?: unknown) => defaultVal) as import("vscode").WorkspaceConfiguration["get"],
            has: () => false,
            inspect: () => undefined,
            update: async () => {},
          }) as import("vscode").WorkspaceConfiguration,
      },
    });

    assert.equal(result.decision, "already-running");
    assert.equal(startCalls, 0);
  });

  test("skips startup when auto-start setting is disabled", async () => {
    const { ensureCopilotAutoWatch } = await import("./index.js");

    const workspace = {
      repoRoot: "/tmp/kodela-test",
      getAiToolAttribution: () => ({ aiTool: "copilot", link: "https://github.com/features/copilot" }),
    } as unknown as import("../workspace/kodela-workspace.js").KodelaWorkspace;

    let statusCalls = 0;
    let startCalls = 0;
    const result = await ensureCopilotAutoWatch(workspace, {
      trigger: "activation",
      dependencies: {
        readStatus: async () => {
          statusCalls++;
          return { state: "stopped" } as Awaited<ReturnType<typeof import("@kodela/cli").runWatchStatus>>;
        },
        startDetach: async () => {
          startCalls++;
          return {
            started: true,
            alreadyRunning: false,
            pid: 900,
            pidFile: ".kodela/watcher.pid",
            metaFile: ".kodela/watcher.meta",
            logFile: ".kodela/watcher.log",
            reason: "started",
          };
        },
        getConfig: () =>
          ({
            get: ((key: string, defaultVal?: unknown) =>
              key === "autoStartWatchForCopilot" ? false : defaultVal) as import("vscode").WorkspaceConfiguration["get"],
            has: () => true,
            inspect: () => undefined,
            update: async () => {},
          }) as import("vscode").WorkspaceConfiguration,
      },
    });

    assert.equal(result.decision, "disabled");
    assert.equal(statusCalls, 0);
    assert.equal(startCalls, 0);
  });

  test("uses installed AI extension fallback when attribution is unavailable", async () => {
    const vscode = await import("vscode");
    (
      vscode as unknown as {
        _testSetInstalledExtensions: (ids: readonly string[]) => void;
      }
    )._testSetInstalledExtensions(["github.copilot"]);

    const { ensureCopilotAutoWatch } = await import("./index.js");

    const workspace = {
      repoRoot: "/tmp/kodela-test",
      getAiToolAttribution: () => undefined,
    } as unknown as import("../workspace/kodela-workspace.js").KodelaWorkspace;

    const result = await ensureCopilotAutoWatch(workspace, {
      trigger: "activation",
      dependencies: {
        readStatus: async () => ({ state: "stopped" } as Awaited<ReturnType<typeof import("@kodela/cli").runWatchStatus>>),
        startDetach: async () => ({
          started: true,
          alreadyRunning: false,
          pid: 42,
          pidFile: ".kodela/watcher.pid",
          metaFile: ".kodela/watcher.meta",
          logFile: ".kodela/watcher.log",
          reason: "started",
        }),
        getConfig: () =>
          ({
            get: ((_key: string, defaultVal?: unknown) => defaultVal) as import("vscode").WorkspaceConfiguration["get"],
            has: () => false,
            inspect: () => undefined,
            update: async () => {},
          }) as import("vscode").WorkspaceConfiguration,
      },
    });

    assert.equal(result.decision, "started");

    (
      vscode as unknown as {
        _testResetInstalledExtensions: () => void;
      }
    )._testResetInstalledExtensions();
  });

  test("uses installed non-Copilot AI extension fallback when attribution is unavailable", async () => {
    const vscode = await import("vscode");
    (
      vscode as unknown as {
        _testSetInstalledExtensions: (ids: readonly string[]) => void;
      }
    )._testSetInstalledExtensions(["continue.continue"]);

    const { ensureCopilotAutoWatch } = await import("./index.js");

    const workspace = {
      repoRoot: "/tmp/kodela-test",
      getAiToolAttribution: () => undefined,
    } as unknown as import("../workspace/kodela-workspace.js").KodelaWorkspace;

    let receivedEnv: Record<string, string> | undefined;
    const result = await ensureCopilotAutoWatch(workspace, {
      trigger: "activation",
      dependencies: {
        readStatus: async () => ({ state: "stopped" } as Awaited<ReturnType<typeof import("@kodela/cli").runWatchStatus>>),
        startDetach: async (opts) => {
          receivedEnv = opts.envOverrides;
          return {
            started: true,
            alreadyRunning: false,
            pid: 52,
            pidFile: ".kodela/watcher.pid",
            metaFile: ".kodela/watcher.meta",
            logFile: ".kodela/watcher.log",
            reason: "started",
          };
        },
        getConfig: () =>
          ({
            get: ((_key: string, defaultVal?: unknown) => defaultVal) as import("vscode").WorkspaceConfiguration["get"],
            has: () => false,
            inspect: () => undefined,
            update: async () => {},
          }) as import("vscode").WorkspaceConfiguration,
      },
    });

    assert.equal(result.decision, "started");
    assert.equal(receivedEnv?.KODELA_AGENT, "continue");

    (
      vscode as unknown as {
        _testResetInstalledExtensions: () => void;
      }
    )._testResetInstalledExtensions();
  });
});
