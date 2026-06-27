// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import * as vscode from "vscode";
import type { KodelaWorkspace } from "./workspace/kodela-workspace.js";

export class StatusBarManager implements vscode.Disposable {
  private readonly _item: vscode.StatusBarItem;
  private readonly _disposables: vscode.Disposable[] = [];
  private _healing = false;

  constructor(private readonly _workspace: KodelaWorkspace) {
    this._item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this._item.command = "kodela.showStatus";
    this._item.tooltip = "Click to show Kodela status";

    this._disposables.push(
      _workspace.onDidChange(() => this._refresh()),
      _workspace.onHealingStateChange((active) => this.setHealing(active)),
    );

    this._refresh();
    this._item.show();
  }

  setHealing(active: boolean): void {
    this._healing = active;
    if (active) {
      this._item.text = "$(sync~spin) Kodela: healing\u2026";
      this._item.backgroundColor = undefined;
    } else {
      this._refresh();
    }
  }

  private _refresh(): void {
    if (this._healing) return;

    const entries = this._workspace.allEntries;

    if (entries.length === 0) {
      this._item.text = "$(circle-outline) Kodela";
      this._item.backgroundColor = undefined;
      this._item.tooltip = "Click to show Kodela status";
      return;
    }

    const totalConfidence = entries.reduce((sum, e) => sum + e.confidence, 0);
    const avgConfidence = totalConfidence / entries.length;
    const pct = (avgConfidence * 100).toFixed(1);

    const orphaned = entries.filter((e) => e.status === "orphaned").length;
    const uncertain = entries.filter((e) => e.status === "uncertain").length;

    const orphanedBadge = orphaned > 0 ? ` $(error)${orphaned}` : "";
    const uncertainBadge = uncertain > 0 ? ` $(warning)${uncertain}` : "";
    const badges = orphanedBadge + uncertainBadge;

    const tooltipParts = [`Confidence: ${pct}%`];
    if (orphaned > 0) tooltipParts.push(`Orphaned entries: ${orphaned}`);
    if (uncertain > 0) tooltipParts.push(`Uncertain entries: ${uncertain}`);
    tooltipParts.push("Click to show full status");
    this._item.tooltip = tooltipParts.join("\n");

    if (avgConfidence >= 0.8 && orphaned === 0) {
      this._item.text = `$(check) Kodela ${pct}%${badges}`;
      this._item.backgroundColor = undefined;
    } else {
      this._item.text = `$(warning) Kodela ${pct}%${badges}`;
      this._item.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
    }
  }

  dispose(): void {
    this._item.dispose();
    for (const d of this._disposables) d.dispose();
  }
}
