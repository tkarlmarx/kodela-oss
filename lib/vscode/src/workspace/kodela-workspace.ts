// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import * as vscode from "vscode";
import path from "node:path";
import type { ContextEntry } from "@kodela/core";
import type { KodelaConfig } from "@kodela/cli";
import { heal, formatWatchBatchResult } from "@kodela/cli";
import { startWatcher } from "@kodela/watcher";
import type { Watcher, BatchedEvent } from "@kodela/watcher";
import { computeDiff, isLikelyAIChange } from "@kodela/diff";
import {
  findRepoRoot,
  loadAllEntries,
  loadWorkspaceConfig,
  saveEntry,
  removeEntry,
} from "../storage/bridge.js";
import {
  AiToolTracker,
  resolveToolNameAttribution,
} from "../providers/ai-tool-resolver.js";
import type { AiToolAttribution } from "../providers/ai-tool-resolver.js";

function formatTime(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export class KodelaWorkspace implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  private readonly _onHealingStateChange = new vscode.EventEmitter<boolean>();
  readonly onHealingStateChange: vscode.Event<boolean> =
    this._onHealingStateChange.event;

  /**
   * Fires after each heal batch with the subset of context entries that now
   * have status `"uncertain"` for the files that were just processed.
   * Subscribers (e.g. AiInsertionDetector) can use this to show a suggestion
   * prompt for low-confidence annotations.
   */
  private readonly _onLowConfidenceDetected = new vscode.EventEmitter<ContextEntry[]>();
  readonly onLowConfidenceDetected: vscode.Event<ContextEntry[]> =
    this._onLowConfidenceDetected.event;

  private _entries: ContextEntry[] = [];
  private _healingCount = 0;
  private _disposed = false;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _kodelaDirWatcher: vscode.FileSystemWatcher;
  private _sourceWatcher: Watcher;
  private _debounceMs: number;

  private readonly _contentCache = new Map<string, string>();
  private readonly _aiChangedFiles = new Set<string>();
  private readonly _aiToolTracker: AiToolTracker;

  private constructor(
    private readonly _repoRoot: string,
    private readonly _config: KodelaConfig,
    debounceMs: number = 500,
    private readonly _outputChannel?: vscode.OutputChannel,
  ) {
    this._debounceMs = debounceMs;
    this._aiToolTracker = new AiToolTracker();
    this._aiToolTracker.start();
    this._kodelaDirWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        vscode.Uri.file(path.join(_repoRoot, ".kodela")),
        "**",
      ),
    );

    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === "file") {
        const rel = path
          .relative(_repoRoot, document.uri.fsPath)
          .replace(/\\/g, "/");
        this._contentCache.set(rel, document.getText());
      }
    }

    const refresh = (): void => {
      void this.refresh();
    };

    this._disposables.push(
      this._kodelaDirWatcher.onDidChange(refresh),
      this._kodelaDirWatcher.onDidCreate(refresh),
      this._kodelaDirWatcher.onDidDelete(refresh),
      this._kodelaDirWatcher,
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (document.uri.scheme === "file") {
          const rel = path
            .relative(this._repoRoot, document.uri.fsPath)
            .replace(/\\/g, "/");
          if (!this._contentCache.has(rel)) {
            this._contentCache.set(rel, document.getText());
          }
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme === "file") {
          this._handleSave(document);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("kodela.debounceMs")) {
          const newDebounceMs = vscode.workspace
            .getConfiguration("kodela")
            .get<number>("debounceMs", 500);
          this._restartSourceWatcher(newDebounceMs);
        }
      }),
    );

    this._sourceWatcher = startWatcher({
      rootDir: _repoRoot,
      debounceMs,
      ignored: [/[/\\]\.kodela[/\\]/],
    });

    this._sourceWatcher.on("ready", () => {
      this._sourceWatcher.on("batch", (batch: BatchedEvent) => {
        void this._healBatch(batch);
      });
    });
  }

  static async create(
    context: vscode.ExtensionContext,
    outputChannel?: vscode.OutputChannel,
  ): Promise<KodelaWorkspace> {
    const workspaceDir =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const repoRoot = await findRepoRoot(workspaceDir);
    const config = await loadWorkspaceConfig(repoRoot);
    const debounceMs = vscode.workspace
      .getConfiguration("kodela")
      .get<number>("debounceMs", 500);
    const workspace = new KodelaWorkspace(repoRoot, config, debounceMs, outputChannel);
    await workspace.refresh();
    context.subscriptions.push(workspace);
    return workspace;
  }

  get repoRoot(): string {
    return this._repoRoot;
  }

  get config(): KodelaConfig {
    return this._config;
  }

  get debounceMs(): number {
    return this._debounceMs;
  }

  get allEntries(): ReadonlyArray<ContextEntry> {
    return this._entries;
  }

  getEntriesForFile(absoluteFilePath: string): ContextEntry[] {
    const rel = path
      .relative(this._repoRoot, absoluteFilePath)
      .replace(/\\/g, "/");
    return this._entries.filter((e) => e.filePath === rel);
  }

  isFileLikelyAIChanged(absoluteFilePath: string): boolean {
    const rel = path
      .relative(this._repoRoot, absoluteFilePath)
      .replace(/\\/g, "/");
    return this._aiChangedFiles.has(rel);
  }

  async refresh(): Promise<void> {
    try {
      this._entries = await loadAllEntries(this._repoRoot);
    } catch (err: unknown) {
      console.warn("[Kodela] Unexpected error during workspace refresh:", err);
      this._entries = [];
    }
    if (!this._disposed) {
      this._onDidChange.fire();
    }
  }

  async saveEntry(entry: ContextEntry): Promise<void> {
    await saveEntry(this._repoRoot, entry);
    await this.refresh();
  }

  async removeEntry(id: string): Promise<void> {
    await removeEntry(this._repoRoot, id);
    await this.refresh();
  }

  /**
   * Returns the AI tool attribution for the most recently used AI module,
   * respecting the `kodela.preferredAiTool` workspace setting.
   *
   * Resolution order:
   *   1. `kodela.preferredAiTool` = "none"  →  undefined (disabled)
   *   2. `kodela.preferredAiTool` = "<name>" →  { aiTool, link } for that name
   *   3. Most recent command within `kodela.aiDetectionWindowMs`
   *   4. undefined (nothing detected)
   */
  getAiToolAttribution(): AiToolAttribution | undefined {
    const cfg = vscode.workspace.getConfiguration("kodela");
    const preferred = cfg.get<string | null>("preferredAiTool", null);
    if (preferred !== null && preferred !== undefined && preferred !== "") {
      if (preferred.toLowerCase() === "none") return undefined;
      return resolveToolNameAttribution(preferred);
    }
    const windowMs = cfg.get<number>("aiDetectionWindowMs", 60_000);
    return this._aiToolTracker.getMostRecentWithin(windowMs);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._sourceWatcher.stop();
    this._aiToolTracker.dispose();
    this._onHealingStateChange.dispose();
    this._onLowConfidenceDetected.dispose();
    this._onDidChange.dispose();
    this._contentCache.clear();
    this._aiChangedFiles.clear();
    for (const d of this._disposables) {
      d.dispose();
    }
  }

  private _restartSourceWatcher(debounceMs: number): void {
    this._sourceWatcher.stop();
    this._debounceMs = debounceMs;
    this._sourceWatcher = startWatcher({
      rootDir: this._repoRoot,
      debounceMs,
      ignored: [/[/\\]\.kodela[/\\]/],
    });
    this._sourceWatcher.on("ready", () => {
      this._sourceWatcher.on("batch", (batch: BatchedEvent) => {
        void this._healBatch(batch);
      });
    });
    this._outputChannel?.appendLine(
      `[config] debounce changed to ${debounceMs} ms — watcher restarted`,
    );
  }

  private _handleSave(document: vscode.TextDocument): void {
    const rel = path
      .relative(this._repoRoot, document.uri.fsPath)
      .replace(/\\/g, "/");
    const newContent = document.getText();
    const oldContent = this._contentCache.get(rel);

    this._contentCache.set(rel, newContent);

    if (oldContent === undefined || oldContent === newContent) return;

    const result = computeDiff({ oldContent, newContent });
    const aiChanged = isLikelyAIChange(result);
    const wasChanged = this._aiChangedFiles.has(rel);

    if (aiChanged === wasChanged) return;

    if (aiChanged) {
      this._aiChangedFiles.add(rel);
    } else {
      this._aiChangedFiles.delete(rel);
    }
    this._onDidChange.fire();
  }

  private async _healBatch(batch: BatchedEvent): Promise<void> {
    // A batch can already be queued when the workspace is disposed (the watcher
    // is stopped in dispose(), but an in-flight batch event may still arrive).
    // Performing heal work or firing disposed EventEmitters here surfaces as
    // "asynchronous activity after the test ended" and, in production, as work
    // against a torn-down workspace. Bail out cleanly instead.
    if (this._disposed) return;

    const seen = new Set<string>();
    const relFilePaths = batch.events
      .map((e) => path.relative(this._repoRoot, e.filePath).replace(/\\/g, "/"))
      .filter((p) => { if (seen.has(p)) return false; seen.add(p); return true; });

    for (const relPath of relFilePaths) {
      this._contentCache.delete(relPath);
    }
    for (const event of batch.events) {
      if (event.renameFrom) {
        const oldRel = path.relative(this._repoRoot, event.renameFrom).replace(/\\/g, "/");
        this._contentCache.delete(oldRel);
      }
    }

    this._healingCount++;
    if (this._healingCount === 1) {
      this._onHealingStateChange.fire(true);
    }

    const t0 = Date.now();
    try {
      const result = await heal(batch.events, {
        repoRoot: this._repoRoot,
        debug: false,
        dryRun: false,
        config: this._config,
        contentCache: this._contentCache,
      });
      const durationMs = Date.now() - t0;
      this._outputChannel?.appendLine(
        `[${formatTime()}] ${formatWatchBatchResult({
          filePaths: relFilePaths,
          healed: result.updated,
          total: result.updated + result.orphaned + result.uncertain,
          failed: result.orphaned,
          dryRun: false,
          durationMs,
          updated: result.updated,
          orphaned: result.orphaned,
          uncertain: result.uncertain,
        })}`,
      );

      for (const relPath of relFilePaths) {
        this._aiChangedFiles.delete(relPath);
      }

      // Disposal can land while heal() was awaited — don't touch emitters after.
      if (this._disposed) return;

      await this.refresh();

      const uncertainForBatch = this._entries.filter(
        (e) =>
          e.status === "uncertain" && relFilePaths.includes(e.filePath),
      );
      if (uncertainForBatch.length > 0) {
        this._onLowConfidenceDetected.fire(uncertainForBatch);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._outputChannel?.appendLine(`[${formatTime()}] [watch] Error during auto-heal: ${msg}`);
      this._outputChannel?.show(true);
      console.warn("[Kodela] Error during auto-heal:", err);
    } finally {
      this._healingCount--;
      if (this._healingCount === 0 && !this._disposed) {
        this._onHealingStateChange.fire(false);
      }
    }
  }
}
