// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { listSessions, readContextEntry, readSession } from "@kodela/core";
import {
  appendSessionTimelineEvent,
  appendUserTurn,
  appendAssistantTurn,
  appendSessionCaptureSource,
  closeSession,
  synthesiseAndWriteSessionSummary,
  startSession,
  updateSessionActor,
  updateSessionAnnotation,
  updateSessionGitSnapshot,
  updateSessionGoal,
  updateSessionIntent,
} from "@kodela/core/sessions";
import type { NativeCopilotCaptureService } from "./native-copilot-capture.js";
import type { KodelaSession } from "@kodela/core";
import type { SessionGitSnapshot } from "@kodela/core/sessions";
import { resolveAuthor } from "../utils/author.js";

const execFileAsync = promisify(execFile);

const PARTICIPANT_ID = "kodela.context";
const PROMPT_SOURCE_TAG = "vscode-chat-participant";
const LM_SOURCE_TAG = "copilot-lm-api";
const DEFAULT_IDLE_CLOSE_MS = 60_000;
const DEFAULT_ENRICHMENT_DELAY_MS = 5_000;
const DEFAULT_RESUME_WINDOW_MS = 30 * 60_000;
const DEFAULT_CAPTURE_CONFIDENCE = 0.82;
const ENRICHED_CONFIDENCE = 0.88;

type GitRepositoryState = {
  HEAD?: { name?: string; commit?: string };
  workingTreeChanges?: ReadonlyArray<{ resourceUri?: vscode.Uri }>;
  indexChanges?: ReadonlyArray<{ resourceUri?: vscode.Uri }>;
  mergeChanges?: ReadonlyArray<{ resourceUri?: vscode.Uri }>;
};

type GitLogEntry = { message?: string };

type GitRepository = {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
  log?: (options?: { maxEntries?: number }) => Promise<readonly GitLogEntry[]>;
};

type GitApi = {
  repositories: readonly GitRepository[];
};

type GitExtensionExports = {
  getAPI(version: number): GitApi;
};

export type CopilotSessionCaptureOptions = {
  idleCloseMs?: number;
  enrichmentDelayMs?: number;
  resumeWindowMs?: number;
  sessionIdFactory?: () => string;
  nativeCaptureService?: NativeCopilotCaptureService;
};

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

