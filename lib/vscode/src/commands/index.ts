// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import * as vscode from "vscode";
import fs from "node:fs/promises";
import path from "node:path";
import type { ContextEntry } from "@kodela/core";
import {
  CLI_VERSION,
  runInit,
  runAdd,
  runExplain,
  runHeal,
  runArchive,
  runStatus,
  runSetup,
  runWatch,
  runWatchDetach,
  runWatchStop,
  runWatchStatus,
  installSupervisor,
  supervisorStatus,
  runMcpStart,
  runMcpStatus,
  detectAiCommits,
  findConfigFile,
  formatInitResult,
  formatSetupResult,
  formatExplainResult,
  formatHealResult,
  formatArchiveResult,
  formatWatchDetachResult,
  formatWatchStopResult,
  formatWatchStatus,
  formatInstallSupervisorResult,
  formatSupervisorStatus,
  formatMcpStart,
  formatMcpStatus,
  formatAiDetectionResult,
} from "@kodela/cli";
import type { Watcher } from "@kodela/watcher";
import type { KodelaWorkspace } from "../workspace/kodela-workspace.js";
import type { ExplorerView } from "../views/explorer-view.js";
import type { ControlCenterView } from "../views/control-center-view.js";
import { resolveEntry } from "./resolve-entry.js";
import { collectGap19Context } from "./gap19-prompts.js";
import type { TelemetryService } from "../telemetry/telemetry-service.js";
import { resolveAuthor } from "../utils/author.js";

const KNOWN_AI_EXTENSIONS = [
  { id: "github.copilot", aiTool: "copilot" },
  { id: "github.copilot-chat", aiTool: "copilot" },
  { id: "GitHub.copilot", aiTool: "copilot" },
  { id: "GitHub.copilot-chat", aiTool: "copilot" },
  { id: "continue.continue", aiTool: "continue" },
  { id: "Continue.continue", aiTool: "continue" },
  { id: "codeium.codeium", aiTool: "codeium" },
  { id: "Codeium.codeium", aiTool: "codeium" },
  { id: "TabNine.tabnine-vscode", aiTool: "tabnine" },
  { id: "tabnine.tabnine-vscode", aiTool: "tabnine" },
  { id: "supermaven.supermaven", aiTool: "supermaven" },
  { id: "AmazonWebServices.aws-toolkit-vscode", aiTool: "amazon-q" },
  { id: "GoogleCloudTools.cloudcode", aiTool: "gemini-code-assist" },
  { id: "sourcegraph.cody-ai", aiTool: "amp" },
  { id: "qodo.codium", aiTool: "qodo" },
  { id: "Codium.codium", aiTool: "qodo" },
  { id: "pieces.os-client", aiTool: "pieces" },
] as const;

const AUTO_START_WATCH_AI_SETTING = "autoStartWatchForAiTools";
const AUTO_START_WATCH_COPILOT_LEGACY_SETTING = "autoStartWatchForCopilot";
const SESSION_GOAL_SETTING = "sessionGoal";

export type CopilotAutoWatchTrigger = "setup" | "activation";

export type CopilotAutoWatchDecision =
  | "disabled"
  | "non-ai-context"
  | "already-running"
  | "degraded"
  | "started"
  | "start-failed"
  | "status-error";

export type CopilotAutoWatchResult = {
  trigger: CopilotAutoWatchTrigger;
  decision: CopilotAutoWatchDecision;
  reason: string;
};

type CopilotAutoWatchDependencies = {
  readStatus: typeof runWatchStatus;
  startDetach: typeof runWatchDetach;
  getConfig: () => vscode.WorkspaceConfiguration;
  getExtension: (id: string) => unknown;
};

let _channel: vscode.OutputChannel | undefined;
let _foregroundWatcher: Watcher | undefined;
let _foregroundEnvRestore: (() => void) | undefined;

function channel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel("Kodela");
  }
  return _channel;
}

function autoWatchOutput(
  outputChannel?: vscode.OutputChannel,
): vscode.OutputChannel | undefined {
  return outputChannel ?? _channel;
}

function writeAutoWatchLog(
  outputChannel: vscode.OutputChannel | undefined,
  trigger: CopilotAutoWatchTrigger,
  message: string,
): void {
  outputChannel?.appendLine(`[auto-watch:${trigger}] ${message}`);
}

function hasConfiguredValue<T>(
  inspectResult:
    | {
        globalValue?: T;
        workspaceValue?: T;
        workspaceFolderValue?: T;
      }
    | undefined,
): boolean {
  if (!inspectResult) return false;
  return (
    inspectResult.globalValue !== undefined ||
    inspectResult.workspaceValue !== undefined ||
    inspectResult.workspaceFolderValue !== undefined
  );
}

