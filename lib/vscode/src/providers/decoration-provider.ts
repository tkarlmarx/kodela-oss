// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import * as vscode from "vscode";
import path from "node:path";
import type { KodelaWorkspace } from "../workspace/kodela-workspace.js";
export { computeDecorationRanges } from "./decoration-utils.js";
export type { LineRange, DecorationRanges } from "./decoration-utils.js";
import { computeDecorationRanges } from "./decoration-utils.js";
import type { LineRange } from "./decoration-utils.js";

function makeRange(lr: LineRange): vscode.Range {
  const startLine = Math.max(0, lr.start - 1);
  const endLine = Math.max(0, lr.end - 1);
  return new vscode.Range(
    new vscode.Position(startLine, 0),
    new vscode.Position(endLine, Number.MAX_SAFE_INTEGER),
  );
}

function makeSvgUri(glyph: string, color: string): vscode.Uri {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">` +
    `<text x="8" y="12" text-anchor="middle" font-size="12" fill="${color}" font-family="sans-serif">${glyph}</text>` +
    `</svg>`;
  const b64 = Buffer.from(svg).toString("base64");
  return vscode.Uri.parse(`data:image/svg+xml;base64,${b64}`);
}

export class DecorationProvider implements vscode.Disposable {
  private readonly _mappedType: vscode.TextEditorDecorationType;
  private readonly _uncertainType: vscode.TextEditorDecorationType;
  private readonly _orphanedType: vscode.TextEditorDecorationType;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(private readonly _workspace: KodelaWorkspace) {
    const opacity = vscode.workspace
      .getConfiguration("kodela")
      .get<number>("decorationOpacity", 0.15);

    this._mappedType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: "0 0 0 2px",
      borderStyle: "solid",
      borderColor: "#4caf50",
      backgroundColor: `rgba(76,175,80,${opacity})`,
      overviewRulerColor: "#4caf50",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      gutterIconPath: makeSvgUri("✓", "#4caf50"),
      gutterIconSize: "contain",
    });

    this._uncertainType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: "0 0 0 2px",
      borderStyle: "solid",
      borderColor: "#ff9800",
      backgroundColor: `rgba(255,152,0,${opacity})`,
      overviewRulerColor: "#ff9800",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      gutterIconPath: makeSvgUri("⚠", "#ff9800"),
      gutterIconSize: "contain",
    });

    this._orphanedType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: "0 0 0 2px",
      borderStyle: "solid",
      borderColor: "#f44336",
      backgroundColor: `rgba(244,67,54,${opacity})`,
      overviewRulerColor: "#f44336",
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      gutterIconPath: makeSvgUri("✗", "#f44336"),
      gutterIconSize: "contain",
    });

    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      _workspace.onDidChange(() => this.refresh()),
    );

    this.refresh();
  }

  refresh(): void {
    const cfg = vscode.workspace.getConfiguration("kodela");
    if (!cfg.get<boolean>("enable", true) || !cfg.get<boolean>("showDecorations", true)) {
      for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(this._mappedType, []);
        editor.setDecorations(this._uncertainType, []);
        editor.setDecorations(this._orphanedType, []);
      }
      return;
    }

    for (const editor of vscode.window.visibleTextEditors) {
      const fsPath = editor.document.uri.fsPath;
      const rel = this._toRel(fsPath);
      const ranges = computeDecorationRanges(this._workspace.allEntries, rel);
      editor.setDecorations(this._mappedType, ranges.mapped.map(makeRange));
      editor.setDecorations(this._uncertainType, ranges.uncertain.map(makeRange));
      editor.setDecorations(this._orphanedType, ranges.orphaned.map(makeRange));
    }
  }

  private _toRel(absolutePath: string): string {
    return path.relative(this._workspace.repoRoot, absolutePath).replace(/\\/g, "/");
  }

  dispose(): void {
    this._mappedType.dispose();
    this._uncertainType.dispose();
    this._orphanedType.dispose();
    for (const d of this._disposables) d.dispose();
  }
}
