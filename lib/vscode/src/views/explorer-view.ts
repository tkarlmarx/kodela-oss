// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import * as vscode from "vscode";
import path from "node:path";
import type { ContextEntry } from "@kodela/core";
import type { KodelaWorkspace } from "../workspace/kodela-workspace.js";

type SortMode = "file" | "severity" | "status";

const SEVERITY_ORDER: Record<ContextEntry["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const STATUS_ORDER: Record<ContextEntry["status"], number> = {
  orphaned: 0,
  uncertain: 1,
  mapped: 2,
};

export type TreeNode = RootNode | FileNode | EntryNode | ActionNode;

class ActionNode extends vscode.TreeItem {
  constructor(
    public readonly actionId: string,
    label: string,
    description: string,
    commandId: string,
    iconId: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = "kodelaAction";
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.command = {
      command: commandId,
      title: label,
    };
  }
}

type RootChildNode = FileNode | EntryNode | ActionNode;

class RootNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly children: RootChildNode[],
  ) {
    super(
      label,
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = "kodelaRoot";
  }
}

export class FileNode extends vscode.TreeItem {
  constructor(
    public readonly relPath: string,
    public readonly absPath: string,
    public readonly entryNodes: EntryNode[],
    isAIChanged: boolean = false,
  ) {
    super(
      path.basename(relPath),
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    const dirPart = path.dirname(relPath) === "." ? "" : path.dirname(relPath);
    this.description = isAIChanged
      ? (dirPart ? `${dirPart} · ⚡ AI-changed` : "⚡ AI-changed")
      : dirPart;
    this.tooltip = relPath;
    this.resourceUri = vscode.Uri.file(absPath);

    if (isAIChanged) {
      this.contextValue = "kodelaFileAIChanged";
      this.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("editorInfo.foreground"),
      );
    } else {
      this.contextValue = "kodelaFile";
      this.iconPath = vscode.ThemeIcon.File;
    }
  }
}

class EntryNode extends vscode.TreeItem {
  constructor(public readonly entry: ContextEntry) {
    const statusIcon =
      entry.status === "orphaned"
        ? "✗"
        : entry.status === "uncertain"
          ? "⚠"
          : "✓";
    const truncated =
      entry.note.length > 45 ? `${entry.note.slice(0, 42)}…` : entry.note;
    super(
      `${statusIcon} L${entry.lineRange.start}–${entry.lineRange.end} · ${truncated}`,
      vscode.TreeItemCollapsibleState.None,
    );
    this.description = `[${entry.severity}]`;
    // Gap 20d — author shown only in the hover tooltip, never in the visible
    // label or description, so the Explorer reads as "notes to future you"
    // rather than a blame/surveillance tool.
    const authorLine = entry.author && entry.author !== "unknown"
      ? `\n\nAdded by ${entry.author}`
      : "";
    this.tooltip = new vscode.MarkdownString(
      `**${entry.note}**\n\nSeverity: ${entry.severity} · Confidence: ${Math.round(entry.confidence * 100)}%${authorLine}`,
    );
    this.contextValue = "kodelaEntry";

    this.command = {
      command: "kodela.revealEntry",
      title: "Go to annotation",
      arguments: [entry],
    };

    if (entry.status === "orphaned") {
      this.iconPath = new vscode.ThemeIcon(
        "error",
        new vscode.ThemeColor("errorForeground"),
      );
    } else if (entry.status === "uncertain") {
      this.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("editorWarning.foreground"),
      );
    } else {
      this.iconPath = new vscode.ThemeIcon(
        "check",
        new vscode.ThemeColor("testing.iconPassed"),
      );
    }
  }
}