function resolveAutoWatchEnabled(config: vscode.WorkspaceConfiguration): boolean {
  const aiSettingInspect = config.inspect<boolean>(AUTO_START_WATCH_AI_SETTING);
  if (hasConfiguredValue(aiSettingInspect)) {
    return config.get<boolean>(AUTO_START_WATCH_AI_SETTING, true);
  }
  return config.get<boolean>(AUTO_START_WATCH_COPILOT_LEGACY_SETTING, true);
}

function resolveInstalledAiTool(getExtension: (id: string) => unknown): string | undefined {
  for (const candidate of KNOWN_AI_EXTENSIONS) {
    if (getExtension(candidate.id) !== undefined) {
      return candidate.aiTool;
    }
  }
  return undefined;
}

function resolveAutoWatchAiTool(
  workspace: KodelaWorkspace,
  getExtension: (id: string) => unknown,
): string | undefined {
  return workspace.getAiToolAttribution()?.aiTool ?? resolveInstalledAiTool(getExtension);
}

function resolveConfiguredSessionGoal(
  config: vscode.WorkspaceConfiguration,
): string | undefined {
  const raw = config.get<string>(SESSION_GOAL_SETTING, "");
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function promptSessionGoalIfMissing(
  config: vscode.WorkspaceConfiguration,
): Promise<string | undefined> {
  const existing = resolveConfiguredSessionGoal(config);
  if (existing) return existing;

  const value = await vscode.window.showInputBox({
    title: "Kodela Session Goal (Optional)",
    prompt: "Capture what you are trying to achieve in this coding session",
    placeHolder: "e.g. stabilize AI attribution across VS Code tools",
    ignoreFocusOut: true,
  });

  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  await config.update(SESSION_GOAL_SETTING, trimmed);
  return trimmed;
}

function applyProcessEnvOverrides(overrides: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, oldValue] of previous.entries()) {
      if (oldValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = oldValue;
      }
    }
  };
}

