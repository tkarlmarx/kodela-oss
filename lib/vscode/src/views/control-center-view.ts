// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import * as vscode from "vscode";

export type CopilotAutoWatchIndicator = {
  trigger: "setup" | "activation";
  decision:
    | "disabled"
    | "non-ai-context"
    | "already-running"
    | "degraded"
    | "started"
    | "start-failed"
    | "status-error";
  reason: string;
};

export type ControlCenterNode = GroupNode | ActionNode | StatusNode;
type GroupChildNode = ActionNode | StatusNode;

function formatAutoWatchSummary(
  indicator?: CopilotAutoWatchIndicator,
): { description: string; iconId: string } {
  if (!indicator) {
    return {
      description: "Waiting for first activation/setup check",
      iconId: "clock",
    };
  }

  switch (indicator.decision) {
    case "disabled":
      return { description: "Skipped: setting disabled", iconId: "settings-gear" };
    case "non-ai-context":
      return { description: "Skipped: no AI context", iconId: "circle-slash" };
    case "already-running":
      return { description: "Skipped: watcher already running", iconId: "debug-pause" };
    case "degraded":
      return { description: "Skipped: watcher degraded", iconId: "warning" };
    case "started":
      return { description: "Started daemon with --auto-annotate", iconId: "check" };
    case "start-failed":
      return { description: "Failed: daemon start error", iconId: "error" };
    case "status-error":
      return { description: "Failed: status check error", iconId: "error" };
    default:
      return { description: "Unknown auto-watch state", iconId: "question" };
  }
}

class ActionNode extends vscode.TreeItem {
  constructor(
    public readonly actionId: string,
    label: string,
    description: string,
    commandId: string | undefined,
    iconId: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = "kodelaControlAction";
    this.iconPath = new vscode.ThemeIcon(iconId);
    if (commandId) {
      this.command = {
        command: commandId,
        title: label,
      };
    }
  }
}

class StatusNode extends vscode.TreeItem {
  constructor(indicator?: CopilotAutoWatchIndicator) {
    super("AI Auto-Watch", vscode.TreeItemCollapsibleState.None);
    const summary = formatAutoWatchSummary(indicator);
    this.description = summary.description;
    this.contextValue = "kodelaControlStatus";
    this.iconPath = new vscode.ThemeIcon(summary.iconId);
    this.tooltip = indicator
      ? `Last check (${indicator.trigger}): ${indicator.reason}`
      : "Runs automatically for active AI tool context during activation and setup.";
  }
}

class GroupNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly children: GroupChildNode[],
  ) {
    super(
      label,
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = "kodelaControlGroup";
  }
}

export class ControlCenterView
  implements vscode.TreeDataProvider<ControlCenterNode>, vscode.Disposable
{
  private _autoWatchIndicator: CopilotAutoWatchIndicator | undefined;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ControlCenterNode | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<
    ControlCenterNode | undefined | void
  > = this._onDidChangeTreeData.event;

  getTreeItem(element: ControlCenterNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ControlCenterNode): ControlCenterNode[] {
    if (!element) {
      return this._buildGroups();
    }
    if (element instanceof GroupNode) {
      return element.children;
    }
    return [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setAutoWatchIndicator(indicator: CopilotAutoWatchIndicator): void {
    this._autoWatchIndicator = indicator;
    this.refresh();
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  private _buildGroups(): GroupNode[] {
    const lifecycle = new GroupNode("Lifecycle", [
      new StatusNode(this._autoWatchIndicator),
      new ActionNode(
        "setup",
        "Setup Workspace",
        "Auto-configure Kodela for this repository",
        "kodela.setup",
        "rocket",
      ),
      new ActionNode(
        "init",
        "Initialize Repository",
        "Create .kodela files and hooks",
        "kodela.init",
        "add",
      ),
      new ActionNode(
        "status",
        "Show Status",
        "Display mapping confidence and health",
        "kodela.showStatus",
        "pulse",
      ),
      new ActionNode(
        "watchStart",
        "Start Watch",
        "Start watcher in your chosen mode",
        "kodela.watchStart",
        "play",
      ),
      new ActionNode(
        "watchStop",
        "Stop Watch",
        "Stop running watcher",
        "kodela.watchStop",
        "debug-stop",
      ),
      new ActionNode(
        "watchStatus",
        "Watch Status",
        "Check daemon and supervisor health",
        "kodela.watchStatus",
        "heartbeat",
      ),
      new ActionNode(
        "heal",
        "Heal Annotations",
        "Re-map annotations after code changes",
        "kodela.heal",
        "sync",
      ),
      new ActionNode(
        "log",
        "Open Log",
        "Open Kodela output logs",
        "kodela.showLog",
        "output",
      ),
    ]);

    const metadata = new GroupNode("Metadata", [
      new ActionNode(
        "add",
        "Add Annotation",
        "Add context to selected code",
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
        "currentMetadata",
        "Current Metadata",
        "Show selected annotation metadata",
        "kodela.showCurrentMetadata",
        "symbol-key",
      ),
      new ActionNode(
        "openUrl",
        "Launch URL",
        "Open linked ticket or chat URL",
        "kodela.openLinkedUrl",
        "link-external",
      ),
    ]);

    const integrations = new GroupNode("Integrations", [
      new ActionNode(
        "mcpStart",
        "Launch MCP",
        "Show MCP configuration snippet",
        "kodela.mcpStart",
        "plug",
      ),
      new ActionNode(
        "mcpStatus",
        "MCP Status",
        "Check MCP setup status",
        "kodela.mcpStatus",
        "server-process",
      ),
    ]);

    const configuration = new GroupNode("Configuration", [
      new ActionNode(
        "configure",
        "Define Variables / Proxy",
        "Configure AI provider, model, and base URL",
        "kodela.configureProxyVariables",
        "settings-gear",
      ),
      new ActionNode(
        "refresh",
        "Refresh",
        "Refresh Kodela data",
        "kodela.refresh",
        "refresh",
      ),
    ]);

    return [lifecycle, metadata, integrations, configuration];
  }
}
