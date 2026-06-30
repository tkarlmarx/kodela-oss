// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FileNode, ExplorerView } from "./explorer-view.js";
import type { ContextEntry } from "@kodela/core";
import type { KodelaWorkspace } from "../workspace/kodela-workspace.js";

const HASH = "b".repeat(64);

function makeEntry(overrides: Partial<ContextEntry> & { id: string }): ContextEntry {
  return {
    schemaVersion: "1.1.0",
    id: overrides.id,
    filePath: overrides.filePath ?? "src/auth.ts",
    astAnchor: null,
    contentHash: HASH,
    lineRange: overrides.lineRange ?? { start: 1, end: 10 },
    note: overrides.note ?? "Test note",
    author: "alice",
    createdAt: "2024-01-15T00:00:00.000Z",
    updatedAt: "2024-03-02T00:00:00.000Z",
    severity: overrides.severity ?? "medium",
    tags: [],
    source: "human",
    confidence: 0.9,
    status: overrides.status ?? "mapped",
    reviewRequired: false,
  };
}

describe("FileNode", () => {
  test("uses File icon and kodelaFile contextValue when not AI-changed", () => {
    const node = new FileNode("src/auth.ts", "/repo/src/auth.ts", []);
    assert.equal(node.contextValue, "kodelaFile");
    const icon = node.iconPath as { id: string; color?: { id: string } };
    assert.equal(icon.id, "file");
    assert.equal(icon.color, undefined);
  });

  test("uses warning icon and kodelaFileAIChanged contextValue when AI-changed", () => {
    const node = new FileNode("src/auth.ts", "/repo/src/auth.ts", [], true);
    assert.equal(node.contextValue, "kodelaFileAIChanged");
    const icon = node.iconPath as { id: string; color?: { id: string } };
    assert.equal(icon.id, "warning");
    assert.ok(icon.color !== undefined, "icon should have a color");
    assert.equal(icon.color?.id, "editorInfo.foreground");
  });

  test("description includes ⚡ AI-changed when AI-changed (no directory)", () => {
    const node = new FileNode("auth.ts", "/repo/auth.ts", [], true);
    assert.ok(
      String(node.description).includes("⚡ AI-changed"),
      `expected description to include '⚡ AI-changed', got: ${String(node.description)}`,
    );
  });

  test("description includes ⚡ AI-changed alongside directory when AI-changed (with dir)", () => {
    const node = new FileNode("src/auth.ts", "/repo/src/auth.ts", [], true);
    const desc = String(node.description);
    assert.ok(desc.includes("src"), "description should include directory");
    assert.ok(desc.includes("⚡ AI-changed"), "description should include AI-changed marker");
  });

  test("description is the directory path (no ⚡) when not AI-changed (with dir)", () => {
    const node = new FileNode("src/auth.ts", "/repo/src/auth.ts", []);
    assert.equal(node.description, "src");
  });

  test("description is empty string when not AI-changed and file is at root", () => {
    const node = new FileNode("auth.ts", "/repo/auth.ts", []);
    assert.equal(node.description, "");
  });

  test("isAIChanged defaults to false", () => {
    const node = new FileNode("src/auth.ts", "/repo/src/auth.ts", []);
    assert.equal(node.contextValue, "kodelaFile");
    const icon = node.iconPath as { id: string };
    assert.equal(icon.id, "file");
  });

  test("preserves relPath, absPath, entryNodes regardless of AI flag", () => {
    const nodeNormal = new FileNode("src/a.ts", "/repo/src/a.ts", []);
    const nodeAI = new FileNode("src/a.ts", "/repo/src/a.ts", [], true);
    assert.equal(nodeNormal.relPath, "src/a.ts");
    assert.equal(nodeNormal.absPath, "/repo/src/a.ts");
    assert.equal(nodeAI.relPath, "src/a.ts");
    assert.equal(nodeAI.absPath, "/repo/src/a.ts");
  });

  test("label is the file basename", () => {
    const node = new FileNode("src/deeply/nested/auth.ts", "/repo/src/deeply/nested/auth.ts", []);
    assert.equal(node.label, "auth.ts");
  });

  test("tooltip is the relative path", () => {
    const node = new FileNode("src/auth.ts", "/repo/src/auth.ts", []);
    assert.equal(node.tooltip, "src/auth.ts");
  });

  test("ExplorerView getChildren reflects AI-change on FileNode when workspace flags file", async () => {
    const absPath = "/repo/src/flagged.ts";
    const relPath = "src/flagged.ts";

    const entry = makeEntry({ id: "e1", filePath: relPath });

    const stubWorkspace = {
      onDidChange: (_listener: () => void) => ({ dispose: () => {} }),
      allEntries: [entry] as ReadonlyArray<ContextEntry>,
      getEntriesForFile: () => [],
      repoRoot: "/repo",
      config: {},
      isFileLikelyAIChanged: (p: string) => p === absPath,
    } as unknown as import("../workspace/kodela-workspace.js").KodelaWorkspace;

    const view = new ExplorerView(stubWorkspace);
    const roots = view.getChildren() as Awaited<ReturnType<typeof view.getChildren>>;
    const allFilesRoot = findRootByPrefix(roots, "All Files");
    assert.ok(allFilesRoot, "All Files root should exist");
    const fileChildren = view.getChildren(allFilesRoot);
    const fileNode = fileChildren.find(
      (n): n is FileNode => n instanceof FileNode && n.relPath === relPath,
    );

    assert.ok(fileNode !== undefined, "expected to find a FileNode for src/flagged.ts");
    assert.equal(fileNode.contextValue, "kodelaFileAIChanged");
    assert.ok(String(fileNode.description).includes("⚡ AI-changed"));

    view.dispose();
  });
});