async function buildWatchEnvOverrides(
  workspace: KodelaWorkspace,
  config: vscode.WorkspaceConfiguration,
  aiTool: string | undefined,
  sessionGoal?: string,
): Promise<Record<string, string> | undefined> {
  const overrides: Record<string, string> = {};

  if (aiTool && aiTool.trim().length > 0) {
    overrides.KODELA_AGENT = aiTool.trim();
  }

  const goal = sessionGoal ?? resolveConfiguredSessionGoal(config);
  if (goal) {
    overrides.KODELA_GOAL = goal;
  }

  const author = await resolveAuthor(workspace.repoRoot);
  if (author !== "unknown") {
    overrides.KODELA_AUTHOR = author;
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export async function ensureCopilotAutoWatch(
  workspace: KodelaWorkspace,
  options: {
    trigger: CopilotAutoWatchTrigger;
    outputChannel?: vscode.OutputChannel;
    onResult?: (result: CopilotAutoWatchResult) => void;
    dependencies?: Partial<CopilotAutoWatchDependencies>;
    sessionGoal?: string;
  },
): Promise<CopilotAutoWatchResult> {
  const trigger = options.trigger;
  const out = autoWatchOutput(options.outputChannel);
  const deps = options.dependencies;
  const finish = (
    decision: CopilotAutoWatchDecision,
    reason: string,
  ): CopilotAutoWatchResult => {
    const result = { trigger, decision, reason };
    options.onResult?.(result);
    return result;
  };

  const config = (deps?.getConfig ?? (() =>
    vscode.workspace.getConfiguration("kodela")))();
  const enabled = resolveAutoWatchEnabled(config);
  if (!enabled) {
    const reason =
      `setting disabled (${AUTO_START_WATCH_AI_SETTING}=false or ` +
      `${AUTO_START_WATCH_COPILOT_LEGACY_SETTING}=false)`;
    writeAutoWatchLog(out, trigger, `skip: ${reason}`);
    return finish("disabled", reason);
  }

  const getExtension = deps?.getExtension ?? ((id: string) => vscode.extensions.getExtension(id));
  const aiTool = resolveAutoWatchAiTool(workspace, getExtension);

  if (!aiTool) {
    const reason = "no AI tool context detected (attribution or installed extension)";
    writeAutoWatchLog(out, trigger, `skip: ${reason}`);
    return finish("non-ai-context", reason);
  }

  const readStatus = deps?.readStatus ?? runWatchStatus;
  let status: Awaited<ReturnType<typeof runWatchStatus>>;
  try {
    status = await readStatus(workspace.repoRoot);
  } catch (err) {
    const reason = `failed to read watcher status: ${errorMessage(err)}`;
    writeAutoWatchLog(out, trigger, reason);
    return finish("status-error", reason);
  }

  if (status.state === "running") {
    const reason = `watcher already running (pid=${status.pid})`;
    writeAutoWatchLog(out, trigger, `skip: ${reason}`);
    return finish("already-running", reason);
  }

  if (status.state === "degraded") {
    const reason = `watcher degraded (pid=${status.pid}); start skipped to avoid duplicate process`;
    writeAutoWatchLog(out, trigger, `skip: ${reason}`);
    return finish("degraded", reason);
  }

  const startDetach = deps?.startDetach ?? runWatchDetach;
  try {
    const envOverrides = await buildWatchEnvOverrides(
      workspace,
      config,
      aiTool,
      options.sessionGoal,
    );
    const result = await startDetach({
      repoRoot: workspace.repoRoot,
      extraArgs: ["--auto-annotate"],
      cliVersion: CLI_VERSION,
      ...(envOverrides ? { envOverrides } : {}),
    });

    if (result.started) {
      const reason =
        `watcher started in daemon mode (pid=${result.pid ?? "unknown"}, aiTool=${aiTool})`;
      writeAutoWatchLog(out, trigger, reason);
      return finish("started", reason);
    }

    if (result.alreadyRunning) {
      const reason = result.reason;
      writeAutoWatchLog(out, trigger, `skip: ${reason}`);
      return finish("already-running", reason);
    }

    const reason = `watcher start failed: ${result.reason}`;
    writeAutoWatchLog(out, trigger, reason);
    return finish("start-failed", reason);
  } catch (err) {
    const reason = `watcher start failed: ${errorMessage(err)}`;
    writeAutoWatchLog(out, trigger, reason);
    return finish("start-failed", reason);
  }
}

export function registerCommands(
  context: vscode.ExtensionContext,
  workspace: KodelaWorkspace,
  explorerView?: ExplorerView,
  outputChannel?: vscode.OutputChannel,
  telemetry?: TelemetryService,
  controlCenterView?: ControlCenterView,
): void {
  _channel = outputChannel ?? vscode.window.createOutputChannel("Kodela");

  context.subscriptions.push(
    vscode.commands.registerCommand("kodela.showLog", () => {
      channel().show(true);
    }),
    vscode.commands.registerCommand("kodela.init", () =>
      handleInit(workspace),
    ),
    vscode.commands.registerCommand("kodela.add", () => handleAdd(workspace, telemetry)),
    vscode.commands.registerCommand("kodela.explain", () =>
      handleExplain(workspace),
    ),
    vscode.commands.registerCommand("kodela.heal", () =>
      handleHeal(workspace),
    ),
    vscode.commands.registerCommand("kodela.archive", () =>
      handleArchive(workspace),
    ),
    vscode.commands.registerCommand("kodela.showStatus", () =>
      handleShowStatus(workspace),
    ),
    vscode.commands.registerCommand("kodela.detectAi", () =>
      handleDetectAi(workspace),
    ),
    vscode.commands.registerCommand("kodela.setup", () =>
      handleSetup(workspace, controlCenterView),
    ),
    vscode.commands.registerCommand("kodela.watchStart", () =>
      handleWatchStart(workspace),
    ),
    vscode.commands.registerCommand("kodela.watchStop", () =>
      handleWatchStop(workspace),
    ),
    vscode.commands.registerCommand("kodela.watchStatus", () =>
      handleWatchStatus(workspace),
    ),
    vscode.commands.registerCommand("kodela.mcpStart", () =>
      handleMcpStart(workspace),
    ),
    vscode.commands.registerCommand("kodela.mcpStatus", () =>
      handleMcpStatus(workspace),
    ),
    vscode.commands.registerCommand("kodela.showCurrentMetadata", (arg?: unknown) =>
      handleShowCurrentMetadata(workspace, explorerView, arg),
    ),
    vscode.commands.registerCommand("kodela.openLinkedUrl", (arg?: unknown) =>
      handleOpenLinkedUrl(workspace, explorerView, arg),
    ),
    vscode.commands.registerCommand("kodela.configureProxyVariables", () =>
      handleConfigureProxyVariables(workspace),
    ),
    vscode.commands.registerCommand("kodela.refresh", () =>
      workspace.refresh(),
    ),
    vscode.commands.registerCommand("kodela.sortBySeverity", () =>
      explorerView?.setSortMode("severity"),
    ),
    vscode.commands.registerCommand("kodela.sortByStatus", () =>
      explorerView?.setSortMode("status"),
    ),
    vscode.commands.registerCommand("kodela.sortByFile", () =>
      explorerView?.setSortMode("file"),
    ),
    vscode.commands.registerCommand(
      "kodela.revealInExplorer",
      (entryId: string) => explorerView?.revealEntry(entryId),
    ),
    vscode.commands.registerCommand(
      "kodela.deleteEntry",
      (arg: unknown): Promise<void> | void => {
        const entry = resolveEntry(arg);
        if (entry) return handleDeleteEntry(workspace, entry);
      },
    ),
    vscode.commands.registerCommand(
      "kodela.revealEntry",
      (entry: ContextEntry) => handleRevealEntry(workspace, entry),
    ),
    channel(),
  );
}

async function handleInit(workspace: KodelaWorkspace): Promise<void> {
  try {
    const result = await runInit(workspace.repoRoot);
    const msg = formatInitResult(result);
    void vscode.window.showInformationMessage(msg);
    await workspace.refresh();
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela init failed: ${errorMessage(err)}`,
    );
  }
}

async function handleAdd(workspace: KodelaWorkspace, telemetry?: TelemetryService): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let filePath: string | undefined;
  let lineStart: number | undefined;
  let lineEnd: number | undefined;

  if (editor && !editor.selection.isEmpty) {
    const absPath = editor.document.uri.fsPath;
    filePath = path.relative(workspace.repoRoot, absPath).replace(/\\/g, "/");
    lineStart = editor.selection.start.line + 1;
    const selEnd = editor.selection.end;
    lineEnd =
      selEnd.character === 0 && selEnd.line > editor.selection.start.line
        ? selEnd.line
        : selEnd.line + 1;
  } else if (editor) {
    const absPath = editor.document.uri.fsPath;
    filePath = path.relative(workspace.repoRoot, absPath).replace(/\\/g, "/");
    lineStart = editor.selection.active.line + 1;
    lineEnd = lineStart;
  }

  if (!filePath) {
    const input = await vscode.window.showInputBox({
      prompt: "File path (relative to repo root)",
      placeHolder: "src/auth/login.ts",
    });
    if (!input) return;
    filePath = input;
  }

  if (lineStart === undefined) {
    const raw = await vscode.window.showInputBox({
      prompt: "Start line number",
      placeHolder: "1",
      validateInput: (v) => (isNaN(parseInt(v)) ? "Must be a number" : null),
    });
    if (!raw) return;
    lineStart = parseInt(raw, 10);
  }

  if (lineEnd === undefined) {
    const raw = await vscode.window.showInputBox({
      prompt: "End line number",
      value: String(lineStart),
      validateInput: (v) => (isNaN(parseInt(v)) ? "Must be a number" : null),
    });
    if (!raw) return;
    lineEnd = parseInt(raw, 10);
  }

  const note = await vscode.window.showInputBox({
    prompt: "Context note — why does this code exist?",
    placeHolder: "e.g. JWT validation — must reject expired tokens per RFC 7519",
    // Gap 20b — soft length warning; validation message shown inline, not a hard block.
    validateInput: (v) => {
      const trimmed = v.trim();
      if (!trimmed) return null; // empty → handled by `if (!note)` guard below
      return trimmed.length < 10 ? "Note is too short — aim for at least 10 characters" : null;
    },
  });
  if (!note) {
    // Gap 21 — prompt_dismissed: user cancelled at the note stage.
    void telemetry?.emitPromptDismissed("note");
    return;
  }

  const severityPick = await vscode.window.showQuickPick(
    ["low", "medium", "high", "critical"],
    { placeHolder: "Severity level" },
  );
  if (!severityPick) return;

  const sourcePick = await vscode.window.showQuickPick(
    ["human", "ai", "import"],
    { placeHolder: "Source" },
  );
  if (!sourcePick) return;

  const tagsRaw = await vscode.window.showInputBox({
    prompt: "Tags (comma-separated, optional)",
    placeHolder: "security, auth",
  });
  const tags = tagsRaw
    ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  const aiAttribution = workspace.getAiToolAttribution();

  // Gap 19 — AI-specific edge cases: Cursor Composer summary (19a),
  // Artifact URL convention (19b), shared team thread title (19c).
  // All prompts are optional — Escape skips the field, not the annotation.
  const gap19 = await collectGap19Context(
    aiAttribution?.aiTool,
    aiAttribution?.link,
    (opts) => Promise.resolve(vscode.window.showInputBox(opts)),
    (msg) => void vscode.window.showInformationMessage(msg),
  );
  // 19c: append thread title to note when provided
  const finalNote = gap19.threadTitle ? `${note} · Thread: ${gap19.threadTitle}` : note;

  try {
    await runAdd({
      repoRoot: workspace.repoRoot,
      filePath,
      lineStart,
      lineEnd,
      note: finalNote,
      severity: severityPick as ContextEntry["severity"],
      source: sourcePick as ContextEntry["source"],
      tags,
      ...(aiAttribution ? { aiTool: aiAttribution.aiTool, link: aiAttribution.link } : {}),
      ...(gap19.originSummary ? { originSummary: gap19.originSummary } : {}),
    });
    // Gap 21 — annotation_added telemetry (no PII: note length only, not content).
    void telemetry?.emitAnnotationAdded(
      finalNote.length,
      (sourcePick as ContextEntry["source"]) ?? "unknown",
      !!aiAttribution?.aiTool,
    );
    void vscode.window.showInformationMessage(
      `Kodela: annotation added for ${filePath} L${lineStart}–${lineEnd}`,
    );
    await workspace.refresh();
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela add failed: ${errorMessage(err)}`,
    );
  }
}

async function handleExplain(workspace: KodelaWorkspace): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let filePath: string | undefined;

  if (editor) {
    filePath = path
      .relative(workspace.repoRoot, editor.document.uri.fsPath)
      .replace(/\\/g, "/");
  } else {
    const input = await vscode.window.showInputBox({
      prompt: "File path to explain (relative to repo root)",
    });
    if (!input) return;
    filePath = input;
  }

  try {
    const result = await runExplain({
      repoRoot: workspace.repoRoot,
      filePath,
    });
    const output = formatExplainResult(result, "text");
    channel().clear();
    channel().appendLine(output);
    channel().show();
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela explain failed: ${errorMessage(err)}`,
    );
  }
}

async function handleHeal(workspace: KodelaWorkspace): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Kodela: Healing annotations…",
      cancellable: false,
    },
    async () => {
      try {
        const result = await runHeal({ repoRoot: workspace.repoRoot });
        const output = formatHealResult(result);
        channel().clear();
        channel().appendLine(output);
        channel().show();
        void vscode.window.showInformationMessage(
          `Kodela heal complete: ${result.healed} healed, ${result.failed} failed out of ${result.total}`,
        );
        await workspace.refresh();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Kodela heal failed: ${errorMessage(err)}`,
        );
      }
    },
  );
}

