// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import * as vscode from "vscode";
import crypto from "node:crypto";
import type { ContextEntry, Origin, UbaSignals } from "@kodela/core";
import { SCHEMA_VERSION, ubaScore, enrichEntry } from "@kodela/core";
import type { KodelaWorkspace } from "../workspace/kodela-workspace.js";
import { isSensitivePath } from "@kodela/cli";
import { resolveAuthor } from "../utils/author.js";

/**
 * Phase E — `onDidExecuteCommand` is not yet reflected in @types/vscode
 * (proposed API that was later stabilised). Access it via a safe runtime cast
 * so the code compiles without errors and degrades gracefully on older hosts.
 * Reuses the same pattern as AiToolTracker in ai-tool-resolver.ts.
 */
type CommandsWithOnExecute = {
  onDidExecuteCommand?: (
    listener: (e: { command: string }) => void,
  ) => { dispose(): void };
};

type InsertionWindow = {
  filePath: string;
  linesAdded: number;
  firstEventAt: number;
  /**
   * Phase E — number of distinct `onDidChangeTextDocument` events accumulated
   * in this window. Many small events = human typing cadence; single event =
   * bulk insert (AI or paste).
   */
  changeEventCount: number;
  /**
   * Phase E — true when at least one change event contained a single
   * contiguous block of ≥ 20 lines, which is characteristic of a programmatic
   * (AI or paste) write rather than incremental human editing.
   */
  hasLargeContiguousBlock: boolean;
};

/**
 * Classification context computed by the UBA engine and forwarded to the
 * annotation save path so every auto-created entry carries accurate metadata.
 */
type InsertionClassification = {
  source: "ai" | "unknown" | "human";
  confidence: number;
  classificationScore: number;
  classificationSignals: Record<string, number>;
  status: "mapped" | "uncertain";
  reviewRequired: boolean;
  /**
   * Gap 24 — sub-classification for paste events.
   * `"bulk-insert"` is used when the large change was preceded by a paste
   * command rather than an AI-tool write. Must match the ContextEntrySchema
   * literal union for `subType`.
   */
  subType?: "bulk-insert";
};

export class AiInsertionDetector implements vscode.Disposable {
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _windows = new Map<string, InsertionWindow>();

  /**
   * Per-file cooldown set (Gap 10d).
   * Tracks which absolute file paths currently have a notification shown.
   * A 10-second cooldown is applied per file independently, so notifications
   * for different files never block each other.
   */
  private readonly _notificationShown = new Set<string>();

  /**
   * Phase E — timestamp of the last observed paste command execution.
   * Used to distinguish copy-paste bulk inserts from AI-generated writes.
   * Set via `onDidExecuteCommand` when `editor.action.clipboardPasteAction` fires.
   */
  private _lastPasteAt = 0;

  constructor(private readonly _workspace: KodelaWorkspace) {}