export class ExplorerView
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | void> =
    this._onDidChangeTreeData.event;

  private readonly _disposables: vscode.Disposable[] = [];
  private _sortMode: SortMode = "file";

  private _treeView?: vscode.TreeView<TreeNode>;
  private readonly _nodeCache = new Map<string, EntryNode>();
  private readonly _parentMap = new WeakMap<TreeNode, TreeNode>();
  private _selectedEntry?: ContextEntry;

  constructor(private readonly _workspace: KodelaWorkspace) {
    this._disposables.push(
      _workspace.onDidChange(() => this._onDidChangeTreeData.fire()),
      vscode.window.onDidChangeActiveTextEditor(() =>
        this._onDidChangeTreeData.fire(),
      ),
    );
  }

  setTreeView(treeView: vscode.TreeView<TreeNode>): void {
    this._treeView = treeView;
    this._disposables.push(
      treeView.onDidChangeSelection((event) => {
        const selected = event.selection.find(
          (node): node is EntryNode => node instanceof EntryNode,
        );
        this._selectedEntry = selected?.entry;
      }),
    );
  }

  getSelectedEntry(): ContextEntry | undefined {
    return this._selectedEntry;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getParent(element: TreeNode): TreeNode | undefined {
    return this._parentMap.get(element);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this._buildRoots();
    }
    if (element instanceof RootNode) {
      return element.children;
    }
    if (element instanceof FileNode) {
      return element.entryNodes;
    }
    return [];
  }

  async revealEntry(entryId: string): Promise<void> {
    const node = this._nodeCache.get(entryId);
    if (!node || !this._treeView) return;
    await vscode.commands.executeCommand("kodelaExplorer.focus");
    await this._treeView.reveal(node, { select: true, focus: false, expand: true });
  }

  setSortMode(mode: SortMode): void {
    this._sortMode = mode;
    this._onDidChangeTreeData.fire();
  }

  getSortMode(): SortMode {
    return this._sortMode;
  }

  private _buildRoots(): RootNode[] {
    this._nodeCache.clear();

    const quickActionsRoot = this._buildQuickActionsRoot();

    const activeEditor = vscode.window.activeTextEditor;
    const currentFileEntries = activeEditor
      ? this._workspace.getEntriesForFile(activeEditor.document.uri.fsPath)
      : [];

    const sorted = this._sortEntries(currentFileEntries);
    const currentFileNodes = sorted.map((e) => {
      const n = new EntryNode(e);
      this._nodeCache.set(e.id, n);
      return n;
    });
    const activeLabel = activeEditor
      ? `Current File (${path.basename(activeEditor.document.uri.fsPath)})`
      : "Current File";

    const currentFileRoot = new RootNode(activeLabel, currentFileNodes);
    for (const n of currentFileNodes) this._parentMap.set(n, currentFileRoot);

    const allFilesRoot = this._buildAllFilesRoot(
      this._workspace.allEntries,
      currentFileRoot,
    );

    return [quickActionsRoot, currentFileRoot, allFilesRoot];
  }

  private _buildQuickActionsRoot(): RootNode {
    const actionNodes: ActionNode[] = [
      new ActionNode(
        "init",
        "Initialize Repository",
        "Set up Kodela in this repo",
        "kodela.init",
        "add",
      ),
      new ActionNode(
        "add",
        "Add Annotation",
        "Annotate selected code with context",
        "kodela.add",
        "comment",
      ),
      new ActionNode(
        "explain",
        "Explain Current File",
        "Show annotations for active file",
        "kodela.explain",
        "info",
      ),
      new ActionNode(
        "status",
        "Show Status",
        "Open confidence and mapping status",
        "kodela.showStatus",
        "pulse",
      ),
      new ActionNode(
        "heal",
        "Heal Annotations",
        "Re-map annotations after code edits",
        "kodela.heal",
        "sync",
      ),
      new ActionNode(
        "watch",
        "Open Watch Log",
        "View auto-heal and watcher output",
        "kodela.showLog",
        "output",
      ),
    ];

    const quickRoot = new RootNode("Quick Actions", actionNodes);
    for (const node of actionNodes) {
      this._parentMap.set(node, quickRoot);
    }
    return quickRoot;
  }

  private _buildAllFilesRoot(
    entries: ReadonlyArray<ContextEntry>,
    _currentRoot: RootNode,
  ): RootNode {
    const sorted = this._sortEntries([...entries]);
    const byFile = new Map<string, ContextEntry[]>();
    for (const entry of sorted) {
      const existing = byFile.get(entry.filePath) ?? [];
      existing.push(entry);
      byFile.set(entry.filePath, existing);
    }

    const totalEntries = entries.length;
    const totalFiles = byFile.size;
    const sortLabel =
      this._sortMode === "file"
        ? ""
        : ` · sorted by ${this._sortMode}`;
    const label = `All Files (${totalEntries} annotation${totalEntries !== 1 ? "s" : ""} across ${totalFiles} file${totalFiles !== 1 ? "s" : ""}${sortLabel})`;

    const fileNodes: FileNode[] = [];
    for (const [relPath, fileEntries] of byFile) {
      const absPath = path.join(this._workspace.repoRoot, relPath);
      const entryNodes = fileEntries.map((e) => {
        const cached = this._nodeCache.get(e.id);
        if (cached) return cached;
        const n = new EntryNode(e);
        this._nodeCache.set(e.id, n);
        return n;
      });
      const isAIChanged = this._workspace.isFileLikelyAIChanged(absPath);
      fileNodes.push(new FileNode(relPath, absPath, entryNodes, isAIChanged));
    }

    const allFilesRoot = new RootNode(label, fileNodes);
    for (const fileNode of fileNodes) {
      this._parentMap.set(fileNode, allFilesRoot);
      for (const entryNode of fileNode.entryNodes) {
        this._parentMap.set(entryNode, fileNode);
      }
    }

    return allFilesRoot;
  }

  private _sortEntries(entries: ContextEntry[]): ContextEntry[] {
    if (this._sortMode === "severity") {
      return [...entries].sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          a.filePath.localeCompare(b.filePath) ||
          a.lineRange.start - b.lineRange.start,
      );
    }
    if (this._sortMode === "status") {
      return [...entries].sort(
        (a, b) =>
          STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
          a.filePath.localeCompare(b.filePath) ||
          a.lineRange.start - b.lineRange.start,
      );
    }
    return [...entries].sort(
      (a, b) =>
        a.filePath.localeCompare(b.filePath) ||
        a.lineRange.start - b.lineRange.start,
    );
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this._disposables) d.dispose();
  }
}