async function handleArchive(workspace: KodelaWorkspace): Promise<void> {
  try {
    const dryRun = await runArchive({
      repoRoot: workspace.repoRoot,
      dryRun: true,
    });

    if (dryRun.archived === 0) {
      void vscode.window.showInformationMessage(
        "Kodela: no orphaned annotations to archive.",
      );
      return;
    }

    const dryOutput = formatArchiveResult(dryRun);
    channel().clear();
    channel().appendLine("--- DRY RUN (nothing archived yet) ---");
    channel().appendLine(dryOutput);
    channel().show();

    const confirmed = await vscode.window.showWarningMessage(
      `Kodela: will archive ${dryRun.archived} orphaned annotation(s). See the Kodela output channel for details. This cannot be undone.`,
      { modal: true },
      "Archive",
    );
    if (confirmed !== "Archive") return;

    const result = await runArchive({
      repoRoot: workspace.repoRoot,
      dryRun: false,
    });
    channel().clear();
    channel().appendLine(formatArchiveResult(result));
    channel().show();
    void vscode.window.showInformationMessage(
      `Kodela: archived ${result.archived} annotation(s).`,
    );
    await workspace.refresh();
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela archive failed: ${errorMessage(err)}`,
    );
  }
}

async function handleShowStatus(workspace: KodelaWorkspace): Promise<void> {
  try {
    const { output } = await runStatus({ repoRoot: workspace.repoRoot });
    channel().clear();
    channel().appendLine(output);
    channel().show();
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela status failed: ${errorMessage(err)}`,
    );
  }
}

