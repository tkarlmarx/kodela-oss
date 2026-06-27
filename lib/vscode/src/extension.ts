// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import * as vscode from "vscode";
import { KodelaWorkspace } from "./workspace/kodela-workspace.js";
import { DecorationProvider } from "./providers/decoration-provider.js";
import { KodelaHoverProvider } from "./providers/hover-provider.js";
import { KodelaCodeLensProvider } from "./providers/codelens-provider.js";
import { DiagnosticsProvider } from "./providers/diagnostics-provider.js";
import { ExplorerView } from "./views/explorer-view.js";
import { ControlCenterView } from "./views/control-center-view.js";
import { StatusBarManager } from "./status-bar.js";
import { registerCommands, ensureCopilotAutoWatch } from "./commands/index.js";
import { AiInsertionDetector } from "./providers/ai-insertion-detector.js";
import { TelemetryService } from "./telemetry/telemetry-service.js";
import { registerCopilotSessionCapture } from "./chat/copilot-session-capture.js";
import { NativeCopilotCaptureService } from "./chat/native-copilot-capture.js";
import { appendTelemetryEvent } from "@kodela/core";
import { runNudge } from "@kodela/cli";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("kodela");
  if (!cfg.get<boolean>("enable", true)) return;

  const outputChannel = vscode.window.createOutputChannel("Kodela");
  context.subscriptions.push(outputChannel);

  const workspace = await KodelaWorkspace.create(context, outputChannel);

  // Gap 21 — telemetry service: respects vscode.env.isTelemetryEnabled.
  const telemetry = new TelemetryService(
    workspace.repoRoot,
    appendTelemetryEvent,
    () => vscode.env.isTelemetryEnabled,
  );

  const decorationProvider = new DecorationProvider(workspace);
  const hoverProvider = new KodelaHoverProvider(workspace, telemetry);
  const codeLensProvider = new KodelaCodeLensProvider(workspace);
  const diagnosticsProvider = new DiagnosticsProvider(workspace);
  const explorerView = new ExplorerView(workspace);
  const controlCenterView = new ControlCenterView();
  const statusBar = new StatusBarManager(workspace);

  context.subscriptions.push(
    decorationProvider,
    hoverProvider,
    codeLensProvider,
    diagnosticsProvider,
    explorerView,
    controlCenterView,
    statusBar,
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: "file" },
      hoverProvider,
    ),
    vscode.languages.registerCodeLensProvider(
      { scheme: "file" },
      codeLensProvider,
    ),
  );

  const treeView = vscode.window.createTreeView("kodelaExplorer", {
    treeDataProvider: explorerView,
    showCollapseAll: true,
  });
  explorerView.setTreeView(treeView);
  context.subscriptions.push(treeView);

  const controlTreeView = vscode.window.createTreeView("kodelaControlCenter", {
    treeDataProvider: controlCenterView,
    showCollapseAll: true,
  });
  context.subscriptions.push(controlTreeView);

  registerCommands(
    context,
    workspace,
    explorerView,
    outputChannel,
    telemetry,
    controlCenterView,
  );

  const aiDetector = new AiInsertionDetector(workspace);
  aiDetector.register(context);

  const nativeCaptureEnabled = cfg.get<boolean>("nativeCapture.enabled", true);
  let nativeCopilotCapture: NativeCopilotCaptureService | undefined;
  if (nativeCaptureEnabled) {
    nativeCopilotCapture = new NativeCopilotCaptureService(
      workspace.repoRoot,
      context,
      outputChannel,
    );
    nativeCopilotCapture.start().catch((err: unknown) => {
      outputChannel.appendLine(
        `[native-capture] start failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    context.subscriptions.push(nativeCopilotCapture);
  } else {
    outputChannel.appendLine(
      "[native-capture] Disabled via kodela.nativeCapture.enabled — skipping scanner.",
    );
  }

  const copilotSessionCapture = registerCopilotSessionCapture(
    workspace.repoRoot,
    outputChannel,
    { nativeCaptureService: nativeCopilotCapture },
  );
  context.subscriptions.push(copilotSessionCapture);

  // Auto-start daemon watch in AI tool context (idempotent and non-blocking).
  ensureCopilotAutoWatch(workspace, {
    trigger: "activation",
    outputChannel,
    onResult: (r) => controlCenterView.setAutoWatchIndicator(r),
  }).catch((err: unknown) => {
    outputChannel.appendLine(
      `[auto-watch] activation check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  // Gap 21 — startup nudge check: run once after activation, show a
  // non-intrusive notification when annotations need attention.
  // "Ignore" emits nag_ignored so the kill-switch health check can track it.
  runStartupNudgeCheck(workspace.repoRoot, telemetry).catch((err: unknown) => {
    outputChannel.appendLine(
      `[nudge] startup check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

async function runStartupNudgeCheck(
  repoRoot: string,
  telemetry: TelemetryService,
): Promise<void> {
  try {
    const result = await runNudge({ repoRoot });
    if (!result.needsAttention) return;

    const total =
      result.orphaned.length + result.uncertain.length + result.reviewRequired.length;

    const choice = await vscode.window.showInformationMessage(
      `Kodela: ${total} annotation${total !== 1 ? "s" : ""} need${total === 1 ? "s" : ""} attention (orphaned, uncertain, or review-required). Run \`kodela nudge\` to see details.`,
      "Open Kodela Log",
      "Ignore",
    );

    if (choice === "Ignore" || choice === undefined) {
      // Gap 21 — nag_ignored: user dismissed without acting.
      void telemetry.emitNagIgnored(total);
    }
  } catch {
    // Swallow errors — startup check is non-critical.
  }
}

export function deactivate(): void {
}