  register(context: vscode.ExtensionContext): void {
    this._disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        this._handleChange(event);
      }),
    );

    // Phase E — paste detection.
    // `editor.action.clipboardPasteAction` fires just before (or atomically
    // with) the resulting onDidChangeTextDocument event. We record the
    // timestamp here and compare it in the threshold-check path below.
    const cmds = vscode.commands as unknown as CommandsWithOnExecute;
    if (typeof cmds.onDidExecuteCommand === "function") {
      const sub = cmds.onDidExecuteCommand((e) => {
        if (e.command === "editor.action.clipboardPasteAction") {
          this._lastPasteAt = Date.now();
        }
      });
      if (sub) this._disposables.push(sub);
    }

    // Gap 10c — subscribe to low-confidence heal results.
    // When the heal engine downgrades entries to "uncertain" for recently-edited
    // files, fire the suggestion prompt so developers can act immediately.
    this._disposables.push(
      this._workspace.onLowConfidenceDetected((entries) => {
        void this._showLowConfidencePrompt(entries);
      }),
    );

    context.subscriptions.push(this);
  }

  private _handleChange(event: vscode.TextDocumentChangeEvent): void {
    const cfg = vscode.workspace.getConfiguration("kodela");
    if (!cfg.get<boolean>("enable", true)) return;
    if (!cfg.get<boolean>("detectAiInsertions", true)) return;

    const doc = event.document;
    if (doc.uri.scheme !== "file") return;

    const kodelaConfig = this._workspace.config;
    // Gap 20e — kodela.minInsertionLines VS Code setting overrides the value
    // from kodela.config.json when present.  This lets each team tune the
    // threshold without touching the shared config file.
    const vsCodeThreshold = cfg.get<number>("minInsertionLines");
    const threshold =
      typeof vsCodeThreshold === "number" && vsCodeThreshold >= 1
        ? vsCodeThreshold
        : kodelaConfig.ai_detection.editor_insertion_min_lines;
    const windowMs = kodelaConfig.ai_detection.insertion_speed_threshold_ms;

    let totalLinesAdded = 0;
    // Phase E — detect large contiguous block in this individual event.
    let eventHasLargeBlock = false;
    for (const change of event.contentChanges) {
      const added = (change.text.match(/\n/g) ?? []).length;
      totalLinesAdded += added;
      if (added >= 20) eventHasLargeBlock = true;
    }

    if (totalLinesAdded < threshold) return;

    const absPath = doc.uri.fsPath;
    const now = Date.now();
    const existing = this._windows.get(absPath);

    if (!existing || now - existing.firstEventAt > windowMs) {
      this._windows.set(absPath, {
        filePath: absPath,
        linesAdded: totalLinesAdded,
        firstEventAt: now,
        changeEventCount: 1,
        hasLargeContiguousBlock: eventHasLargeBlock,
      });
    } else {
      existing.linesAdded += totalLinesAdded;
      existing.changeEventCount += 1;
      if (eventHasLargeBlock) existing.hasLargeContiguousBlock = true;
    }

    const window = this._windows.get(absPath)!;

    // Gap 10d — per-file cooldown replaces the previous global boolean.
    if (window.linesAdded >= threshold && !this._notificationShown.has(absPath)) {
      this._notificationShown.add(absPath);

      // Phase E — classify using UBA signals before showing the prompt.
      const classification = this._classify(window);

      void this._showInsertionPrompt(doc, window.linesAdded, classification);
      this._windows.delete(absPath);
      setTimeout(() => {
        this._notificationShown.delete(absPath);
      }, 10_000);
    }
  }

  /**
   * Phase E — UBA classification for a completed insertion window.
   *
   * Computes behavioral signals from the window's accumulated metadata and
   * delegates to the shared `ubaScore()` fusion engine from @kodela/core.
   * Paste events are specially handled: a large single-block insert preceded
   * by a paste command is classified as `subType: "bulk-insert"` regardless
   * of what the UBA score says — because the edit origin is known at the API
   * level and requires no behavioral inference.
   */
  private _classify(window: InsertionWindow): InsertionClassification {
    // Phase E — paste detection: check if a paste command fired within 2s
    // before or after this window's threshold was reached. The generous window
    // handles the timing ambiguity between onDidExecuteCommand and
    // onDidChangeTextDocument across different VS Code versions.
    const isPaste = Date.now() - this._lastPasteAt < 2_000;

    if (isPaste) {
      return {
        source: "unknown",
        confidence: 0.5,
        classificationScore: 0.5,
        classificationSignals: {
          editPattern: 0.5,
          temporalSignature: 0.5,
          fileScope: 0.0,
          structuralChange: 0.5,
          environment: 0.0,
        },
        status: "uncertain",
        reviewRequired: false,
        subType: "bulk-insert",
      };
    }

    // Phase E — build UBA signals from the insertion window.
    const hasKnownEnvSignal =
      !!process.env["REPL_ID"] ||
      !!process.env["REPLIT_DEV_DOMAIN"] ||
      !!process.env["CURSOR_SESSION_ID"] ||
      !!process.env["CURSOR_TRACE_ID"] ||
      !!process.env["KODELA_AGENT"];
    const isExplicitAgentSignal = !!process.env["KODELA_AGENT"];

    const signals: UbaSignals = {
      linesAdded: window.linesAdded,
      // A single change event in the window = bulk write (AI-like burst).
      writeEventCount: window.changeEventCount,
      isSingleBatch: window.changeEventCount === 1,
      // The VS Code extension does not track inter-batch gap per-file.
      interBatchGapMs: undefined,
      // VS Code detector fires per-file — fileCount is always 1 here.
      fileCount: 1,
      hasLargeContiguousBlock: window.hasLargeContiguousBlock,
      hasKnownEnvSignal,
      isExplicitAgentSignal,
    };

    const result = ubaScore(signals);

    // Bug 4 fix — Attribution-aware source promotion (mirrors watch.ts logic).
    // When a specific AI IDE env var is present, the UBA behavioral "unknown"
    // in the uncertain zone should not suppress the confirmed tool identity.
    // Promote to "ai" while preserving "uncertain" status.
    let source = result.source;
    if (source === "unknown" && hasKnownEnvSignal) {
      source = "ai";
    }

    return {
      source,
      confidence: result.confidence,
      classificationScore: result.classificationScore,
      classificationSignals: result.classificationSignals,
      status: result.status,
      reviewRequired: result.reviewRequired,
    };
  }

  /**
   * Prompt shown when a large AI-style insertion is detected in the editor.
   *
   * Gap 10a — message text aligned to the ticket spec: "Significant change detected".
   * Gap 10b — three distinct actions: Accept, Edit, Dismiss.
   *   - Accept: quick path — prompts for a note, saves with defaults.
   *   - Edit:   full form  — prompts for severity first, then a note, then saves.
   *   - Dismiss: no action.
   */
  private async _showInsertionPrompt(
    doc: vscode.TextDocument,
    linesAdded: number,
    classification: InsertionClassification,
  ): Promise<void> {
    const relPath = vscode.workspace.asRelativePath(doc.uri);
    const kodelaConfig = this._workspace.config;
    const sensitivePaths = kodelaConfig.security.sensitive_paths;
    const isSensitive = isSensitivePath(relPath, sensitivePaths);
    const sensitiveHint = isSensitive ? " (security-sensitive file)" : "";

    // Gap 10a — spec-aligned message
    const choice = await vscode.window.showInformationMessage(
      "Significant change detected",
      { modal: false },
      "Accept",
      "Edit",
      "Dismiss",
    );

    if (!choice || choice === "Dismiss") return;

    if (choice === "Accept") {
      await this._quickAnnotate({
        doc,
        relPath,
        linesAdded,
        isSensitive,
        detailHint: `${linesAdded} lines added in ${relPath}${sensitiveHint}`,
        classification,
      });
    } else {
      // "Edit" — full annotation form
      await this._fullAnnotate({
        doc,
        relPath,
        linesAdded,
        isSensitive,
        detailHint: `${linesAdded} lines added in ${relPath}${sensitiveHint}`,
        classification,
      });
    }
  }

  /**
   * Quick annotation path (Accept).
   * Prompts for a note only; severity and tags are derived automatically.
   */
  private async _quickAnnotate(opts: {
    doc: vscode.TextDocument;
    relPath: string;
    linesAdded: number;
    isSensitive: boolean;
    detailHint: string;
    classification: InsertionClassification;
  }): Promise<void> {
    const { doc, relPath, isSensitive, detailHint, classification } = opts;

    const note = await vscode.window.showInputBox({
      title: "Add Context Annotation",
      prompt: detailHint,
      placeHolder: "e.g. Payment retry logic generated by Copilot — needs review",
      validateInput: (v) => (v.trim() ? null : "Note cannot be empty"),
    });
    if (!note) return;

    await this._saveAnnotation({
      doc,
      relPath,
      note,
      severity: isSensitive ? "high" : "low",
      isSensitive,
      linesAdded: opts.linesAdded,
      classification,
    });
  }

  /**
   * Full annotation form (Edit).
   *
   * Gap 10b — severity quick-pick, then note input.
   * Gap 13 — optional "Why this approach?" decision rationale input.
   *   Captures origin.summary when the developer provides a reason.
   *   Skipped silently if the developer leaves it blank.
   */
  private async _fullAnnotate(opts: {
    doc: vscode.TextDocument;
    relPath: string;
    linesAdded: number;
    isSensitive: boolean;
    detailHint: string;
    classification: InsertionClassification;
  }): Promise<void> {
    const { doc, relPath, isSensitive, detailHint, classification } = opts;

    const severityItem = await vscode.window.showQuickPick(
      [
        {
          label: "$(info) low",
          description: "Minor or speculative annotation",
          value: "low" as const,
        },
        {
          label: "$(warning) medium",
          description: "Meaningful risk — worth a review",
          value: "medium" as const,
        },
        {
          label: "$(error) high",
          description: "High-risk change — review required",
          value: "high" as const,
        },
        {
          label: "$(flame) critical",
          description: "Do not merge without explicit sign-off",
          value: "critical" as const,
        },
      ],
      {
        title: "Annotation Severity",
        placeHolder: "Select severity level for this annotation",
      },
    );
    if (!severityItem) return;

    const note = await vscode.window.showInputBox({
      title: "Add Context Annotation",
      prompt: detailHint,
      placeHolder: "e.g. Payment retry logic generated by Copilot — needs review",
      validateInput: (v) => (v.trim() ? null : "Note cannot be empty"),
    });
    if (!note) return;

    // Gap 13 — optional decision rationale (origin.summary).
    // Shown after the note; blank input is accepted and the field is omitted.
    const decisionRationale = await vscode.window.showInputBox({
      title: "AI Decision Rationale (optional)",
      prompt: "Why was this approach chosen over alternatives?",
      placeHolder:
        "e.g. Exponential backoff chosen over fixed delay — lower p99 latency under load",
    });

    const origin: Origin | undefined =
      decisionRationale && decisionRationale.trim()
        ? { type: "ai", summary: decisionRationale.trim() }
        : undefined;

    await this._saveAnnotation({
      doc,
      relPath,
      note,
      severity: severityItem.value,
      isSensitive,
      origin,
      linesAdded: opts.linesAdded,
      classification,
    });
  }

  /**
   * Prompt shown when a heal batch downgrades entries to "uncertain" (Gap 10c).
   * Groups entries by file and shows one notification per file that has at least
   * one uncertain entry, subject to the per-file cooldown.
   */
  private async _showLowConfidencePrompt(entries: ContextEntry[]): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("kodela");
    if (!cfg.get<boolean>("enable", true)) return;

    const byFile = new Map<string, ContextEntry[]>();
    for (const entry of entries) {
      const list = byFile.get(entry.filePath) ?? [];
      list.push(entry);
      byFile.set(entry.filePath, list);
    }

    for (const [relPath, fileEntries] of byFile) {
      const absPath = `${this._workspace.repoRoot}/${relPath}`;

      if (this._notificationShown.has(absPath)) continue;

      this._notificationShown.add(absPath);
      setTimeout(() => this._notificationShown.delete(absPath), 10_000);

      const count = fileEntries.length;
      const plural = count !== 1 ? "s" : "";

      const choice = await vscode.window.showWarningMessage(
        "Significant change detected",
        { modal: false },
        "Review",
        "Dismiss",
      );

      if (choice !== "Review") continue;

      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(absPath),
      ).then(
        (d) => d,
        () => null,
      );
      if (!doc) continue;

      const note = await vscode.window.showInputBox({
        title: `Low-confidence annotation${plural} in ${relPath}`,
        prompt: `${count} annotation${plural} dropped below confidence threshold — add a review note`,
        placeHolder: "e.g. Confirm this section hasn't been silently rearranged",
        validateInput: (v) => (v.trim() ? null : "Note cannot be empty"),
      });
      if (!note) continue;

      const kodelaConfig = this._workspace.config;
      const sensitivePaths = kodelaConfig.security.sensitive_paths;
      const isSensitive = isSensitivePath(relPath, sensitivePaths);

      await this._saveAnnotation({
        doc,
        relPath,
        note,
        severity: isSensitive ? "high" : "medium",
        isSensitive,
        // Low-confidence heal prompt: user is reviewing, treat as human-confirmed.
        classification: {
          source: "human",
          confidence: 1.0,
          classificationScore: 0.1,
          classificationSignals: {},
          status: "mapped",
          reviewRequired: false,
        },
      });
    }
  }

  private async _saveAnnotation(opts: {
    doc: vscode.TextDocument;
    relPath: string;
    note: string;
    severity: ContextEntry["severity"];
    isSensitive: boolean;
    linesAdded?: number;
    origin?: Origin;
    classification: InsertionClassification;
  }): Promise<void> {
    const {
      doc,
      relPath,
      note,
      severity,
      isSensitive,
      linesAdded,
      origin,
      classification,
    } = opts;

    const activeEditor = vscode.window.activeTextEditor;
    const isActiveDoc =
      activeEditor?.document.uri.fsPath === doc.uri.fsPath;
    const lineStart = isActiveDoc
      ? activeEditor!.selection.start.line + 1
      : 1;
    const selEnd = isActiveDoc ? activeEditor!.selection.end : undefined;
    const lineEnd = isActiveDoc
      ? selEnd &&
        selEnd.character === 0 &&
        selEnd.line > activeEditor!.selection.start.line
        ? selEnd.line
        : selEnd
          ? selEnd.line + 1
          : lineStart
      : lineStart;

    const aiAttribution = this._workspace.getAiToolAttribution();
    const author = await resolveAuthor(this._workspace.repoRoot);

    // Phase E — derive tags from UBA classification.
    // AI-classified entries keep the "ai" tag; uncertain/human entries get
    // "review" so they surface in filtered views without asserting authorship.
    const baseTags = isSensitive ? ["security-sensitive"] : [];
    const sourceTags =
      classification.source === "ai"
        ? ["ai", ...baseTags]
        : classification.source === "unknown"
          ? ["review", ...baseTags]
          : baseTags;

    try {
      const partialEntry: ContextEntry = {
        schemaVersion: SCHEMA_VERSION,
        id: crypto.randomUUID(),
        filePath: relPath,
        astAnchor: null,
        contentHash: "0".repeat(64),
        lineRange: { start: lineStart, end: lineEnd },
        note,
        author,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        severity,
        tags: sourceTags,
        // Phase E — UBA-derived source and confidence (not hardcoded "ai" / 1.0).
        source: classification.source,
        confidence: classification.confidence,
        classificationScore: classification.classificationScore,
        classificationSignals:
          Object.keys(classification.classificationSignals).length > 0
            ? classification.classificationSignals
            : undefined,
        ...(classification.subType ? { subType: classification.subType } : {}),
        status: classification.status,
        reviewRequired: classification.reviewRequired,
        ...(aiAttribution ? { aiTool: aiAttribution.aiTool, link: aiAttribution.link } : {}),
        ...(origin ? { origin } : {}),
      };

      const enrichedEntry = enrichEntry(partialEntry, {
        sourceType: "manual",
        isExplicitAgent: Boolean(aiAttribution?.aiTool || process.env["KODELA_AGENT"]),
        trustLevel:
          classification.source === "ai"
            ? (aiAttribution?.aiTool ? "high" : "medium")
            : "low",
        fileContent: doc.getText(),
        linesAdded: linesAdded ?? 0,
        linesRemoved: 0,
        fileCount: 1,
        aiProposalNote: note,
      });

      await this._workspace.saveEntry(enrichedEntry);
      void vscode.window.showInformationMessage(
        `✓ AI context entry added for ${relPath}`,
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Failed to save context entry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  dispose(): void {
    for (const d of this._disposables) d.dispose();
  }
}