async function handleDetectAi(workspace: KodelaWorkspace): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Kodela: Scanning git history for AI commits…",
      cancellable: false,
    },
    async () => {
      try {
        const result = await detectAiCommits(workspace.repoRoot, workspace.config);
        const output = formatAiDetectionResult(result);
        channel().clear();
        channel().appendLine(output);
        channel().show();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Kodela detect failed: ${errorMessage(err)}`,
        );
      }
    },
  );
}

function writeToOutput(text: string): void {
  channel().clear();
  channel().appendLine(text);
  channel().show();
}

function outputStream(): NodeJS.WriteStream {
  return {
    write: (chunk: string | Uint8Array): boolean => {
      channel().append(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    },
  } as unknown as NodeJS.WriteStream;
}

async function handleSetup(
  workspace: KodelaWorkspace,
  controlCenterView?: ControlCenterView,
): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration("kodela");
    const result = await runSetup({
      repoRoot: workspace.repoRoot,
      yes: true,
    });
    writeToOutput(formatSetupResult(result));
    await workspace.refresh();

    const sessionGoal = await promptSessionGoalIfMissing(config);

    const autoWatch = await ensureCopilotAutoWatch(workspace, {
      trigger: "setup",
      outputChannel: channel(),
      onResult: (r) => controlCenterView?.setAutoWatchIndicator(r),
      sessionGoal,
    });
    if (
      autoWatch.decision === "start-failed" ||
      autoWatch.decision === "status-error"
    ) {
      void vscode.window.showWarningMessage(
        "Kodela setup completed, but auto-starting the AI watcher failed. See Kodela output for details.",
      );
    }

    void vscode.window.showInformationMessage(
      `Kodela setup complete. Active capture mode: ${result.captureMode}.`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela setup failed: ${errorMessage(err)}`,
    );
  }
}

type WatchStartMode = "foreground" | "daemon" | "supervised";