function makeStubWorkspace(entries: ReadonlyArray<ContextEntry> = []): KodelaWorkspace {
  return {
    onDidChange: (_listener: () => void) => ({ dispose: () => {} }),
    allEntries: entries,
    getEntriesForFile: () => [],
    repoRoot: "/repo",
    isFileLikelyAIChanged: () => false,
  } as unknown as KodelaWorkspace;
}

function findRootByPrefix(
  roots: ReturnType<ExplorerView["getChildren"]>,
  prefix: string,
): (typeof roots)[number] | undefined {
  return roots.find((node) =>
    String((node as { label?: string }).label ?? "").startsWith(prefix),
  );
}

describe("ExplorerView", () => {
  test("empty workspace returns quick actions, current file, and all files roots", () => {
    const view = new ExplorerView(makeStubWorkspace());
    const roots = view.getChildren();
    assert.equal(roots.length, 3, "should have Quick Actions, Current File root, and All Files root");

    const quickActionsRoot = findRootByPrefix(roots, "Quick Actions");
    const currentFileRoot = findRootByPrefix(roots, "Current File");
    const allFilesRoot = findRootByPrefix(roots, "All Files");

    assert.ok(quickActionsRoot, "Quick Actions root should exist");
    assert.ok(currentFileRoot, "Current File root should exist");
    assert.ok(allFilesRoot, "All Files root should exist");

    const quickActionsChildren = view.getChildren(quickActionsRoot);
    assert.ok(quickActionsChildren.length > 0, "Quick Actions root should expose action nodes");

    const currentFileChildren = view.getChildren(currentFileRoot);
    assert.equal(currentFileChildren.length, 0, "Current File root should have no children when no active editor");

    const allFilesChildren = view.getChildren(allFilesRoot);
    assert.equal(allFilesChildren.length, 0, "All Files root should have no file nodes when entries is empty");

    view.dispose();
  });

  test("quick actions root exposes discoverable workflow commands", () => {
    const view = new ExplorerView(makeStubWorkspace());
    const roots = view.getChildren();
    const quickActionsRoot = findRootByPrefix(roots, "Quick Actions");
    assert.ok(quickActionsRoot, "Quick Actions root should exist");

    const nodes = view.getChildren(quickActionsRoot);
    const commandIds = nodes
      .map((n) => (n as { command?: { command?: string } }).command?.command)
      .filter((c): c is string => !!c);

    assert.ok(commandIds.includes("kodela.init"));
    assert.ok(commandIds.includes("kodela.add"));
    assert.ok(commandIds.includes("kodela.explain"));
    assert.ok(commandIds.includes("kodela.showStatus"));
    assert.ok(commandIds.includes("kodela.heal"));
    assert.ok(commandIds.includes("kodela.showLog"));

    view.dispose();
  });

  test("entries are grouped under their file path in the All Files root", () => {
    const entries: ContextEntry[] = [
      makeEntry({ id: "a1", filePath: "src/a.ts", lineRange: { start: 1, end: 5 } }),
      makeEntry({ id: "a2", filePath: "src/a.ts", lineRange: { start: 10, end: 15 } }),
      makeEntry({ id: "b1", filePath: "src/b.ts", lineRange: { start: 3, end: 3 } }),
    ];

    const view = new ExplorerView(makeStubWorkspace(entries));
    const roots = view.getChildren();
    const allFilesRoot = findRootByPrefix(roots, "All Files");
    assert.ok(allFilesRoot, "All Files root should exist");
    const fileNodes = view.getChildren(allFilesRoot);

    assert.equal(fileNodes.length, 2, "should have one FileNode per file");

    const aNode = fileNodes.find((n): n is FileNode => n instanceof FileNode && n.relPath === "src/a.ts");
    const bNode = fileNodes.find((n): n is FileNode => n instanceof FileNode && n.relPath === "src/b.ts");

    assert.ok(aNode !== undefined, "FileNode for src/a.ts should exist");
    assert.ok(bNode !== undefined, "FileNode for src/b.ts should exist");
    assert.equal(aNode!.entryNodes.length, 2, "src/a.ts should have 2 entry nodes");
    assert.equal(bNode!.entryNodes.length, 1, "src/b.ts should have 1 entry node");

    view.dispose();
  });

  test("setSortMode('severity') reorders entries in All Files root by severity", () => {
    const entries: ContextEntry[] = [
      makeEntry({ id: "low1", filePath: "src/a.ts", severity: "low", lineRange: { start: 1, end: 2 } }),
      makeEntry({ id: "crit1", filePath: "src/a.ts", severity: "critical", lineRange: { start: 3, end: 4 } }),
      makeEntry({ id: "med1", filePath: "src/a.ts", severity: "medium", lineRange: { start: 5, end: 6 } }),
    ];

    const view = new ExplorerView(makeStubWorkspace(entries));
    view.setSortMode("severity");
    assert.equal(view.getSortMode(), "severity");

    const roots = view.getChildren();
    const allFilesRoot = findRootByPrefix(roots, "All Files");
    assert.ok(allFilesRoot, "All Files root should exist");
    const fileNodes = view.getChildren(allFilesRoot);
    const fileNode = fileNodes.find((n): n is FileNode => n instanceof FileNode);
    assert.ok(fileNode !== undefined, "expected a FileNode under All Files");

    const entryNodes = view.getChildren(fileNode);
    assert.equal(entryNodes.length, 3, "expected 3 entry nodes");

    const descriptions = entryNodes.map((n) => String((n as { description?: string }).description ?? ""));
    assert.equal(descriptions[0], "[critical]", "first entry after severity sort should be critical");
    assert.equal(descriptions[1], "[medium]", "second entry should be medium");
    assert.equal(descriptions[2], "[low]", "third entry should be low");

    view.dispose();
  });

  test("onDidChangeTreeData fires after setSortMode and after workspace onDidChange", () => {
    let changeListenerRef: (() => void) | null = null;
    const ws = {
      onDidChange: (listener: () => void) => {
        changeListenerRef = listener;
        return { dispose: () => {} };
      },
      allEntries: [] as ReadonlyArray<ContextEntry>,
      getEntriesForFile: () => [],
      repoRoot: "/repo",
      isFileLikelyAIChanged: () => false,
    } as unknown as KodelaWorkspace;

    const view = new ExplorerView(ws);

    let fireCount = 0;
    view.onDidChangeTreeData(() => { fireCount++; });

    view.setSortMode("status");
    assert.equal(fireCount, 1, "onDidChangeTreeData should fire once after setSortMode");

    assert.ok(changeListenerRef !== null, "workspace.onDidChange listener should have been registered");
    (changeListenerRef as () => void)();
    assert.equal(fireCount, 2, "onDidChangeTreeData should fire again when workspace changes");

    view.dispose();
  });
});
