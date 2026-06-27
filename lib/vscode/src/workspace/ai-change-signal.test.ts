// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { runInit } from "@kodela/cli";
import { _testFireOpen, _testFireSave } from "../__mocks__/vscode.js";

const OLD_CONTENT = "const x = 1;\nconst y = 2;\nconst z = 3;\n";

const AI_CONTENT = [
  "import React from 'react';",
  "import { useState, useEffect, useCallback, useMemo } from 'react';",
  "import { fetchData } from './api';",
  "import { formatDate, parseDate } from './utils';",
  "import { Button, Input, Modal, Spinner } from './components';",
  "",
  "interface DataItem { id: string; name: string; value: number; createdAt: string; }",
  "",
  "function processItems(items: DataItem[]): DataItem[] {",
  "  return items.filter(i => i.value > 0).sort((a, b) => b.value - a.value);",
  "}",
  "",
  "export const Dashboard: React.FC = () => {",
  "  const [items, setItems] = useState<DataItem[]>([]);",
  "  const [loading, setLoading] = useState(true);",
  "  const [error, setError] = useState<string | null>(null);",
  "  const [query, setQuery] = useState('');",
  "",
  "  useEffect(() => {",
  "    const load = async () => {",
  "      try {",
  "        const data = await fetchData('/api/items');",
  "        setItems(data);",
  "      } catch (e) {",
  "        setError(String(e));",
  "      } finally {",
  "        setLoading(false);",
  "      }",
  "    };",
  "    void load();",
  "  }, []);",
  "",
  "  const filtered = useMemo(",
  "    () => processItems(items).filter(i => i.name.includes(query)),",
  "    [items, query],",
  "  );",
  "",
  "  if (loading) return <Spinner />;",
  "  if (error) return <p>{error}</p>;",
  "",
  "  return (",
  "    <div>",
  "      <Input value={query} onChange={e => setQuery(e.target.value)} />",
  "      {filtered.map(item => (",
  "        <div key={item.id}>{item.name}: {item.value}</div>",
  "      ))}",
  "    </div>",
  "  );",
  "};",
  "",
  "export default Dashboard;",
].join("\n") + "\n";

function makeDoc(absPath: string, content: string) {
  return {
    uri: { scheme: "file", fsPath: absPath, path: absPath, toString: () => absPath },
    fileName: absPath,
    lineCount: content.split("\n").length,
    getText: () => content,
  };
}

describe("KodelaWorkspace AI-change signal", () => {
  let tmpDir: string;

  after(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("isFileLikelyAIChanged returns false before any save", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ai-sig-"));
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
    const ws = await KodelaWorkspace.create({ subscriptions: subs } as unknown as import("vscode").ExtensionContext);

    const absPath = path.join(tmpDir, "feature.ts");
    assert.equal(ws.isFileLikelyAIChanged(absPath), false);

    ws.dispose();
    for (const s of subs) s.dispose();
  });

  test("isFileLikelyAIChanged returns false after first save (no baseline)", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ai-sig2-"));
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
    const ws = await KodelaWorkspace.create({ subscriptions: subs } as unknown as import("vscode").ExtensionContext);

    const absPath = path.join(tmpDir, "feature.ts");
    _testFireSave(makeDoc(absPath, OLD_CONTENT));
    assert.equal(ws.isFileLikelyAIChanged(absPath), false);

    ws.dispose();
    for (const s of subs) s.dispose();
  });

  test("isFileLikelyAIChanged returns true after large AI-like rewrite and fires onDidChange", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ai-sig3-"));
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
    const ws = await KodelaWorkspace.create({ subscriptions: subs } as unknown as import("vscode").ExtensionContext);

    const absPath = path.join(tmpDir, "feature.ts");

    let changeCount = 0;
    ws.onDidChange(() => { changeCount++; });

    _testFireOpen(makeDoc(absPath, OLD_CONTENT));
    const countAfterOpen = changeCount;

    _testFireSave(makeDoc(absPath, AI_CONTENT));

    assert.ok(
      ws.isFileLikelyAIChanged(absPath),
      "file should be flagged as likely AI-changed after a large rewrite",
    );
    assert.ok(
      changeCount > countAfterOpen,
      "onDidChange should have fired after AI-change detection",
    );

    ws.dispose();
    for (const s of subs) s.dispose();
  });

  test("isFileLikelyAIChanged primes from textDocuments on activation", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ai-sig4-"));
    await runInit(tmpDir);

    const absPath = path.join(tmpDir, "preopen.ts");

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
    Object.defineProperty(
      (vscode as { workspace: typeof vscode.workspace }).workspace,
      "textDocuments",
      {
        value: [makeDoc(absPath, OLD_CONTENT)],
        configurable: true,
        writable: true,
      },
    );

    const { KodelaWorkspace } = await import("./kodela-workspace.js");
    const subs: { dispose(): void }[] = [];
    const ws = await KodelaWorkspace.create({ subscriptions: subs } as unknown as import("vscode").ExtensionContext);

    _testFireSave(makeDoc(absPath, AI_CONTENT));

    assert.ok(
      ws.isFileLikelyAIChanged(absPath),
      "file should be AI-flagged even on first save when content was primed from textDocuments at activation",
    );

    Object.defineProperty(
      (vscode as { workspace: typeof vscode.workspace }).workspace,
      "textDocuments",
      { value: [], configurable: true, writable: true },
    );

    ws.dispose();
    for (const s of subs) s.dispose();
  });
});