async function handleWatchStart(workspace: KodelaWorkspace): Promise<void> {
  const modePick = await vscode.window.showQuickPick(
    [
      {
        label: "Foreground Session",
        description: "Run watch in this VS Code session",
        mode: "foreground" as WatchStartMode,
      },
      {
        label: "Background Daemon",
        description: "Detached process with PID and logs",
        mode: "daemon" as WatchStartMode,
      },
      {
        label: "Supervised Daemon",
        description: "Install OS supervisor and auto-restart",
        mode: "supervised" as WatchStartMode,
      },
    ],
    {
      placeHolder: "Choose how to start Kodela watch",
    },
  );
  if (!modePick) return;

  try {
    const config = vscode.workspace.getConfiguration("kodela");
    const aiTool = workspace.getAiToolAttribution()?.aiTool;
    const sessionGoal = await promptSessionGoalIfMissing(config);
    const envOverrides = await buildWatchEnvOverrides(
      workspace,
      config,
      aiTool,
      sessionGoal,
    );

    if (modePick.mode === "foreground") {
      if (_foregroundWatcher) {
        void vscode.window.showInformationMessage(
          "Kodela foreground watcher is already running.",
        );
        return;
      }
      const restoreEnv = envOverrides
        ? applyProcessEnvOverrides(envOverrides)
        : undefined;
      try {
        _foregroundWatcher = await runWatch(
          {
            repoRoot: workspace.repoRoot,
            autoAnnotate: true,
            config: workspace.config,
          },
          outputStream(),
        );
        _foregroundEnvRestore = restoreEnv;
      } catch (err) {
        restoreEnv?.();
        _foregroundEnvRestore = undefined;
        throw err;
      }
      void vscode.window.showInformationMessage(
        "Kodela foreground watcher started. Use Stop Watch to stop it.",
      );
      channel().show();
      return;
    }

    if (modePick.mode === "daemon") {
      const result = await runWatchDetach({
        repoRoot: workspace.repoRoot,
        extraArgs: ["--auto-annotate"],
        cliVersion: CLI_VERSION,
        ...(envOverrides ? { envOverrides } : {}),
      });
      writeToOutput(formatWatchDetachResult(result));
      return;
    }

    const result = await installSupervisor({
      repoRoot: workspace.repoRoot,
      extraArgs: ["--auto-annotate"],
      cliVersion: CLI_VERSION,
      force: false,
      ...(envOverrides ? { envOverrides } : {}),
    });
    writeToOutput(formatInstallSupervisorResult(result));
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela watch start failed: ${errorMessage(err)}`,
    );
  }
}

async function handleWatchStop(workspace: KodelaWorkspace): Promise<void> {
  try {
    const lines: string[] = [];

    if (_foregroundWatcher) {
      _foregroundWatcher.stop();
      _foregroundWatcher = undefined;
      _foregroundEnvRestore?.();
      _foregroundEnvRestore = undefined;
      lines.push("● Foreground watcher stopped.");
    }

    const daemonResult = await runWatchStop(workspace.repoRoot);
    lines.push(formatWatchStopResult(daemonResult));
    writeToOutput(lines.join("\n\n"));
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela watch stop failed: ${errorMessage(err)}`,
    );
  }
}

async function handleWatchStatus(workspace: KodelaWorkspace): Promise<void> {
  try {
    const [daemonStatus, supStatus] = await Promise.all([
      runWatchStatus(workspace.repoRoot),
      supervisorStatus({ repoRoot: workspace.repoRoot }),
    ]);

    const foregroundStatus = _foregroundWatcher
      ? "● Foreground watcher: running (extension session)"
      : "● Foreground watcher: stopped";

    writeToOutput(
      [
        foregroundStatus,
        "",
        formatWatchStatus(daemonStatus),
        "",
        formatSupervisorStatus(supStatus),
      ].join("\n"),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela watch status failed: ${errorMessage(err)}`,
    );
  }
}

async function handleMcpStart(workspace: KodelaWorkspace): Promise<void> {
  try {
    const result = await runMcpStart({ repoRoot: workspace.repoRoot });
    writeToOutput(formatMcpStart(result));
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela MCP start failed: ${errorMessage(err)}`,
    );
  }
}

