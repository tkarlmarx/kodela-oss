// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import * as vscode from "vscode";
import path from "node:path";
import type { ContextEntry } from "@kodela/core";
import type { KodelaWorkspace } from "../workspace/kodela-workspace.js";

export class DiagnosticsProvider implements vscode.Disposable {
  private readonly _collection: vscode.DiagnosticCollection;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(private readonly _workspace: KodelaWorkspace) {
    this._collection = vscode.languages.createDiagnosticCollection("kodela");

    this._disposables.push(
      _workspace.onDidChange(() => this._refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this._refresh()),
    );

    this._refresh();
  }

  private _refresh(): void {
    const cfg = vscode.workspace.getConfiguration("kodela");
    if (!cfg.get<boolean>("enable", true)) {
      this._collection.clear();
      return;
    }

    const showUncertainDiagnostics = cfg.get<boolean>("showUncertainDiagnostics", false);

    const byFile = new Map<string, ContextEntry[]>();
    for (const entry of this._workspace.allEntries) {
      if (entry.status === "orphaned") {
        const absPath = path.join(this._workspace.repoRoot, entry.filePath);
        const existing = byFile.get(absPath) ?? [];
        existing.push(entry);
        byFile.set(absPath, existing);
        continue;
      }

      if (entry.status !== "uncertain" || !showUncertainDiagnostics) continue;
      const absPath = path.join(this._workspace.repoRoot, entry.filePath);
      const existing = byFile.get(absPath) ?? [];
      existing.push(entry);
      byFile.set(absPath, existing);
    }

    this._collection.clear();

    for (const [absPath, entries] of byFile) {
      const uri = vscode.Uri.file(absPath);
      const diagnostics: vscode.Diagnostic[] = entries.map((e) =>
        this._toDiagnostic(e),
      );
      this._collection.set(uri, diagnostics);
    }
  }

  private _toDiagnostic(entry: ContextEntry): vscode.Diagnostic {
    const startLine = Math.max(0, entry.lineRange.start - 1);
    const endLine = Math.max(0, entry.lineRange.end - 1);
    const range = new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, Number.MAX_SAFE_INTEGER),
    );

    const confidencePct = Math.round(entry.confidence * 100);
    let message: string;
    let severity: vscode.DiagnosticSeverity;

    if (entry.status === "orphaned") {
      message = `Kodela: annotation orphaned — "${entry.note}" — run 'kodela heal' to re-map`;
      severity = vscode.DiagnosticSeverity.Error;
    } else {
      message = `Kodela: annotation uncertain (${confidencePct}% confidence) — "${entry.note}"`;
      severity = vscode.DiagnosticSeverity.Information;
    }

    const diagnostic = new vscode.Diagnostic(range, message, severity);
    diagnostic.source = "Kodela";
    diagnostic.code = entry.id;
    return diagnostic;
  }

  dispose(): void {
    this._collection.dispose();
    for (const d of this._disposables) d.dispose();
  }
}
