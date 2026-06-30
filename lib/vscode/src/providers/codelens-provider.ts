// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import * as vscode from "vscode";
import type { ContextEntry } from "@kodela/core";
import type { KodelaWorkspace } from "../workspace/kodela-workspace.js";

export class KodelaCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly _onDidChangeCodeLenses =
    new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> =
    this._onDidChangeCodeLenses.event;

  private readonly _disposables: vscode.Disposable[] = [];

  constructor(private readonly _workspace: KodelaWorkspace) {
    this._disposables.push(
      _workspace.onDidChange(() => this._onDidChangeCodeLenses.fire()),
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const cfg = vscode.workspace.getConfiguration("kodela");
    if (!cfg.get<boolean>("enable", true)) return [];
    if (!cfg.get<boolean>("showCodeLens", true)) return [];

    const entries = this._workspace.getEntriesForFile(document.uri.fsPath);

    if (entries.length === 0) {
      const range = new vscode.Range(0, 0, 0, 0);
      return [
        new vscode.CodeLens(range, {
          title: "$(add) Kodela: add annotation",
          command: "kodela.add",
          tooltip: "Add a Kodela annotation for this file",
        }),
      ];
    }

    const byStartLine = groupByStartLine(entries);
    const lenses: vscode.CodeLens[] = [];

    for (const [startLine0, group] of byStartLine) {
      const range = new vscode.Range(startLine0, 0, startLine0, 0);

      if (group.length === 1) {
        const entry = group[0]!;
        const truncatedNote =
          entry.note.length > 50 ? `${entry.note.slice(0, 47)}…` : entry.note;
        lenses.push(
          new vscode.CodeLens(range, {
            title: `⚑ ${truncatedNote}`,
            command: "kodela.revealInExplorer",
            tooltip: `Open Kodela Explorer — ${entry.note}`,
            arguments: [entry.id],
          }),
        );
      } else {
        const ids = group.map((e) => e.id);
        lenses.push(
          new vscode.CodeLens(range, {
            title: `⚑ ${group.length} annotation(s)`,
            command: "kodela.revealInExplorer",
            tooltip: `${group.length} Kodela annotations at this location`,
            arguments: [ids[0]],
          }),
        );
      }
    }

    return lenses;
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
    for (const d of this._disposables) d.dispose();
  }
}

function groupByStartLine(
  entries: ContextEntry[],
): Map<number, ContextEntry[]> {
  const map = new Map<number, ContextEntry[]>();
  for (const entry of entries) {
    const line0 = Math.max(0, entry.lineRange.start - 1);
    const existing = map.get(line0) ?? [];
    existing.push(entry);
    map.set(line0, existing);
  }
  return map;
}