async function handleMcpStatus(workspace: KodelaWorkspace): Promise<void> {
  try {
    const result = await runMcpStatus({ repoRoot: workspace.repoRoot });
    writeToOutput(formatMcpStatus(result));
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela MCP status failed: ${errorMessage(err)}`,
    );
  }
}

function entryForCurrentCursor(
  workspace: KodelaWorkspace,
): ContextEntry | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;

  const relPath = path
    .relative(workspace.repoRoot, editor.document.uri.fsPath)
    .replace(/\\/g, "/");
  const line = editor.selection.active.line + 1;

  const entries = workspace.allEntries.filter(
    (entry) =>
      entry.filePath === relPath &&
      line >= entry.lineRange.start &&
      line <= entry.lineRange.end,
  );

  return entries.sort((a, b) => a.lineRange.start - b.lineRange.start)[0];
}

async function pickEntryFromWorkspace(
  workspace: KodelaWorkspace,
): Promise<ContextEntry | undefined> {
  if (workspace.allEntries.length === 0) return undefined;

  const items = workspace.allEntries.map((entry) => ({
    label: `${entry.filePath}:${entry.lineRange.start}-${entry.lineRange.end}`,
    description: `${entry.status} · ${Math.round(entry.confidence * 100)}%`,
    detail: entry.note,
    entry,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a Kodela annotation",
  });
  return pick?.entry;
}

async function resolveTargetEntry(
  workspace: KodelaWorkspace,
  explorerView: ExplorerView | undefined,
  arg?: unknown,
): Promise<ContextEntry | undefined> {
  const fromArg = resolveEntry(arg);
  if (fromArg) return fromArg;

  const selected = explorerView?.getSelectedEntry();
  if (selected) return selected;

  const fromCursor = entryForCurrentCursor(workspace);
  if (fromCursor) return fromCursor;

  return pickEntryFromWorkspace(workspace);
}

async function handleShowCurrentMetadata(
  workspace: KodelaWorkspace,
  explorerView?: ExplorerView,
  arg?: unknown,
): Promise<void> {
  try {
    const entry = await resolveTargetEntry(workspace, explorerView, arg);
    if (!entry) {
      void vscode.window.showInformationMessage(
        "No annotation selected. Select an entry in Kodela Explorer, place cursor on annotated code, or pick from the list.",
      );
      return;
    }

    const metadata = {
      id: entry.id,
      filePath: entry.filePath,
      lineRange: entry.lineRange,
      status: entry.status,
      confidence: entry.confidence,
      severity: entry.severity,
      source: entry.source,
      aiTool: entry.aiTool,
      link: entry.link,
      externalRef: entry.externalRef,
      reviewRequired: entry.reviewRequired,
      updatedAt: entry.updatedAt,
      note: entry.note,
    };

    writeToOutput(
      [
        "Current Kodela Metadata",
        "======================",
        "",
        JSON.stringify(metadata, null, 2),
      ].join("\n"),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela metadata failed: ${errorMessage(err)}`,
    );
  }
}