function toRelativePath(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

function extractHistoryText(turn: unknown): string {
  if (!turn || typeof turn !== "object" || !("response" in turn)) return "";
  const response = (turn as { response?: readonly unknown[] }).response;
  if (!Array.isArray(response)) return "";

  const chunks: string[] = [];
  for (const part of response) {
    if (!part || typeof part !== "object" || !("value" in part)) continue;
    const value = (part as { value?: unknown }).value;
    if (typeof value === "string") {
      chunks.push(value);
      continue;
    }
    if (value && typeof value === "object" && "value" in value) {
      const textValue = (value as { value?: unknown }).value;
      if (typeof textValue === "string") {
        chunks.push(textValue);
      }
    }
  }

  return chunks.join("\n").trim();
}

function isRequestTurn(turn: unknown): turn is { prompt: string } {
  return !!turn && typeof turn === "object" && typeof (turn as { prompt?: unknown }).prompt === "string";
}

function formatDiffStats(stats: NonNullable<SessionGitSnapshot["diffStats"]> | undefined): string {
  if (!stats) return "working=0, staged=0, merge=0, total=0";
  return (
    `working=${stats.workingTree ?? 0}, staged=${stats.index ?? 0}, ` +
    `merge=${stats.merge ?? 0}, total=${stats.total ?? 0}`
  );
}

function buildSynthesisPrompt(session: KodelaSession): string {
  const files = session.git?.end?.filesChanged ?? session.filesChanged;
  const fileList = files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : "- (no file paths captured)";

  const diffStats = formatDiffStats(session.git?.end?.diffStats);
  const goal = session.goal?.trim() || session.intent?.userPrompt?.trim() || "(no explicit prompt captured)";
  const reasoning = session.annotation?.reasoning?.trim() || "(no assistant reasoning snippet captured)";
  const branch =
    session.git?.end?.branch ??
    session.git?.start?.branch ??
    session.intent?.branchContext ??
    "(unknown)";

  return [
    "A developer just finished a coding session in VS Code.",
    "",
    `Goal/user prompt: ${goal}`,
    `Branch: ${branch}`,
    `Diff stats: ${diffStats}`,
    "Files changed:",
    fileList,
    "",
    `Assistant reasoning preview: ${reasoning}`,
    "",
    "In 2-3 sentences, explain what they were trying to accomplish and what approach they took.",
    "Write this as handoff context for the next developer.",
  ].join("\n");
}

export class CopilotSessionCapture implements vscode.Disposable {
  private readonly _idleCloseMs: number;
  private readonly _enrichmentDelayMs: number;
  private readonly _resumeWindowMs: number;
  private readonly _sessionIdFactory: () => string;
  private readonly _nativeCaptureService?: NativeCopilotCaptureService;

  private _activeSessionId: string | undefined;
  private _idleTimer: NodeJS.Timeout | undefined;
  private readonly _enrichmentTimers = new Set<NodeJS.Timeout>();
  private _participant: vscode.ChatParticipant | undefined;
  private _disposed = false;

  constructor(
    private readonly _repoRoot: string,
    private readonly _outputChannel?: vscode.OutputChannel,
    options: CopilotSessionCaptureOptions = {},
  ) {
    this._idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
    this._enrichmentDelayMs = options.enrichmentDelayMs ?? DEFAULT_ENRICHMENT_DELAY_MS;
    this._resumeWindowMs = options.resumeWindowMs ?? DEFAULT_RESUME_WINDOW_MS;
    this._sessionIdFactory = options.sessionIdFactory ?? (() => randomUUID());
    this._nativeCaptureService = options.nativeCaptureService;

    const chatApi = (vscode as unknown as { chat?: typeof vscode.chat }).chat;
    if (!chatApi || typeof chatApi.createChatParticipant !== "function") {
      this._log("VS Code chat API unavailable; skipping participant capture registration.");
      return;
    }

    this._participant = vscode.chat.createChatParticipant(
      PARTICIPANT_ID,
      async (request, context, response, token) =>
        this._handleChatRequest(request, context, response, token),
    );
    this._participant.iconPath = new vscode.ThemeIcon("comment-discussion");
    this._log(`Registered chat participant: ${PARTICIPANT_ID}`);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = undefined;
    }

    for (const timer of this._enrichmentTimers) {
      clearTimeout(timer);
    }
    this._enrichmentTimers.clear();

    this._participant?.dispose();
    this._participant = undefined;

    if (this._activeSessionId) {
      const pending = this._activeSessionId;
      this._activeSessionId = undefined;
      void this._closeSession(pending, "dispose");
    }
  }

  private async _handleChatRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<vscode.ChatResult | void> {
    const sessionId = await this._ensureActiveSession(request);
    if (!sessionId) {
      response.markdown("Kodela could not initialize session capture for this request.");
      return;
    }

    const userTurn = await appendUserTurn(
      this._repoRoot,
      sessionId,
      request.prompt,
      { source: PROMPT_SOURCE_TAG },
    ).catch(() => null);

    await appendSessionTimelineEvent(this._repoRoot, sessionId, {
      type: "chat-request-captured",
      source: PROMPT_SOURCE_TAG,
      data: {
        promptPreview: request.prompt.slice(0, 500),
        historyTurns: context.history.length,
        referencesCount: request.references?.length ?? 0,
        ...(userTurn ? { userTurnId: userTurn.id, seq: userTurn.seq } : {}),
      },
    }).catch(() => undefined);

    await updateSessionGoal(this._repoRoot, sessionId, request.prompt).catch(() => undefined);
    await updateSessionIntent(this._repoRoot, sessionId, {
      userPrompt: request.prompt,
      source: PROMPT_SOURCE_TAG,
      confidence: DEFAULT_CAPTURE_CONFIDENCE,
    }).catch(() => undefined);

    const model = await this._resolveModel(request.model);
    if (!model) {
      response.markdown("Kodela capture could not find a Copilot chat model for this request.");
      this._scheduleSessionClose();
      return { metadata: { sessionId, source: PROMPT_SOURCE_TAG, captured: false } };
    }

    await updateSessionActor(this._repoRoot, sessionId, {
      tool: "vscode-copilot",
      model: model.id || model.family,
    }).catch(() => undefined);

    const messages = this._buildMessages(context, request.prompt);

    let assistantText = "";
    try {
      const modelResponse = await model.sendRequest(messages, {}, token);
      for await (const chunk of modelResponse.text) {
        assistantText += chunk;
        response.markdown(chunk);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._log(`Model request failed: ${message}`);
      response.markdown(`Kodela capture error: ${message}`);
      this._scheduleSessionClose();
      return { metadata: { sessionId, source: PROMPT_SOURCE_TAG, captured: false } };
    }

    const trimmedAssistant = assistantText.trim();
    if (trimmedAssistant.length > 0) {
      const assistantTurn = await appendAssistantTurn(
        this._repoRoot,
        sessionId,
        trimmedAssistant,
        {
          source: PROMPT_SOURCE_TAG,
          ...(userTurn ? { promptId: userTurn.id } : {}),
        },
      ).catch(() => null);
      await updateSessionAnnotation(this._repoRoot, sessionId, {
        // Persist full assistant context for downstream synthesis/handoff quality.
        reasoning: trimmedAssistant,
        source: PROMPT_SOURCE_TAG,
      }).catch(() => undefined);
      await appendSessionTimelineEvent(this._repoRoot, sessionId, {
        type: "chat-response-captured",
        source: PROMPT_SOURCE_TAG,
        data: {
          chars: trimmedAssistant.length,
          reasoningPreview: trimmedAssistant.slice(0, 500),
          ...(assistantTurn ? { assistantTurnId: assistantTurn.id, seq: assistantTurn.seq } : {}),
          ...(userTurn ? { promptId: userTurn.id } : {}),
        },
      }).catch(() => undefined);
    }

    this._scheduleSessionClose();

    return {
      metadata: {
        sessionId,
        source: PROMPT_SOURCE_TAG,
        captured: true,
      },
    };
  }

  private _buildMessages(
    context: vscode.ChatContext,
    prompt: string,
  ): vscode.LanguageModelChatMessage[] {
    const messages: vscode.LanguageModelChatMessage[] = [];

    for (const turn of context.history) {
      if (isRequestTurn(turn)) {
        messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        continue;
      }

      const text = extractHistoryText(turn);
      if (text) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(text));
      }
    }

    messages.push(vscode.LanguageModelChatMessage.User(prompt));
    return messages;
  }

  private async _ensureActiveSession(request: vscode.ChatRequest): Promise<string | undefined> {
    if (this._activeSessionId) return this._activeSessionId;

    const modelId = request.model?.id || request.model?.family;

    const resumed = await this._tryResumeSession(modelId);
    if (resumed) {
      const author = await resolveAuthor(this._repoRoot);
      await updateSessionActor(this._repoRoot, resumed.id, {
        tool: "vscode-copilot",
        model: modelId,
        ...(author !== "unknown" ? { author } : {}),
      }).catch(() => undefined);

      await appendSessionTimelineEvent(this._repoRoot, resumed.id, {
        type: "session-resumed",
        source: PROMPT_SOURCE_TAG,
        data: {
          ...(modelId ? { model: modelId } : {}),
          resumedAt: new Date().toISOString(),
        },
      }).catch(() => undefined);

      this._activeSessionId = resumed.id;
      this._log(`Resumed VS Code chat session: ${resumed.id}`);
      return resumed.id;
    }

    const sessionId = this._sessionIdFactory();

    try {
      await startSession(this._repoRoot, sessionId, {
        model: modelId,
        goal: request.prompt,
      });

      const author = await resolveAuthor(this._repoRoot);
      await updateSessionActor(this._repoRoot, sessionId, {
        tool: "vscode-copilot",
        model: modelId,
        ...(author !== "unknown" ? { author } : {}),
      }).catch(() => undefined);

      const startSnapshot = await this._captureGitSnapshot();
      if (startSnapshot) {
        await updateSessionGitSnapshot(this._repoRoot, sessionId, "start", startSnapshot).catch(() => undefined);
        await updateSessionIntent(this._repoRoot, sessionId, {
          branchContext: startSnapshot.branch,
          source: PROMPT_SOURCE_TAG,
          confidence: DEFAULT_CAPTURE_CONFIDENCE,
        }).catch(() => undefined);
      }

      this._activeSessionId = sessionId;
      this._log(`Started VS Code chat session: ${sessionId}`);

      // Path 5: capture source tag + memory snapshot at session start
      await appendSessionCaptureSource(this._repoRoot, sessionId, PROMPT_SOURCE_TAG).catch(() => undefined);
      void this._nativeCaptureService?.captureMemorySnapshot("start").catch(() => undefined);

      return sessionId;
    } catch (err) {
      this._log(`Failed to start session: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private _sessionLastActivityMs(session: KodelaSession): number {
    const timestamps = [
      session.startedAt,
      session.intent?.updatedAt,
      session.annotation?.updatedAt,
      session.git?.start?.capturedAt,
      session.git?.end?.capturedAt,
    ]
      .filter((value): value is string => typeof value === "string")
      .map((value) => new Date(value).getTime())
      .filter((value) => Number.isFinite(value));

    if (timestamps.length === 0) {
      return Date.now();
    }

    return Math.max(...timestamps);
  }

  private async _tryResumeSession(modelId?: string): Promise<KodelaSession | undefined> {
    let sessions: KodelaSession[];
    try {
      sessions = await listSessions(this._repoRoot);
    } catch {
      sessions = [];
    }
    if (sessions.length === 0) return undefined;

    const now = Date.now();
    const candidates = sessions
      .filter((session) => !session.endedAt)
      .filter((session) => !session.actor?.tool || session.actor.tool === "vscode-copilot")
      .filter((session) => now - this._sessionLastActivityMs(session) <= this._resumeWindowMs)
      .sort((a, b) => this._sessionLastActivityMs(b) - this._sessionLastActivityMs(a));

    if (candidates.length === 0) return undefined;

    if (!modelId) return candidates[0];

    return candidates.find((session) => !session.model || session.model === modelId) ?? candidates[0];
  }

  private _scheduleSessionClose(): void {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
    }

    this._idleTimer = setTimeout(() => {
      const sessionId = this._activeSessionId;
      this._activeSessionId = undefined;
      this._idleTimer = undefined;
      if (!sessionId) return;
      void this._closeSession(sessionId, "idle");
    }, this._idleCloseMs);
  }

  private async _closeSession(sessionId: string, reason: string): Promise<void> {
    // GAP 4: absorb any codeChanges captured by the passive auto-session
    if (this._nativeCaptureService) {
      await this._nativeCaptureService.absorbAutoSessionCodeChanges(sessionId).catch(() => undefined);
    }

    // Path 5: merge native Copilot data before closing
    if (this._nativeCaptureService) {
      await this._nativeCaptureService.mergeIntoSession(sessionId).catch(() => undefined);
    }

    const endSnapshot = await this._captureGitSnapshot();
    if (endSnapshot) {
      await updateSessionGitSnapshot(this._repoRoot, sessionId, "end", endSnapshot).catch(() => undefined);

      const commitMessage = await this._resolveCommitMessage().catch(() => undefined);
      await updateSessionIntent(this._repoRoot, sessionId, {
        branchContext: endSnapshot.branch,
        ...(commitMessage ? { commitMessage } : {}),
        source: PROMPT_SOURCE_TAG,
      }).catch(() => undefined);
    }

    await closeSession(this._repoRoot, sessionId).catch(() => undefined);

    const closed = await readSession(this._repoRoot, sessionId).catch(() => null);
    if (!closed) return;

    const confidence = await this._resolveSessionConfidence(closed);
    await updateSessionIntent(this._repoRoot, sessionId, {
      confidence,
      source: closed.intent?.source ?? PROMPT_SOURCE_TAG,
    }).catch(() => undefined);

    await synthesiseAndWriteSessionSummary(this._repoRoot, sessionId).catch(
      () => undefined,
    );

    this._log(`Closed VS Code chat session: ${sessionId} (${reason}, confidence=${confidence.toFixed(2)})`);

    // Trigger LM enrichment if confidence is low, OR if we have passive-only
    // capture data (Strategy A/B without Path 1).
    const needsEnrichment =
      confidence < 0.85 ||
      (this._nativeCaptureService?.hasPassiveCaptureOnly(closed) ?? false);

    if (needsEnrichment) {
      const timer = setTimeout(() => {
        this._enrichmentTimers.delete(timer);
        void this._runLmEnrichment(sessionId);
      }, this._enrichmentDelayMs);
      this._enrichmentTimers.add(timer);
    }
  }

  private async _runLmEnrichment(sessionId: string): Promise<void> {
    const session = await readSession(this._repoRoot, sessionId).catch(() => null);
    if (!session) return;

    const currentConfidence = await this._resolveSessionConfidence(session);
    if (currentConfidence >= 0.85) return;

    const model = await this._resolveModel();
    if (!model) {
      this._log(`LM enrichment skipped for ${sessionId}: no Copilot model available`);
      return;
    }

    const prompt = buildSynthesisPrompt(session);
    let synthesis = "";
    try {
      const lmResponse = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
      );

      for await (const chunk of lmResponse.text) {
        synthesis += chunk;
      }
    } catch (err) {
      this._log(`LM enrichment failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const trimmed = synthesis.trim();
    if (!trimmed) return;

    await updateSessionIntent(this._repoRoot, sessionId, {
      synthesised: trimmed,
      source: LM_SOURCE_TAG,
      confidence: ENRICHED_CONFIDENCE,
    }).catch(() => undefined);

    await updateSessionActor(this._repoRoot, sessionId, {
      tool: "vscode-copilot",
      model: model.id || model.family,
    }).catch(() => undefined);

    await appendSessionTimelineEvent(this._repoRoot, sessionId, {
      type: "lm-enrichment-written",
      source: LM_SOURCE_TAG,
      data: {
        chars: trimmed.length,
        synthesisPreview: trimmed.slice(0, 500),
      },
    }).catch(() => undefined);

    this._log(`LM enrichment stored for session ${sessionId}`);
  }

  private async _resolveSessionConfidence(session: KodelaSession): Promise<number> {
    if (typeof session.intent?.confidence === "number") {
      return session.intent.confidence;
    }

    if (session.entries.length === 0) {
      return DEFAULT_CAPTURE_CONFIDENCE;
    }

    let sum = 0;
    let count = 0;
    for (const entryId of session.entries.slice(0, 200)) {
      try {
        const entry = await readContextEntry(this._repoRoot, entryId);
        sum += entry.confidence;
        count++;
      } catch {
        // ignore missing or corrupted entries while computing aggregate confidence
      }
    }

    if (count === 0) return DEFAULT_CAPTURE_CONFIDENCE;
    return sum / count;
  }

  private async _resolveModel(requestModel?: vscode.LanguageModelChat): Promise<vscode.LanguageModelChat | undefined> {
    if (requestModel) return requestModel;

    let preferred: readonly vscode.LanguageModelChat[] = [];
    try {
      preferred = await vscode.lm.selectChatModels({ vendor: "copilot", family: "gpt-4o" });
    } catch {
      preferred = [];
    }
    if (preferred[0]) return preferred[0];

    let fallback: readonly vscode.LanguageModelChat[] = [];
    try {
      fallback = await vscode.lm.selectChatModels({ vendor: "copilot" });
    } catch {
      fallback = [];
    }
    return fallback[0];
  }

  private async _resolveGitRepository(): Promise<GitRepository | undefined> {
    const extension = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
    if (!extension) return undefined;

    let exportsValue: GitExtensionExports | undefined;
    if (extension.isActive) {
      exportsValue = extension.exports;
    } else {
      try {
        exportsValue = await extension.activate();
      } catch {
        exportsValue = undefined;
      }
    }
    if (!exportsValue || typeof exportsValue.getAPI !== "function") return undefined;

    const api = exportsValue.getAPI(1);
    if (!api || !Array.isArray(api.repositories) || api.repositories.length === 0) {
      return undefined;
    }

    const targetRoot = normalizePath(this._repoRoot);
    return (
      api.repositories.find((repo: GitRepository) => normalizePath(repo.rootUri.fsPath) === targetRoot) ??
      api.repositories[0]
    );
  }

  private async _captureGitSnapshot(): Promise<SessionGitSnapshot | undefined> {
    const repo = await this._resolveGitRepository();
    if (!repo) return undefined;

    const branch = repo.state.HEAD?.name;
    const headCommit = repo.state.HEAD?.commit;

    const workingTreeChanges = repo.state.workingTreeChanges ?? [];
    const indexChanges = repo.state.indexChanges ?? [];
    const mergeChanges = repo.state.mergeChanges ?? [];

    const changedFiles = new Set<string>();
    const collect = (changes: ReadonlyArray<{ resourceUri?: vscode.Uri }>): void => {
      for (const change of changes) {
        const fsPath = change.resourceUri?.fsPath;
        if (!fsPath) continue;
        changedFiles.add(toRelativePath(this._repoRoot, fsPath));
      }
    };

    collect(workingTreeChanges);
    collect(indexChanges);
    collect(mergeChanges);

    const author = await resolveAuthor(this._repoRoot);

    return {
      ...(branch ? { branch } : {}),
      ...(headCommit ? { headCommit } : {}),
      ...(author !== "unknown" ? { author } : {}),
      ...(changedFiles.size > 0 ? { filesChanged: [...changedFiles].sort() } : {}),
      diffStats: {
        workingTree: workingTreeChanges.length,
        index: indexChanges.length,
        merge: mergeChanges.length,
        total: changedFiles.size,
      },
      capturedAt: new Date().toISOString(),
    };
  }

  private async _resolveCommitMessage(): Promise<string | undefined> {
    const repo = await this._resolveGitRepository();
    if (repo?.log) {
      try {
        const entries = await repo.log({ maxEntries: 1 });
        const first = entries[0]?.message?.trim();
        if (first) return first;
      } catch {
        // fallback to git CLI below
      }
    }

    try {
      const { stdout } = await execFileAsync("git", ["log", "-1", "--pretty=%s"], {
        cwd: this._repoRoot,
        timeout: 4000,
      });
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }

  private _log(message: string): void {
    this._outputChannel?.appendLine(`[chat-capture] ${message}`);
  }
}

export function registerCopilotSessionCapture(
  repoRoot: string,
  outputChannel?: vscode.OutputChannel,
  options?: CopilotSessionCaptureOptions,
): vscode.Disposable {
  return new CopilotSessionCapture(repoRoot, outputChannel, options);
}