async function handleOpenLinkedUrl(
  workspace: KodelaWorkspace,
  explorerView?: ExplorerView,
  arg?: unknown,
): Promise<void> {
  try {
    const entry = await resolveTargetEntry(workspace, explorerView, arg);
    if (!entry) {
      void vscode.window.showInformationMessage(
        "No annotation selected. Select an entry first.",
      );
      return;
    }

    const targetUrl = entry.externalRef?.url ?? entry.link;
    if (!targetUrl) {
      void vscode.window.showInformationMessage(
        "Selected annotation has no linked URL.",
      );
      return;
    }

    const opened = await vscode.env.openExternal(vscode.Uri.parse(targetUrl));
    if (!opened) {
      void vscode.window.showErrorMessage(
        "Could not open linked URL in browser.",
      );
      return;
    }

    void vscode.window.showInformationMessage("Opened linked URL.");
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela launch URL failed: ${errorMessage(err)}`,
    );
  }
}

async function handleConfigureProxyVariables(
  workspace: KodelaWorkspace,
): Promise<void> {
  try {
    let configPath = await findConfigFile(workspace.repoRoot);
    if (!configPath) {
      const create = await vscode.window.showQuickPick(
        [
          { label: "Create config and continue", value: true },
          { label: "Cancel", value: false },
        ],
        { placeHolder: "kodela.config.json was not found." },
      );
      if (!create || !create.value) return;
      await runInit(workspace.repoRoot);
      configPath = await findConfigFile(workspace.repoRoot);
      if (!configPath) {
        throw new Error("Could not create kodela.config.json");
      }
    }

    const raw = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;

    const existingAi =
      typeof config.ai_provider === "object" && config.ai_provider !== null
        ? ({ ...config.ai_provider } as Record<string, unknown>)
        : {};

    const providerPick = await vscode.window.showQuickPick(
      [
        { label: "Keep current provider", value: "keep" },
        { label: "openai", value: "openai" },
        { label: "anthropic", value: "anthropic" },
      ],
      {
        placeHolder: "AI provider",
      },
    );
    if (!providerPick) return;

    const modelInput = await vscode.window.showInputBox({
      prompt: "Model (leave blank to keep current)",
      value: typeof existingAi.model === "string" ? existingAi.model : "",
    });
    if (modelInput === undefined) return;

    const baseUrlInput = await vscode.window.showInputBox({
      prompt:
        "Proxy / base URL (leave blank to keep current, enter '-' to clear)",
      value:
        typeof existingAi.base_url === "string"
          ? existingAi.base_url
          : "",
    });
    if (baseUrlInput === undefined) return;

    if (providerPick.value !== "keep") {
      existingAi.provider = providerPick.value;
    }
    if (modelInput.trim().length > 0) {
      existingAi.model = modelInput.trim();
    }
    if (baseUrlInput.trim() === "-") {
      delete existingAi.base_url;
    } else if (baseUrlInput.trim().length > 0) {
      existingAi.base_url = baseUrlInput.trim();
    }

    const storageMode = await vscode.window.showQuickPick(
      [
        { label: "Keep current storage mode", value: "keep" },
        { label: "Local only", value: "local" },
        { label: "Central server", value: "central" },
      ],
      {
        placeHolder: "Storage mode",
      },
    );
    if (!storageMode) return;

    const existingStorage =
      typeof config.storage === "object" && config.storage !== null
        ? ({ ...config.storage } as Record<string, unknown>)
        : {};

    let centralEnvName = "KODELA_API_KEY";
    if (storageMode.value === "local") {
      existingStorage.mode = "local";
    }
    if (storageMode.value === "central") {
      const existingServer =
        typeof existingStorage.server === "object" &&
        existingStorage.server !== null
          ? ({ ...existingStorage.server } as Record<string, unknown>)
          : {};

      const serverUrl = await vscode.window.showInputBox({
        prompt: "Central server URL",
        value: typeof existingServer.url === "string" ? existingServer.url : "",
      });
      if (!serverUrl) return;

      const apiKeyEnv = await vscode.window.showInputBox({
        prompt: "Environment variable name for server API key",
        value:
          typeof existingServer.api_key_env === "string"
            ? existingServer.api_key_env
            : "KODELA_API_KEY",
      });
      if (!apiKeyEnv) return;

      centralEnvName = apiKeyEnv.trim();
      existingStorage.mode = "central";
      existingStorage.server = {
        ...existingServer,
        url: serverUrl.trim(),
        api_key_env: centralEnvName,
      };
    }

    const aiApiKey = await vscode.window.showInputBox({
      prompt:
        "AI API key (optional, saved for this VS Code session only)",
      password: true,
      ignoreFocusOut: true,
    });
    if (aiApiKey && aiApiKey.trim().length > 0) {
      process.env.KODELA_AI_API_KEY = aiApiKey.trim();
    }

    if (storageMode.value === "central") {
      const serverApiKey = await vscode.window.showInputBox({
        prompt: `${centralEnvName} value (optional, session only)`,
        password: true,
        ignoreFocusOut: true,
      });
      if (serverApiKey && serverApiKey.trim().length > 0) {
        process.env[centralEnvName] = serverApiKey.trim();
      }
    }

    const updated = { ...config };
    if (Object.keys(existingAi).length > 0) {
      updated.ai_provider = existingAi;
    }
    if (Object.keys(existingStorage).length > 0) {
      updated.storage = existingStorage;
    }

    await fs.writeFile(configPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");

    writeToOutput(
      [
        "Kodela configuration updated",
        "==========================",
        `Config file: ${configPath}`,
        `Provider: ${String(existingAi.provider ?? "(unchanged)")}`,
        `Model: ${String(existingAi.model ?? "(unchanged)")}`,
        `Base URL: ${String(existingAi.base_url ?? "(unchanged)")}`,
        `Storage mode: ${String(existingStorage.mode ?? "(unchanged)")}`,
        "",
        "Environment variable guidance:",
        "- KODELA_AI_API_KEY for AI provider auth",
        `- ${centralEnvName} for central sync auth (if using central mode)`,
      ].join("\n"),
    );

    await workspace.refresh();
    void vscode.window.showInformationMessage(
      "Kodela variables/proxy settings updated.",
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela variable/proxy setup failed: ${errorMessage(err)}`,
    );
  }
}

async function handleDeleteEntry(
  workspace: KodelaWorkspace,
  entry: ContextEntry,
): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    `Delete annotation "${entry.note}"?`,
    { modal: true },
    "Delete",
  );
  if (confirmed !== "Delete") return;
  try {
    await workspace.removeEntry(entry.id);
    void vscode.window.showInformationMessage("Kodela: annotation deleted.");
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela delete failed: ${errorMessage(err)}`,
    );
  }
}

async function handleRevealEntry(
  workspace: KodelaWorkspace,
  entry: ContextEntry,
): Promise<void> {
  try {
    const absPath = path.join(workspace.repoRoot, entry.filePath);
    const uri = vscode.Uri.file(absPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    const startLine = Math.max(0, entry.lineRange.start - 1);
    const range = new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(startLine, 0),
    );
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(
      new vscode.Position(startLine, 0),
      new vscode.Position(startLine, 0),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Kodela: could not navigate to annotation — ${errorMessage(err)}`,
    );
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
