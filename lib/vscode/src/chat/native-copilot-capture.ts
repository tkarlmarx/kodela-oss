// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Path 5 — Passive Native Copilot Session Capture
 *
 * Captures data from native VS Code Copilot conversations (where the user
 * talks to Copilot directly without invoking @kodela) using three layered
 * sub-strategies:
 *
 *   Strategy A — chatSessions/ file watcher (primary, confidence=0.85)
 *   Strategy B — SQLite state.vscdb CLI reader (fallback, confidence=0.70)
 *   Strategy C — Copilot memory .md files reader (enrichment only)
 *
 * All strategies are non-blocking, async, and run in parallel with the
 * existing capture paths 1–4.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { listSessions, readSession } from "@kodela/core";
import { writeSession } from "@kodela/core/storage";
import {
  startSession,
  closeSession,
  appendSessionCaptureSource,
  appendSessionTimelineEvent,
  appendUserTurn,
  appendAssistantTurn,
  updateSessionAnnotation,
  updateSessionActor,
  updateSessionCopilotMemory,
  updateSessionIntent,
} from "@kodela/core/sessions";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

// ─── Source Tags ──────────────────────────────────────────────────────────────

const SOURCE_CHATSESSIONS = "copilot-chatsessions-watcher";
const SOURCE_SQLITE = "copilot-sqlite-fallback";
const SOURCE_MEMORY = "copilot-memory-tool";

// ─── Confidence Levels ────────────────────────────────────────────────────────

const CONFIDENCE_CHATSESSIONS = 0.85;
const CONFIDENCE_SQLITE = 0.70;

// ─── Debounce ─────────────────────────────────────────────────────────────────

const DEFAULT_DEBOUNCE_MS = 2_000;
const SQLITE_TIMEOUT_MS = 4_000;
const SESSION_ENRICH_DEBOUNCE_MS = 3_000;
const SESSION_SCAN_INTERVAL_MS = 15_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single turn extracted from native Copilot chat data. */
export type NativeChatTurn = {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  /** Extended-thinking text captured from kind='thinking' response items. */
  reasoning?: string;
};

/** Result of attempting to read native Copilot chat data. */
export type NativeCaptureResult = {
  turns: NativeChatTurn[];
  source: string;
  confidence: number;
};

export type NativeCopilotCaptureOptions = {
  debounceMs?: number;
};

// ─── Platform storage path resolution ─────────────────────────────────────────

function resolveVSCodeUserDataDir(): string {
  const platform = os.platform();
  const home = os.homedir();

  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User");
  }
  if (platform === "win32") {
    return path.join(process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming"), "Code", "User");
  }
  // Linux and others
  return path.join(process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config"), "Code", "User");
}

async function resolveWorkspaceStorageHash(
  userDataDir: string,
  workspaceUri: string,
): Promise<string | undefined> {
  const storageRoot = path.join(userDataDir, "workspaceStorage");

  let entries: string[];
  try {
    entries = await fs.readdir(storageRoot);
  } catch {
    return undefined;
  }

  // Scan all workspace.json files for a match
  for (const hash of entries) {
    const wsPath = path.join(storageRoot, hash, "workspace.json");
    try {
      const raw = await fs.readFile(wsPath, "utf-8");
      const parsed = JSON.parse(raw) as { folder?: string; workspace?: string };
      const folderUri = parsed.folder ?? parsed.workspace ?? "";
      if (folderUri === workspaceUri) {
        return hash;
      }
    } catch {
      // skip unreadable or missing workspace.json
    }
  }

  return undefined;
}

// ─── Copilot chat JSON parsing ────────────────────────────────────────────────

/**
 * Parse a native Copilot chatSessions JSON file.
 * The structure varies across versions but typically has a `requests` array
 * or a `history` array with role/content pairs.
 */
/** Per-session effort metrics extracted from kind=1 JSONL patches. */
type ChatSessionMetrics = {
  /** Total output tokens across all requests in this session. */
  totalCompletionTokens: number;
  /** Number of completed requests. */
  requestCount: number;
  /** Average LLM response time in milliseconds. */
  avgElapsedMs?: number;
  /** Model ID used (e.g. "copilot/claude-sonnet-4.6"). */
  modelId?: string;
};

/** A single tool invocation captured from a chatSessions JSONL response entry. */
type NativeToolAction = {
  /** 0-based request index within the chatSessions file. */
  requestSeq: number;
  toolId: string;
  /** Human-readable description of what the tool did (past-tense if complete). */
  message: string;
  confirmed: boolean | null;
  isComplete: boolean;
  capturedAt: string;
};

/** Enriched result from parsing a chatSessions JSONL file. */
type ParsedChatSession = {
  turns: NativeChatTurn[];
  /** User-assigned session title from the kind=0 header (e.g. "Add unit tests for auth"). */
  title?: string;
  /** Distinct file paths attached as context references across all turns in this session. */
  contextFiles?: string[];
  /** Effort metrics derived from kind=1 token/latency patches. */
  chatMetrics?: ChatSessionMetrics;
  /** Tool invocations captured from kind='toolInvocationSerialized' response entries. */
  toolActions?: NativeToolAction[];
};

function parseCopilotChatJson(raw: string): ParsedChatSession {
  const turns: NativeChatTurn[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSONL format: VS Code chatSessions streaming update protocol.
    // kind=0: session header (initial state + title)
    // kind=1: field-level patches (model state, token counts, etc.)
    // kind=2: array appends — new requests (k=["requests"]) and response chunks (k=["requests",N,"response"])
    //
    // Fix 4: One JSONL file may contain multiple conversations (each starting with kind=0).
    // We only process the LAST conversation to avoid polluting a session with weeks of history.
    const allLines = raw.split("\n").filter((l) => l.trim().length > 0);

    // Find the starting index of the last kind=0 header
    let lastKind0 = 0;
    for (let i = 0; i < allLines.length; i++) {
      try {
        const obj = JSON.parse(allLines[i]) as Record<string, unknown>;
        if (obj["kind"] === 0) lastKind0 = i;
      } catch { /* skip */ }
    }
    const lines = allLines.slice(lastKind0);

    // Fix 3: extract session title and context file refs while parsing
    let sessionTitle: string | undefined;
    const contextFileSet = new Set<string>();

    // Gap 5: per-request metric accumulators from kind=1 patches
    const metricsMap: Record<number, { tokens?: number; elapsedMs?: number; modelId?: string }> = {};

    const requestMap: Record<number, { userText: string; assistantText: string; reasoningText?: string; timestamp?: string }> = {};
    const collectedToolActions: NativeToolAction[] = [];
    let initialCount = 0;
    let appendCount = 0;

    const extractMessageText = (req: Record<string, unknown>): string | undefined => {
      const messageRaw = req["message"];
      if (typeof messageRaw === "string") return messageRaw;
      if (messageRaw && typeof messageRaw === "object") {
        const t = (messageRaw as Record<string, unknown>)["text"];
        if (typeof t === "string") return t;
      }
      return undefined;
    };

    const extractContextFiles = (req: Record<string, unknown>): void => {
      // Primary source: variableData.variables (present in kind=2 appended requests)
      const varData = req["variableData"] as Record<string, unknown> | undefined;
      const vars = varData?.["variables"] as unknown[] | undefined;
      if (Array.isArray(vars)) {
        for (const v of vars) {
          if (!v || typeof v !== "object") continue;
          const val = (v as Record<string, unknown>)["value"] as Record<string, unknown> | undefined;
          // value.external is a file:// URI
          const ext = val?.["external"];
          if (typeof ext === "string" && ext.startsWith("file://")) {
            const fsPath = decodeURIComponent(ext.replace(/^file:\/\//, ""));
            if (fsPath) contextFileSet.add(fsPath);
          }
          // value.fsPath fallback
          const fsPath = val?.["fsPath"] ?? val?.["path"];
          if (typeof fsPath === "string" && fsPath) contextFileSet.add(fsPath);
        }
      }
      // Fallback: contentReferences
      const refs = req["contentReferences"] as unknown[] | undefined;
      if (!Array.isArray(refs)) return;
      for (const ref of refs) {
        if (!ref || typeof ref !== "object") continue;
        const r = ref as Record<string, unknown>;
        const reference = r["reference"] as Record<string, unknown> | undefined;
        const fp = reference?.["fsPath"] ?? reference?.["path"];
        if (typeof fp === "string" && fp) contextFileSet.add(fp);
      }
    };

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const objKind = obj["kind"];

        if (objKind === 0) {
          // Session header: extract title and initial requests
          const v = obj["v"] as Record<string, unknown> | undefined;
          const title = v?.["customTitle"];
          if (typeof title === "string" && title.trim()) sessionTitle = title.trim();

          const reqs = v?.["requests"] as unknown[] | undefined;
          if (Array.isArray(reqs)) {
            initialCount = reqs.length;
            reqs.forEach((req, i) => {
              if (!req || typeof req !== "object") return;
              const r = req as Record<string, unknown>;
              extractContextFiles(r);

              // Gap 5: capture modelId from direct field (r.modelId) then agent fallback
              const modelId = (r["modelId"] ?? (r["agent"] as Record<string, unknown> | undefined)?.["modelId"]) as string | undefined;
              if (modelId) metricsMap[i] = { ...metricsMap[i], modelId };

              const messageText = extractMessageText(r);
              if (messageText?.trim()) {
                requestMap[i] = {
                  userText: messageText.trim(),
                  assistantText: "",
                  timestamp:
                    typeof r["timestamp"] === "number"
                      ? new Date(r["timestamp"] as number).toISOString()
                      : undefined,
                };
              }
            });
          }
        } else if (objKind === 2) {
          const k = obj["k"] as unknown[] | undefined;
          if (!Array.isArray(k)) continue;

          if (k.length === 1 && k[0] === "requests") {
            // Appended request: new user turn
            const newReqs = obj["v"] as unknown[] | undefined;
            if (Array.isArray(newReqs)) {
              for (const req of newReqs) {
                if (!req || typeof req !== "object") { appendCount++; continue; }
                const r = req as Record<string, unknown>;
                extractContextFiles(r);
                const messageText = extractMessageText(r);
                const idx = initialCount + appendCount;

                // Gap 5: capture modelId from direct field (r.modelId) then agent fallback
                const modelId = (r["modelId"] ?? (r["agent"] as Record<string, unknown> | undefined)?.["modelId"]) as string | undefined;
                if (modelId) metricsMap[idx] = { ...metricsMap[idx], modelId };

                if (messageText?.trim()) {
                  requestMap[idx] = {
                    userText: messageText.trim(),
                    assistantText: "",
                    timestamp:
                      typeof r["timestamp"] === "number"
                        ? new Date(r["timestamp"] as number).toISOString()
                        : undefined,
                  };
                }
                appendCount++;
              }
            }
          } else if (k[0] === "requests" && typeof k[1] === "number" && k[1] === 0 && k[2] === undefined) {
            // kind=1 title update
          }
        } else if (objKind === 1) {
          const k = obj["k"] as unknown[] | undefined;
          if (!Array.isArray(k)) continue;

          // kind=1 title patch: k=["customTitle"]
          if (k[0] === "customTitle") {
            const v = obj["v"];
            if (typeof v === "string" && v.trim() && !sessionTitle) sessionTitle = v.trim();

          // Gap 5: kind=1 per-request metric patches
          } else if (k[0] === "requests" && typeof k[1] === "number") {
            const reqIdx = k[1] as number;
            const field = k[2];
            const v = obj["v"];
            if (field === "completionTokens" && typeof v === "number") {
              metricsMap[reqIdx] = { ...metricsMap[reqIdx], tokens: v };
            } else if (field === "elapsedMs" && typeof v === "number") {
              metricsMap[reqIdx] = { ...metricsMap[reqIdx], elapsedMs: v };
            } else if (field === "modelState" && v && typeof v === "object") {
              // modelId comes via the initial kind=2 k=["requests"] entry; grab from modelState if missing
            }
          }
        }
      } catch { /* skip malformed lines */ }
    }

    // Pass 2: collect response text, reasoning, and tool actions from kind=2 k=["requests",N,"response"] lines
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj["kind"] === 2) {
          const k = obj["k"] as unknown[] | undefined;
          if (
            Array.isArray(k) &&
            k[0] === "requests" &&
            typeof k[1] === "number" &&
            k[2] === "response"
          ) {
            const idx = k[1] as number;
            const responseArr = obj["v"] as unknown[] | undefined;
            if (Array.isArray(responseArr)) {
              for (const item of responseArr) {
                if (!item || typeof item !== "object") continue;
                const it = item as Record<string, unknown>;
                const itemKind = it["kind"];

                // Plain text response: kind=null/undefined with a string value
                if (typeof it["value"] === "string" && !itemKind) {
                  const txt = (it["value"] as string).trim();
                  if (txt && requestMap[idx] !== undefined) {
                    requestMap[idx]!.assistantText = requestMap[idx]!.assistantText
                      ? requestMap[idx]!.assistantText + "\n" + txt
                      : txt;
                  }
                }

                // Gap 1: AI extended thinking
                else if (itemKind === "thinking" && typeof it["value"] === "string") {
                  const thought = (it["value"] as string).trim();
                  if (thought && requestMap[idx] !== undefined) {
                    requestMap[idx]!.reasoningText = requestMap[idx]!.reasoningText
                      ? requestMap[idx]!.reasoningText + "\n" + thought
                      : thought;
                  }
                }

                // Gap 2: tool invocations
                else if (itemKind === "toolInvocationSerialized") {
                  const msg = (it["pastTenseMessage"] ?? it["invocationMessage"] ?? "") as string;
                  const toolId = (it["toolId"] ?? it["name"] ?? "") as string;
                  if (msg || toolId) {
                    const rawConfirmed = it["isConfirmed"];
                    collectedToolActions.push({
                      requestSeq: idx,
                      toolId: String(toolId),
                      message: String(msg).trim(),
                      confirmed: rawConfirmed === true ? true : rawConfirmed === false ? false : null,
                      isComplete: it["isComplete"] === true,
                      capturedAt: new Date().toISOString(),
                    });
                  }
                }
              }
            }
          }
        }
      } catch { /* skip malformed lines */ }
    }

    const indices = Object.keys(requestMap).map(Number).sort((a, b) => a - b);
    for (const i of indices) {
      const entry = requestMap[i]!;
      if (entry.userText) turns.push({ role: "user", content: entry.userText, timestamp: entry.timestamp });
      if (entry.assistantText) {
        turns.push({
          role: "assistant",
          content: entry.assistantText,
          // Gap 1: carry reasoning alongside the response without creating an extra turn
          ...(entry.reasoningText ? { reasoning: entry.reasoningText } : {}),
        });
      }
    }

    // Gap 5: aggregate per-request metrics into session-level summary
    const allTokens = Object.values(metricsMap).map((m) => m.tokens ?? 0).filter((t) => t > 0);
    const allElapsed = Object.values(metricsMap).map((m) => m.elapsedMs ?? 0).filter((e) => e > 0);
    const modelIds = [...new Set(Object.values(metricsMap).map((m) => m.modelId).filter(Boolean))];
    const chatMetrics: ChatSessionMetrics | undefined = allTokens.length > 0 ? {
      totalCompletionTokens: allTokens.reduce((s, t) => s + t, 0),
      requestCount: Object.keys(requestMap).length,
      avgElapsedMs: allElapsed.length > 0
        ? Math.round(allElapsed.reduce((s, e) => s + e, 0) / allElapsed.length)
        : undefined,
      modelId: modelIds[0],
    } : undefined;

    return {
      turns,
      title: sessionTitle,
      contextFiles: contextFileSet.size > 0 ? [...contextFileSet] : undefined,
      chatMetrics,
      toolActions: collectedToolActions.length > 0 ? collectedToolActions : undefined,
    };
  }

  if (!parsed || typeof parsed !== "object") return { turns };
  const obj = parsed as Record<string, unknown>;

  // Format 1: requests array (common in VS Code 2024+)
  const requests = obj["requests"] as unknown[] | undefined;
  if (Array.isArray(requests)) {
    for (const req of requests) {
      if (!req || typeof req !== "object") continue;
      const r = req as Record<string, unknown>;

      // User message — may be a plain string or an object with a `text` property
      const messageRaw = r["message"];
      const messageText =
        typeof messageRaw === "string"
          ? messageRaw
          : messageRaw && typeof messageRaw === "object"
            ? (typeof (messageRaw as Record<string, unknown>)["text"] === "string"
              ? ((messageRaw as Record<string, unknown>)["text"] as string)
              : undefined)
            : undefined;
      if (messageText && messageText.trim().length > 0) {
        turns.push({
          role: "user",
          content: messageText.trim(),
          timestamp: typeof r["timestamp"] === "number"
            ? new Date(r["timestamp"] as number).toISOString()
            : typeof r["timestamp"] === "string" ? r["timestamp"] : undefined,
        });
      }

      // Assistant response
      const response = r["response"] as Record<string, unknown> | undefined;
      if (response && typeof response === "object") {
        const value =
          typeof response["value"] === "string"
            ? response["value"]
            : typeof response["result"] === "string"
              ? response["result"]
              : undefined;
        if (value && value.trim().length > 0) {
          turns.push({
            role: "assistant",
            content: value.trim(),
          });
        }
      }
    }
    return { turns };
  }

  // Format 2: history array with role/content pairs
  const history = obj["history"] as unknown[] | undefined;
  if (Array.isArray(history)) {
    for (const entry of history) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const role = e["role"] as string | undefined;
      const content = e["content"] as string | undefined;
      if (
        (role === "user" || role === "assistant") &&
        typeof content === "string" &&
        content.trim().length > 0
      ) {
        turns.push({
          role,
          content: content.trim(),
          timestamp: typeof e["timestamp"] === "string" ? e["timestamp"] : undefined,
        });
      }
    }
    return { turns };
  }

  return { turns };
}

// ─── SQLite fallback parsing ──────────────────────────────────────────────────

function parseSqliteChatData(sqliteOutput: string): NativeChatTurn[] {
  const turns: NativeChatTurn[] = [];
  const trimmed = sqliteOutput.trim();
  if (!trimmed) return turns;

  // The sqlite3 output may contain multiple JSON blobs separated by newlines
  for (const line of trimmed.split("\n")) {
    try {
      const jsonStr = line.trim();
      if (!jsonStr) continue;
      const { turns: parsed } = parseCopilotChatJson(jsonStr);
      turns.push(...parsed);
    } catch {
      // skip unparseable lines
    }
  }

  return turns;
}

// ─── Telemetry / Debug Store ──────────────────────────────────────────────────

export class CaptureDebugMetrics {
  private static _instance: CaptureDebugMetrics;
  private _state = {
    // Core strategy flags (kept for backward compat)
    strategiesActive: { chatSessions: false, sqlite: false, memory: false },
    pathsResolved: { workspaceStorage: "", userDataDir: "" },
    metrics: { filesParsed: 0, memoryFilesRead: 0, enrichmentAttempts: 0 },
    // Extended per-source status
    sources: {
      chatSessions: { active: false, filesParsed: 0, lastFileParsed: "", lastTurnsCount: 0, lastTurnPreview: "", lastEventTime: "" },
      sqlite: { active: false, queriesRun: 0, available: false },
      memoryTool: { active: false, filesRead: 0, lastFileRead: "", lastMemoryPreview: "", watchPath: "" },
      localHistory: { active: false, historyRoot: "", snapshotsScanned: 0, filesWithChanges: 0, lastScanTime: "" },
      chatEditing: { active: false, watchPath: "", editsDetected: 0, lastEditPreview: "", lastEventTime: "" },
      emptyWindow: { active: false, watchPath: "", sessionsFound: 0, turnsFound: 0, lastScanTime: "" },
    },
    recentCaptures: [] as Array<{ time: string; source: string; preview: string; turnsCount: number }>,
    errors: [] as string[],
    lastScanTime: "",
  };
  private _flushTimer: NodeJS.Timeout | undefined;

  private constructor(private readonly _repoRoot: string) { }

  static getInstance(repoRoot: string): CaptureDebugMetrics {
    if (!this._instance) {
      this._instance = new CaptureDebugMetrics(repoRoot);
    }
    return this._instance;
  }

  update(fn: (state: typeof this._state) => void) {
    fn(this._state);
    this._state.lastScanTime = new Date().toISOString();
    this.scheduleFlush();
  }

  logError(err: string) {
    this._state.errors.push(`[${new Date().toISOString()}] ${err}`);
    if (this._state.errors.length > 50) this._state.errors.shift();
    this.scheduleFlush();
  }

  recordCapture(source: string, preview: string, turnsCount: number): void {
    this._state.recentCaptures.unshift({
      time: new Date().toISOString(),
      source,
      preview: preview.slice(0, 120),
      turnsCount,
    });
    if (this._state.recentCaptures.length > 20) {
      this._state.recentCaptures.length = 20;
    }
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => {
      this.flush().catch(console.error);
    }, 2000);
    this._flushTimer.unref?.();
  }

  private async flush() {
    const dir = path.join(this._repoRoot, ".kodela", "debug");
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "capture-status.json"),
        JSON.stringify(this._state, null, 2),
        "utf-8"
      );
    } catch (e) {
      // silent fail if kodela dir is inaccessible
    }
  }
}

// ─── Local History Capture ───────────────────────────────────────────────────

function resolveLocalHistoryRoot(): string {
  const platform = os.platform();
  const home = os.homedir();
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Code", "User", "History");
  if (platform === "win32") return path.join(process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming"), "Code", "User", "History");
  return path.join(process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config"), "Code", "User", "History");
}

/** Minimal unified diff summary — no external deps required. */
function buildUnifiedDiffSummary(before: string, after: string, context: number): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines: string[] = [];
  const maxLen = Math.max(a.length, b.length);
  let i = 0;
  while (i < maxLen) {
    if (a[i] !== b[i]) {
      const start = Math.max(0, i - context);
      const end = Math.min(maxLen, i + context + 1);
      for (let j = start; j < end; j++) {
        if (j < a.length && j < b.length && a[j] !== b[j]) {
          lines.push(`- ${a[j] ?? ""}`);
          lines.push(`+ ${b[j] ?? ""}`);
        } else if (j >= a.length) {
          lines.push(`+ ${b[j] ?? ""}`);
        } else if (j >= b.length) {
          lines.push(`- ${a[j] ?? ""}`);
        } else {
          lines.push(`  ${a[j] ?? ""}`);
        }
      }
      lines.push("---");
      i = end;
    } else {
      i++;
    }
  }
  return lines.slice(0, 40).join("\n");
}

type LocalHistoryEntry = { id: string; timestamp: number; source?: string };

type CodeChangeCapture = {
  filePath: string;
  timestamp: number;
  linesAdded: number;
  linesRemoved: number;
  diffSummary: string;
  snapshotId?: string;
  source: "local-history";
  /** User prompt that triggered this save, extracted from entries.json `source` field ("Chat Edit: '...'") */
  editPrompt?: string;
};

class LocalHistoryCapture {
  private readonly _historyRoot: string;
  private _startTime: number = Date.now();
  private _sessionStartTime: number = 0;
  private _scanTimer: NodeJS.Timeout | undefined;
  private _disposed = false;

  constructor(private readonly _metrics: CaptureDebugMetrics) {
    this._historyRoot = resolveLocalHistoryRoot();
  }

  start(): void {
    this._startTime = Date.now();
    this._metrics.update((s) => {
      s.sources.localHistory.historyRoot = this._historyRoot;
    });
    const init = setTimeout(() => { void this._scan(); }, 10_000);
    if (typeof init === "object" && "unref" in init) (init as NodeJS.Timeout).unref();
    this._scanTimer = setInterval(() => { void this._scan(); }, 60_000);
    if (typeof this._scanTimer === "object" && "unref" in this._scanTimer) this._scanTimer.unref();
  }

  /** Record the session start watermark. Must be called BEFORE watchers are armed. */
  markSessionStart(): void {
    this._sessionStartTime = Date.now();
  }

  /** Set an explicit start time (used when enriching watcher-daemon sessions). */
  setSessionStartTime(timestamp: number): void {
    this._sessionStartTime = timestamp;
  }

  /**
   * At session close: scan Local History for all snapshots within the session
   * window, diff consecutive pairs, and return structured CodeChange records.
   */
  async captureSessionChanges(): Promise<CodeChangeCapture[]> {
    // Guard: if no session started, use 1hr lookback to avoid scanning back to epoch
    const windowStart =
      this._sessionStartTime > 0 ? this._sessionStartTime : Date.now() - 3_600_000;

    const changes: CodeChangeCapture[] = [];
    let hashes: string[];
    try { hashes = await fs.readdir(this._historyRoot); } catch { return []; }

    for (const hash of hashes) {
      const entriesPath = path.join(this._historyRoot, hash, "entries.json");
      try {
        const raw = await fs.readFile(entriesPath, "utf-8");
        const index = JSON.parse(raw) as { resource?: string; entries?: LocalHistoryEntry[] };
        const resourceUri = index.resource ?? "";
        if (!resourceUri) continue;

        // Extension MUST be parsed from the resource URI, not the snapshot filename
        let ext = "txt";
        try {
          ext = path.extname(new URL(resourceUri).pathname).replace(".", "") || "txt";
        } catch { /* malformed URI — use txt */ }

        const allEntries: LocalHistoryEntry[] = (index.entries ?? [])
          .map((e) => ({ id: String(e.id), timestamp: e.timestamp ?? 0, source: e.source }))
          .sort((a, b) => a.timestamp - b.timestamp);

        // Resolve missing timestamps via mtime (VS Code < 1.66 omitted timestamps)
        for (const entry of allEntries) {
          if (entry.timestamp === 0) {
            try {
              const stat = await fs.stat(path.join(this._historyRoot, hash, `${entry.id}.${ext}`));
              entry.timestamp = stat.mtimeMs;
            } catch { /* skip */ }
          }
        }

        const sessionEntries = allEntries.filter((e) => e.timestamp >= windowStart);
        if (sessionEntries.length === 0) continue;

        // Baseline: the last snapshot BEFORE the session window
        const baselineEntry = allEntries.filter((e) => e.timestamp < windowStart).pop();
        const readSnapshot = async (id: string): Promise<string> => {
          try {
            return await fs.readFile(path.join(this._historyRoot, hash, `${id}.${ext}`), "utf-8");
          } catch { return ""; }
        };

        const baselineContent = baselineEntry ? await readSnapshot(baselineEntry.id) : "";

        // Build ordered list: [baseline, ...sessionEntries]
        const ordered = [
          { id: "__baseline__", timestamp: windowStart, content: baselineContent, entrySource: undefined as string | undefined },
          ...await Promise.all(
            sessionEntries.map(async (e) => ({
              id: e.id,
              timestamp: e.timestamp,
              content: await readSnapshot(e.id),
              entrySource: e.source,
            })),
          ),
        ];

        // Diff each consecutive pair
        for (let i = 1; i < ordered.length; i++) {
          const before = ordered[i - 1]!.content;
          const after = ordered[i]!.content;
          if (before === after || !after) continue;

          const beforeLines = before.split("\n");
          const afterLines = after.split("\n");

          // Extract user prompt from "Chat Edit: 'user prompt here'" source annotation
          const rawEntrySource = ordered[i]!.entrySource ?? "";
          const editPromptMatch = rawEntrySource.match(/^Chat Edit: '(.*)'$/s);
          const editPrompt = editPromptMatch ? editPromptMatch[1] : (rawEntrySource || undefined);

          changes.push({
            filePath: (() => { try { return new URL(resourceUri).pathname; } catch { return resourceUri; } })(),
            timestamp: ordered[i]!.timestamp,
            linesAdded: afterLines.filter((l, idx) => l !== beforeLines[idx] && !beforeLines.includes(l)).length,
            linesRemoved: beforeLines.filter((l, idx) => l !== afterLines[idx] && !afterLines.includes(l)).length,
            diffSummary: buildUnifiedDiffSummary(before, after, 3),
            snapshotId: ordered[i]!.id === "__baseline__" ? undefined : ordered[i]!.id,
            source: "local-history" as const,
            editPrompt,
          });
        }
      } catch { continue; /* locked or malformed — skip */ }
    }

    return changes;
  }

  dispose(): void {
    this._disposed = true;
    if (this._scanTimer) clearInterval(this._scanTimer);
    this._scanTimer = undefined;
  }

  private async _scan(): Promise<void> {
    if (this._disposed) return;
    try {
      const hashes = await fs.readdir(this._historyRoot).catch(() => [] as string[]);
      let snapshotsScanned = 0;
      let filesWithChanges = 0;
      for (const hash of hashes) {
        const entriesPath = path.join(this._historyRoot, hash, "entries.json");
        try {
          const raw = await fs.readFile(entriesPath, "utf-8");
          const index = JSON.parse(raw) as { entries?: Array<{ timestamp?: number }> };
          const sessionEntries = (index.entries ?? []).filter(
            (e) => (e.timestamp ?? 0) >= this._startTime,
          );
          if (sessionEntries.length > 0) {
            filesWithChanges++;
            snapshotsScanned += sessionEntries.length;
          }
        } catch { /* skip */ }
      }
      this._metrics.update((s) => {
        s.sources.localHistory.active = true;
        s.sources.localHistory.snapshotsScanned = snapshotsScanned;
        s.sources.localHistory.filesWithChanges = filesWithChanges;
        s.sources.localHistory.lastScanTime = new Date().toISOString();
      });
      if (snapshotsScanned > 0) {
        this._metrics.recordCapture(
          "localHistory",
          `${filesWithChanges} file(s) changed, ${snapshotsScanned} snapshot(s)`,
          snapshotsScanned,
        );
      }
    } catch {
      this._metrics.update((s) => { s.sources.localHistory.active = false; });
    }
  }
}

// ─── Chat Editing Sessions Capture ───────────────────────────────────────────

type InlineEditCapture = {
  prompt: string;
  filePath: string;
  accepted: boolean | null;
  diff: string;
  timestamp: number;
  source: "copilot-inline-edit";
};

class ChatEditingSessionsCapture {
  private _watcher: vscode.FileSystemWatcher | undefined;
  private _editDebounce = new Map<string, NodeJS.Timeout>();
  private _disposed = false;

  constructor(private readonly _metrics: CaptureDebugMetrics) { }

  start(
    storageRoot: string,
    workspaceHash: string,
    onEdit?: (edit: InlineEditCapture) => void,
  ): void {
    const watchPath = path.join(storageRoot, workspaceHash, "chatEditingSessions");
    this._metrics.update((s) => { s.sources.chatEditing.watchPath = watchPath; });
    try {
      this._watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(watchPath, "**/*"),
      );
      const handle = (uri: vscode.Uri): void => {
        if (this._disposed) return;
        // Debounce 1500ms — chatEditingSessions files are written incrementally
        const existing = this._editDebounce.get(uri.fsPath);
        if (existing) clearTimeout(existing);
        this._editDebounce.set(
          uri.fsPath,
          setTimeout(() => {
            this._editDebounce.delete(uri.fsPath);
            void this._parseEditSessionFile(uri.fsPath).then((edit) => {
              if (!edit) return;
              // Update metrics
              this._metrics.update((s) => {
                s.sources.chatEditing.active = true;
                s.sources.chatEditing.editsDetected++;
                s.sources.chatEditing.lastEditPreview = edit.prompt.slice(0, 100);
                s.sources.chatEditing.lastEventTime = new Date().toISOString();
              });
              this._metrics.recordCapture("chatEditing", edit.prompt.slice(0, 100), 1);
              // Notify the service
              onEdit?.(edit);
            });
          }, 1500),
        );
      };
      this._watcher.onDidCreate(handle);
      this._watcher.onDidChange(handle);
      this._metrics.update((s) => { s.sources.chatEditing.active = true; });
    } catch { /* watchPath may not exist yet */ }
  }

  private async _parseEditSessionFile(filePath: string): Promise<InlineEditCapture | null> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;

      // Normalise `accepted` — handle boolean, string, number, or absent
      let accepted: boolean | null = null;
      const rawAccepted =
        (data["accepted"] ?? data["state"] ?? data["status"]) as unknown;
      if (rawAccepted === true || rawAccepted === 1 || rawAccepted === "accepted") {
        accepted = true;
      } else if (rawAccepted === false || rawAccepted === 0 || rawAccepted === "rejected") {
        accepted = false;
      }

      const req = data["request"] as Record<string, unknown> | undefined;
      return {
        prompt:
          (typeof req?.["message"] === "string" ? req["message"] : undefined) ??
          (typeof data["prompt"] === "string" ? data["prompt"] : undefined) ??
          (typeof data["query"] === "string" ? data["query"] : undefined) ??
          "",
        filePath:
          (typeof data["resource"] === "string" ? data["resource"] : undefined) ??
          (typeof data["uri"] === "string" ? data["uri"] : undefined) ??
          (typeof data["file"] === "string" ? data["file"] : undefined) ??
          "",
        accepted,
        diff:
          (typeof data["diff"] === "string" ? data["diff"] : undefined) ??
          (typeof data["changes"] === "string" ? data["changes"] : undefined) ??
          (typeof data["edits"] === "string" ? data["edits"] : undefined) ??
          "",
        timestamp:
          (typeof data["timestamp"] === "number" ? data["timestamp"] : undefined) ??
          (typeof data["createdAt"] === "number" ? data["createdAt"] : undefined) ??
          Date.now(),
        source: "copilot-inline-edit" as const,
      };
    } catch {
      return null;
    }
  }

  dispose(): void {
    this._disposed = true;
    this._watcher?.dispose();
    this._watcher = undefined;
    for (const t of this._editDebounce.values()) clearTimeout(t);
    this._editDebounce.clear();
  }
}

// ─── Empty Window Chat Capture ────────────────────────────────────────────────

type EmptyWindowChatTurn = {
  role: "user" | "assistant";
  userContent: string;
  assistantContent: string;
  timestamp: number;
  source: "empty-window-chat";
};

class EmptyWindowChatCapture {
  private readonly _sessionsPath: string;
  private _watcher: vscode.FileSystemWatcher | undefined;
  private _disposed = false;
  private _onTurns?: (turns: EmptyWindowChatTurn[]) => void;

  constructor(private readonly _metrics: CaptureDebugMetrics, userDataDir: string) {
    this._sessionsPath = path.join(userDataDir, "globalStorage", "emptyWindowChatSessions");
  }

  async start(onTurns?: (turns: EmptyWindowChatTurn[]) => void): Promise<void> {
    this._onTurns = onTurns;
    this._metrics.update((s) => { s.sources.emptyWindow.watchPath = this._sessionsPath; });
    await this._scan();
    try {
      this._watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this._sessionsPath, "*.jsonl"),
      );
      const handle = async (uri: vscode.Uri): Promise<void> => {
        if (this._disposed) return;
        const turns = await this._parseJsonlFile(uri.fsPath);
        if (turns.length > 0) {
          this._onTurns?.(turns);
        }
        await this._scan();
      };
      this._watcher.onDidCreate(handle);
      this._watcher.onDidChange(handle);
    } catch { /* path may not exist */ }
  }

  /** Read all existing JSONL files on activate — used for cross-workspace context. */
  async readAllExisting(): Promise<void> {
    let files: string[];
    try { files = await fs.readdir(this._sessionsPath); } catch { return; }
    for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
      const turns = await this._parseJsonlFile(path.join(this._sessionsPath, file));
      if (turns.length > 0) {
        this._onTurns?.(turns);
      }
    }
  }

  private async _parseJsonlFile(filePath: string): Promise<EmptyWindowChatTurn[]> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const turns: EmptyWindowChatTurn[] = [];
      let pendingUser: Partial<EmptyWindowChatTurn> | null = null;

      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: Record<string, unknown>;
        try { entry = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }

        // kind=0 is metadata — skip
        // kind=1 is user message
        if (entry["kind"] === 1) {
          const v = entry["v"] as Record<string, unknown> | undefined;
          pendingUser = {
            role: "user",
            userContent:
              (v?.["message"] as string | undefined) ??
              (v?.["content"] as string | undefined) ??
              (v?.["text"] as string | undefined) ??
              (entry["message"] as string | undefined) ??
              (entry["content"] as string | undefined) ?? "",
            assistantContent: "",
            timestamp: (entry["timestamp"] as number | undefined) ?? Date.now(),
            source: "empty-window-chat" as const,
          };
        }

        // kind=2 is assistant response — pair with preceding user turn
        if (entry["kind"] === 2 && pendingUser) {
          const v = entry["v"] as Record<string, unknown> | undefined;
          pendingUser.assistantContent =
            (v?.["value"] as string | undefined) ??
            (v?.["content"] as string | undefined) ??
            (v?.["text"] as string | undefined) ??
            (entry["content"] as string | undefined) ?? "";
          turns.push(pendingUser as EmptyWindowChatTurn);
          pendingUser = null;
        }
      }

      // Flush unpaired user turn (assistant still streaming)
      if (pendingUser?.userContent) {
        turns.push(pendingUser as EmptyWindowChatTurn);
      }

      return turns;
    } catch {
      return [];
    }
  }

  private async _scan(): Promise<void> {
    try {
      const files = await fs.readdir(this._sessionsPath).catch(() => [] as string[]);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
      let totalTurns = 0;
      for (const file of jsonlFiles) {
        const turns = await this._parseJsonlFile(path.join(this._sessionsPath, file));
        totalTurns += turns.length;
      }
      this._metrics.update((s) => {
        s.sources.emptyWindow.active = jsonlFiles.length > 0;
        s.sources.emptyWindow.sessionsFound = jsonlFiles.length;
        s.sources.emptyWindow.turnsFound = totalTurns;
        s.sources.emptyWindow.lastScanTime = new Date().toISOString();
      });
    } catch {
      this._metrics.update((s) => { s.sources.emptyWindow.active = false; });
    }
  }

  dispose(): void {
    this._disposed = true;
    this._watcher?.dispose();
    this._watcher = undefined;
  }
}

// ─── Copilot CLI Session Capture ─────────────────────────────────────────────

type ToolCallCapture = {
  name: string;
  input: Record<string, unknown>;
  output: string;
};

type CLISessionCapture = {
  sessionId: string;
  workspaceUri: string;
  toolCalls: ToolCallCapture[];
  fileEdits: string[];
  terminalCommands: string[];
  startTime: number;
  endTime: number;
  source: "copilot-cli-session";
};

class CopilotCLISessionCapture {
  private readonly _cliDir: string;

  constructor(userDataDir: string) {
    this._cliDir = path.join(userDataDir, "globalStorage", "github.copilot-chat");
  }

  async getSessionsForWindow(
    workspacePath: string,
    startTime: number,
    endTime: number,
  ): Promise<CLISessionCapture[]> {
    let files: string[];
    try { files = await fs.readdir(this._cliDir); } catch { return []; }

    const sessionFiles = files.filter(
      (f) => f.startsWith("copilot.cli.workspaceSessions.") && f.endsWith(".json"),
    );

    const results: CLISessionCapture[] = [];

    for (const file of sessionFiles) {
      try {
        const raw = await fs.readFile(path.join(this._cliDir, file), "utf-8");
        const data = JSON.parse(raw) as Record<string, unknown>;

        // Match workspace URI
        const sessionWorkspace = String(
          data["workspaceUri"] ?? data["workspace"] ?? data["folder"] ?? "",
        );
        let workspaceMatch = !workspacePath || !sessionWorkspace;
        if (!workspaceMatch) {
          try {
            workspaceMatch =
              sessionWorkspace.includes(workspacePath) ||
              workspacePath.includes(new URL(sessionWorkspace).pathname);
          } catch {
            workspaceMatch = sessionWorkspace.includes(workspacePath);
          }
        }
        if (!workspaceMatch) continue;

        const sessionStart =
          (data["createdAt"] as number | undefined) ??
          (data["startTime"] as number | undefined) ??
          (data["timestamp"] as number | undefined) ?? 0;
        const sessionEnd =
          (data["updatedAt"] as number | undefined) ??
          (data["endTime"] as number | undefined) ?? Date.now();

        // Include only if time windows overlap
        if (sessionStart > endTime || sessionEnd < startTime) continue;

        const history = (data["history"] ?? data["turns"] ?? []) as Array<Record<string, unknown>>;

        // Tool calls from two locations: top-level + embedded in assistant content
        const topLevelTools = (data["toolCalls"] as Array<Record<string, unknown>> | undefined ?? [])
          .map((tc) => ({
            name: String(tc["name"] ?? (tc["function"] as Record<string, unknown> | undefined)?.["name"] ?? ""),
            input: (tc["input"] ?? (tc["function"] as Record<string, unknown> | undefined)?.["arguments"] ?? {}) as Record<string, unknown>,
            output: String(tc["output"] ?? tc["result"] ?? ""),
          }));
        const embeddedTools = this._extractEmbeddedToolCalls(history);
        const toolCalls = [...topLevelTools, ...embeddedTools];

        const fileEdits = history
          .flatMap((t) =>
            ((t["toolCalls"] as Array<Record<string, unknown>> | undefined) ?? [])
              .filter((tc) => {
                const n = String(tc["name"] ?? "").toLowerCase();
                return n.includes("edit") || n.includes("write") || n.includes("create");
              })
              .map((tc) => {
                const inp = tc["input"] as Record<string, unknown> | undefined;
                return String(inp?.["path"] ?? inp?.["file"] ?? "");
              })
              .filter(Boolean),
          );

        const terminalCommands = history
          .flatMap((t) =>
            ((t["toolCalls"] as Array<Record<string, unknown>> | undefined) ?? [])
              .filter((tc) => {
                const n = String(tc["name"] ?? "").toLowerCase();
                return n.includes("terminal") || n.includes("run") || n.includes("bash");
              })
              .map((tc) => {
                const inp = tc["input"] as Record<string, unknown> | undefined;
                return String(inp?.["command"] ?? inp?.["cmd"] ?? "");
              })
              .filter(Boolean),
          );

        results.push({
          sessionId: path.basename(file, ".json").replace("copilot.cli.workspaceSessions.", ""),
          workspaceUri: sessionWorkspace,
          toolCalls,
          fileEdits,
          terminalCommands,
          startTime: sessionStart,
          endTime: sessionEnd,
          source: "copilot-cli-session" as const,
        });
      } catch { continue; }
    }

    return results;
  }

  private _extractEmbeddedToolCalls(turns: Array<Record<string, unknown>>): ToolCallCapture[] {
    const result: ToolCallCapture[] = [];
    for (const turn of turns) {
      const content = turn["content"] ?? turn["message"] ?? "";
      if (typeof content !== "string") continue;
      // Tool calls are sometimes serialised as JSON inside markdown code blocks
      const jsonBlocks = content.match(/```json\n([\s\S]*?)\n```/g) ?? [];
      for (const block of jsonBlocks) {
        try {
          const inner = block.replace(/^```json\n/, "").replace(/\n```$/, "");
          const parsed = JSON.parse(inner) as Record<string, unknown>;
          if (parsed["name"] && (parsed["input"] || parsed["arguments"])) {
            result.push({
              name: String(parsed["name"]),
              input: (parsed["input"] ?? parsed["arguments"] ?? {}) as Record<string, unknown>,
              output: String(parsed["output"] ?? ""),
            });
          }
        } catch { continue; }
      }
    }
    return result;
  }
}

// ─── Main Service ─────────────────────────────────────────────────────────────

export class NativeCopilotCaptureService implements vscode.Disposable {
  private readonly _debounceMs: number;
  private readonly _debounceTimers = new Map<string, NodeJS.Timeout>();
  private _chatSessionsWatcher: vscode.FileSystemWatcher | undefined;
  private _memoryWatcher: vscode.FileSystemWatcher | undefined;
  private _sessionFileWatcher: vscode.FileSystemWatcher | undefined;
  private _sessionScanTimer: NodeJS.Timeout | undefined;
  private _enrichedSessionIds = new Set<string>();
  private _localHistory: LocalHistoryCapture | undefined;
  private _chatEditing: ChatEditingSessionsCapture | undefined;
  private _emptyWindow: EmptyWindowChatCapture | undefined;
  private _copilotCLI: CopilotCLISessionCapture | undefined;
  private _activeSessionId: string | null = null;
  private _autoSessionId: string | null = null;      // session auto-created by passive watcher
  private _autoSessionFileKey: string | null = null; // which chatSessions file the auto-session tracks
  private _autoSessionIdleTimer: NodeJS.Timeout | undefined;
  private _chatSessionsTurnCounts = new Map<string, number>(); // filePath -> last seen USER turn count
  private _chatSessionsAsstCounts = new Map<string, number>(); // filePath -> last seen ASSISTANT turn count
  private _chatSessionsMtimes = new Map<string, number>();     // filePath -> last mtime for polling
  private _chatSessionsPollTimer: NodeJS.Timeout | undefined;  // polling fallback for watcher gaps
  private _watermarkPersistTimer: NodeJS.Timeout | undefined;  // debounced workspaceState persist
  private _disposed = false;
  private _workspaceStorageHash: string | undefined;
  private _userDataDir: string | undefined;
  private _latestTurns: NativeChatTurn[] = [];
  private _latestSource = "";
  private _latestConfidence = 0;
  private _memoryStartSnapshot: string[] = [];
  private _metrics: CaptureDebugMetrics;

  constructor(
    private readonly _repoRoot: string,
    private readonly _context: vscode.ExtensionContext,
    private readonly _outputChannel?: vscode.OutputChannel,
    options: NativeCopilotCaptureOptions = {},
  ) {
    this._debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this._metrics = CaptureDebugMetrics.getInstance(_repoRoot);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  /** Start watching. Call from extension activate(). */
  async start(): Promise<void> {
    if (this._disposed) return;

    // Gap 3: restore watermarks before any file scanning so restart never replays history
    this._loadPersistedWatermarks();

    this._userDataDir = resolveVSCodeUserDataDir();
    const workspaceUri = this._resolveWorkspaceUri();
    if (!workspaceUri) {
      this._log("No workspace URI found; skipping native Copilot capture.");
      return;
    }

    this._workspaceStorageHash = await resolveWorkspaceStorageHash(
      this._userDataDir,
      workspaceUri,
    );

    this._metrics.update((s) => {
      s.pathsResolved.userDataDir = this._userDataDir ?? "";
      s.pathsResolved.workspaceStorage = this._workspaceStorageHash ?? "";
    });

    if (!this._workspaceStorageHash) {
      this._log(`No workspaceStorage hash found for ${workspaceUri}; scanning will use fallback paths.`);
      this._metrics.logError(`No workspaceStorage hash found for ${workspaceUri}`);
    }

    // Strategy A: chatSessions file watcher
    this._setupChatSessionsWatcher();
    // GAP 1: prime per-file turn count watermarks so a restart never replays history
    // Also processes today's existing conversations immediately without waiting for a watcher event
    await this._primeWatermarksOnActivate();
    // Polling fallback: re-scan chatSessions files every 15s in case the watcher misses events
    // (known issue: vscode.FileSystemWatcher can miss changes to files outside the workspace folder
    //  after extension reload)
    this._setupChatSessionsPoller();

    // Strategy C: memory files watcher
    this._setupMemoryWatcher();

    // Source D: Local History scanner
    this._localHistory = new LocalHistoryCapture(this._metrics);
    this._localHistory.start();

    // Source E: chatEditingSessions watcher (inline Ctrl+I edits)
    if (this._workspaceStorageHash && this._userDataDir) {
      this._chatEditing = new ChatEditingSessionsCapture(this._metrics);
      this._chatEditing.start(
        path.join(this._userDataDir, "workspaceStorage"),
        this._workspaceStorageHash,
        (edit) => void this._handleInlineEdit(edit),
      );
    }

    // Source F: empty-window chat sessions (cross-workspace)
    this._emptyWindow = new EmptyWindowChatCapture(this._metrics, this._userDataDir);
    await this._emptyWindow.start((turns) => void this._handleEmptyWindowTurns(turns));

    // Source G: Copilot CLI agentic sessions
    this._copilotCLI = new CopilotCLISessionCapture(this._userDataDir);

    // Session enrichment: watch .kodela/sessions/ for watcher-created sessions
    this._setupSessionFileWatcher();

    this._log("Native Copilot capture service started.");
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (this._watermarkPersistTimer) {
      clearTimeout(this._watermarkPersistTimer);
      this._watermarkPersistTimer = undefined;
      void this._persistWatermarks(); // flush any pending watermark writes on dispose
    }

    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();

    this._chatSessionsWatcher?.dispose();
    this._chatSessionsWatcher = undefined;

    this._memoryWatcher?.dispose();
    this._memoryWatcher = undefined;

    this._sessionFileWatcher?.dispose();
    this._sessionFileWatcher = undefined;

    this._localHistory?.dispose();
    this._localHistory = undefined;

    this._chatEditing?.dispose();
    this._chatEditing = undefined;

    this._emptyWindow?.dispose();
    this._emptyWindow = undefined;

    this._copilotCLI = undefined;
    this._activeSessionId = null;

    // Close any auto-session that was still open
    if (this._autoSessionIdleTimer) {
      clearTimeout(this._autoSessionIdleTimer);
      this._autoSessionIdleTimer = undefined;
    }
    void this._closeAutoSession();

    if (this._sessionScanTimer) {
      clearInterval(this._sessionScanTimer);
      this._sessionScanTimer = undefined;
    }

    if (this._chatSessionsPollTimer) {
      clearInterval(this._chatSessionsPollTimer);
      this._chatSessionsPollTimer = undefined;
    }
  }

  // ─── Gap 3: Watermark persistence across restarts ─────────────────────

  private static readonly _WATERMARK_KEY = "kodela.chatSessionsWatermarks.v1";

  /** Load previously persisted watermarks so restart never replays already-seen turns. */
  private _loadPersistedWatermarks(): void {
    // Don't assume the Memento honors the default argument: a non-conformant
    // host (or corrupted workspace state) can return null/undefined, and
    // Object.entries(null) throws — which would crash activation. Coalesce.
    const stored =
      this._context.workspaceState.get<Record<string, [number, number]>>(
        NativeCopilotCaptureService._WATERMARK_KEY,
        {},
      ) ?? {};
    for (const [filePath, counts] of Object.entries(stored)) {
      if (Array.isArray(counts) && counts.length === 2) {
        this._chatSessionsTurnCounts.set(filePath, counts[0] ?? 0);
        this._chatSessionsAsstCounts.set(filePath, counts[1] ?? 0);
      }
    }
  }

  /** Unified setter that updates both in-memory maps and schedules a debounced persist. */
  private _setWatermark(filePath: string, userCount: number, asstCount: number): void {
    this._chatSessionsTurnCounts.set(filePath, userCount);
    this._chatSessionsAsstCounts.set(filePath, asstCount);
    if (!this._watermarkPersistTimer) {
      this._watermarkPersistTimer = setTimeout(() => {
        this._watermarkPersistTimer = undefined;
        void this._persistWatermarks();
      }, 2_000);
    }
  }

  private async _persistWatermarks(): Promise<void> {
    if (this._disposed) return;
    const obj: Record<string, [number, number]> = {};
    for (const [filePath, userCount] of this._chatSessionsTurnCounts) {
      obj[filePath] = [userCount, this._chatSessionsAsstCounts.get(filePath) ?? 0];
    }
    await this._context.workspaceState.update(NativeCopilotCaptureService._WATERMARK_KEY, obj);
  }

  // ─── Strategy A: chatSessions file watcher ────────────────────────────

  /** Prime _chatSessionsTurnCounts for every existing chatSessions JSONL on activate.
   * For files with today's turns, also calls _autoCreateSessionFromTurns immediately
   * so conversations that happened before this reload are captured without waiting
   * for the next watcher event.
   */
  private async _primeWatermarksOnActivate(): Promise<void> {
    if (!this._userDataDir || !this._workspaceStorageHash) return;
    // Scope to the current workspace hash only — scanning all hashes would create
    // sessions for every other VS Code project that has today's chat activity.
    const chatDir = path.join(
      this._userDataDir, "workspaceStorage", this._workspaceStorageHash, "chatSessions"
    );
    let files: string[];
    try { files = await fs.readdir(chatDir); } catch { return; }
    for (const file of files) {
      if (!file.endsWith(".json") && !file.endsWith(".jsonl")) continue;
      const filePath = path.join(chatDir, file);
      try {
        const { mtimeMs } = await fs.stat(filePath);
        this._chatSessionsMtimes.set(filePath, mtimeMs);
        // Only process files modified today — old files would use the last-30-turns
        // heuristic in _filterFreshTurns and create spurious sessions from stale content.
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        if (mtimeMs < todayStart.getTime()) {
          // Prime the watermark so poller/watcher won't re-process old turns, but don't create a session.
          // Skip if already loaded from persisted state (Gap 3) — persisted value is authoritative.
          if (!this._chatSessionsTurnCounts.has(filePath)) {
            const raw = await fs.readFile(filePath, "utf8");
            const { turns } = parseCopilotChatJson(raw);
            this._setWatermark(filePath, turns.filter((t) => t.role === "user").length, turns.filter((t) => t.role === "assistant").length);
          }
          continue;
        }
        const raw = await fs.readFile(filePath, "utf8");
        const { turns, title, contextFiles, chatMetrics, toolActions } = parseCopilotChatJson(raw);
        // Use _autoCreateSessionFromTurns — it sets the watermark AND creates a session
        // for today's turns so conversations before reload are not lost.
        // The watermark is set to turns.length inside the method.
        await this._autoCreateSessionFromTurns(turns, filePath, title, contextFiles, chatMetrics, toolActions);
      } catch { /* locked or missing — watcher will catch new writes */ }
    }
  }

  /**
   * Polling fallback for vscode.FileSystemWatcher gaps.
   * Watches chatSessions files by mtime and fires _readChatSessionFile
   * when a change is detected. Runs every 15 seconds.
   */
  private _setupChatSessionsPoller(): void {
    const POLL_MS = 15_000;
    this._chatSessionsPollTimer = setInterval(() => {
      void this._pollChatSessionFiles();
    }, POLL_MS);
    if (this._chatSessionsPollTimer && typeof this._chatSessionsPollTimer === "object" && "unref" in this._chatSessionsPollTimer) {
      (this._chatSessionsPollTimer as NodeJS.Timeout).unref();
    }
  }

  private async _pollChatSessionFiles(): Promise<void> {
    if (!this._userDataDir || !this._workspaceStorageHash || this._disposed) return;
    // Scope to the current workspace hash only — same reason as _primeWatermarksOnActivate.
    const chatDir = path.join(
      this._userDataDir, "workspaceStorage", this._workspaceStorageHash, "chatSessions"
    );
    let files: string[];
    try { files = await fs.readdir(chatDir); } catch { return; }
    for (const file of files) {
      if (!file.endsWith(".json") && !file.endsWith(".jsonl")) continue;
      const filePath = path.join(chatDir, file);
      try {
        const { mtimeMs } = await fs.stat(filePath);
        const lastMtime = this._chatSessionsMtimes.get(filePath) ?? 0;
        if (mtimeMs > lastMtime) {
          this._chatSessionsMtimes.set(filePath, mtimeMs);
          this._log(`Poll: detected change in ${path.basename(filePath)} (mtime ${mtimeMs})`);
          void this._readChatSessionFile(filePath);
        }
      } catch { /* skip missing/locked files */ }
    }
  }

  private _setupChatSessionsWatcher(): void {
    if (!this._userDataDir) return;

    const storageRoot = path.join(this._userDataDir, "workspaceStorage");
    // Watch all chatSessions JSON files across all workspace hashes.
    // If we have a specific hash, still watch broadly — the hash can change.
    const glob = new vscode.RelativePattern(
      storageRoot,
      "**/chatSessions/**/*.{json,jsonl}",
    );

    try {
      this._chatSessionsWatcher = vscode.workspace.createFileSystemWatcher(glob);
      this._chatSessionsWatcher.onDidCreate((uri) => this._onChatSessionFileChanged(uri));
      this._chatSessionsWatcher.onDidChange((uri) => this._onChatSessionFileChanged(uri));
      this._log("Strategy A: chatSessions file watcher registered.");
      this._metrics.update((s) => {
        s.strategiesActive.chatSessions = true;
        s.sources.chatSessions.active = true;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log(`Strategy A: failed to create watcher — ${msg}`);
      this._metrics.logError(`Strategy A watcher failed: ${msg}`);
    }
  }

  /**
   * Called every time Strategy A detects new chat turns in a VS Code chatSession file.
   * If no Kodela session is currently open (neither @kodela nor watcher-created),
   * this auto-creates one so passive conversations are captured without requiring
   * the user to type @kodela.
   *
   * Auto-sessions are closed after 10 minutes of chatSession file inactivity.
   */
  /**
   * Strip VS Code injected XML context blocks and return clean user-visible text.
   * VS Code prepends <context>, <editorContext>, <reminderInstructions> to every
   * message before sending to Copilot. We want only the actual user question.
   */
  private _cleanTurnContent(content: string): string {
    const cleaned = content
      .replace(/<context>[\s\S]*?<\/context>/g, "")
      .replace(/<editorContext>[\s\S]*?<\/editorContext>/g, "")
      .replace(/<reminderInstructions>[\s\S]*?<\/reminderInstructions>/g, "")
      .replace(/<codeContext>[\s\S]*?<\/codeContext>/gi, "")  // GAP 3: strip codeContext blocks
      .trim();
    // GAP 3: return empty string if too short — callers should skip empty results
    return cleaned.length >= 10 ? cleaned : "";
  }

  /**
   * Returns true if a turn is VS Code tool noise, not a real user question.
   * Filters terminal notifications, tool call outputs, and very short messages.
   */
  private _isNoiseTurn(content: string): boolean {
    const t = content.trim();
    if (t.length < 20) return true;
    if (t.startsWith("[Terminal ")) return true;
    if (t.startsWith("[Tool call")) return true;
    // Pure code block with no surrounding text
    if (/^```[\s\S]*```$/.test(t)) return true;
    // GAP 2: tool call JSON blobs masquerading as user turns
    if (t.startsWith('{"tool"')) return true;
    if (t.startsWith('{"type":"tool')) return true;
    // GAP 2: bare file path or URI (no spaces = not a real question)
    if (/^(file:\/\/|\/[a-z/]|\w:\\)/.test(t) && !t.includes(" ")) return true;
    return false;
  }

  /**
   * Filter full chatSessions turn list down to "current session" turns only.
   * VS Code reuses the same JSONL file for ALL historical conversations.
   * Strategy: filter by today's date using timestamps; fall back to last 30 turns.
   *
   * IMPORTANT: assistant turns never have timestamps in VS Code's JSONL format.
   * They must be paired with their preceding user turn — not filtered independently.
   */
  private _filterFreshTurns(turns: NativeChatTurn[]): NativeChatTurn[] {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    const userTurnsWithTimestamps = turns.filter((t) => t.role === "user" && !!t.timestamp);
    if (userTurnsWithTimestamps.length > 0) {
      // Enough timestamps — filter user turns to today, carry their paired assistant turns along.
      const result: NativeChatTurn[] = [];
      let lastUserIsToday = false;
      for (const turn of turns) {
        if (turn.role === "user") {
          lastUserIsToday = !!turn.timestamp && new Date(turn.timestamp).getTime() >= todayMs;
          if (lastUserIsToday) {
            const cleaned = this._cleanTurnContent(turn.content);
            if (!this._isNoiseTurn(cleaned)) result.push({ ...turn, content: cleaned });
          }
        } else {
          // Assistant turn: keep it only if its preceding user turn was today
          if (lastUserIsToday) {
            const cleaned = this._cleanTurnContent(turn.content);
            if (cleaned.length >= 10) result.push({ ...turn, content: cleaned });
          }
        }
      }
      if (result.length > 0) return result;
    }

    // No usable timestamps — take last 30 turns as heuristic for "current session"
    const result: NativeChatTurn[] = [];
    let lastUserKept = false;
    for (const turn of turns.slice(-30)) {
      if (turn.role === "user") {
        const cleaned = this._cleanTurnContent(turn.content);
        lastUserKept = !this._isNoiseTurn(cleaned);
        if (lastUserKept) result.push({ ...turn, content: cleaned });
      } else {
        if (lastUserKept) {
          const cleaned = this._cleanTurnContent(turn.content);
          if (cleaned.length >= 10) result.push({ ...turn, content: cleaned });
        }
      }
    }
    return result;
  }

  /**
   * Returns true when the conversation clearly belongs to a different workspace.
   *
   * VS Code scopes chatSessions to the window, not the project folder. Long-running
   * windows accumulate chat from every project the user touched in that window.
   *
   * Detection strategy (three layers):
   * L1. Absolute paths in USER turns: if all point outside _repoRoot → foreign.
   * L2. Relative source paths in ASSISTANT turns that don't exist under _repoRoot → foreign.
   * L3. Gap 7: chatTitle workspace affinity — if a title is set and contains no term from
   *     this repo's name or known package names, and the content has no local signal, skip it.
   *     This catches generic questions ("How do I add AD scanning?") where no paths appear.
   */
  private _isForeignWorkspaceSession(turns: NativeChatTurn[], chatTitle?: string): boolean {
    const repoNorm = this._repoRoot.replace(/\\/g, "/").toLowerCase();
    const repoName = path.basename(this._repoRoot).toLowerCase(); // e.g. "kodela"

    // Layer 1: absolute paths in user content
    const userText = turns.filter((t) => t.role === "user").map((t) => t.content).join("\n");
    const absMatches = userText.match(/(?:file:\/\/\/|\/)[^\s"'`,\][\)>]{8,}/g) ?? [];
    if (absMatches.length > 0) {
      let foreign = 0;
      let local = 0;
      for (const p of absMatches) {
        const norm = p.replace(/^file:\/\//, "").replace(/\\/g, "/").toLowerCase();
        if (norm.startsWith(repoNorm)) local++;
        else if (norm.startsWith("/home/") || norm.startsWith("/root/") || norm.startsWith("/users/")) foreign++;
      }
      if (foreign > 0 && local === 0) return true;
      if (local > 0) return false; // explicit local paths → keep
    }

    // Layer 2: relative src paths in assistant responses that don't exist here
    const asstText = turns.filter((t) => t.role === "assistant").map((t) => t.content).join("\n");
    const relPaths = asstText.match(/\b(?:src|lib|artifacts|app|pages|components|routes|api)\/[^\s"'`\][\)>]{4,}/g) ?? [];
    if (relPaths.length > 0) {
      const fsSync = require("node:fs") as typeof import("node:fs");
      let existsHere = 0;
      for (const rel of relPaths.slice(0, 12)) {
        try {
          fsSync.accessSync(path.join(this._repoRoot, rel.replace(/[.,;:)]+$/, "")));
          existsHere++;
        } catch { /* doesn't exist */ }
      }
      if (existsHere === 0) return true;  // all paths foreign
      return false;                       // at least one local path → keep
    }

    // Layer 3 (Gap 7): title-based workspace affinity for generic conversations.
    // Only applies when we have a non-empty title AND no path signal from either turn side.
    // Build a small vocabulary from: repo folder name + top-level dir names in this workspace.
    if (chatTitle) {
      const titleLower = chatTitle.toLowerCase();

      // Quick check: if the title contains the repo name, keep it
      if (titleLower.includes(repoName)) return false;

      // Read top-level workspace dir names as vocabulary (sync, cached implicitly by OS)
      const fsSync = require("node:fs") as typeof import("node:fs");
      let topDirs: string[] = [];
      try {
        topDirs = fsSync.readdirSync(this._repoRoot)
          .filter((d: string) => {
            try { return fsSync.statSync(path.join(this._repoRoot, d)).isDirectory(); } catch { return false; }
          })
          .map((d: string) => d.toLowerCase());
      } catch { /* skip */ }

      // If the title contains any top-level directory name, the conversation is likely local
      const hasLocalTerm = topDirs.some((d) => d.length > 3 && titleLower.includes(d));
      if (hasLocalTerm) return false;

      // Known foreign domain keywords that clearly indicate another project.
      // These are generic enough to avoid false positives on Kodela conversations.
      const foreignKeywords = [
        "active directory", "ldap", "ad user", "ad group", "domain controller",
        "vault", "pam", "privileged access", "kerberos", "rdp", "bastion",
        "database proxy", "db proxy",
      ];
      const isClearlyForeign = foreignKeywords.some((kw) => titleLower.includes(kw));
      if (isClearlyForeign) return true;
    }

    return false;
  }

  private async _autoCreateSessionFromTurns(
    turns: NativeChatTurn[],
    filePath: string,
    chatTitle?: string,
    contextFiles?: string[],
    chatMetrics?: ChatSessionMetrics,
    toolActions?: NativeToolAction[],
  ): Promise<void> {
    // Gap 3: If @kodela or watcher session is active, cancel any auto-session and yield
    if (this._activeSessionId) {
      if (this._autoSessionId) {
        if (this._autoSessionIdleTimer) {
          clearTimeout(this._autoSessionIdleTimer);
          this._autoSessionIdleTimer = undefined;
        }
        void this._closeAutoSession();
      }
      return;
    }

    const prevUserCount = this._chatSessionsTurnCounts.get(filePath) ?? 0;
    const prevAsstCount = this._chatSessionsAsstCounts.get(filePath) ?? 0;
    const newUserCount = turns.filter((t) => t.role === "user").length;
    const newAsstCount = turns.filter((t) => t.role === "assistant").length;

    // Eagerly update watermarks before any await to prevent concurrent watcher/poller
    // callbacks from reading the same prevCount and double-appending the same turns.
    if (this._autoSessionId && this._autoSessionFileKey === filePath) {
      this._setWatermark(filePath, newUserCount, newAsstCount);
    }
    // Tracks user and assistant counts separately: assistant turns can arrive late
    // (after streaming completes) at flat-array positions BELOW where a flat-count
    // watermark would slice — they would be missed forever. Separate counts ensure
    // late-arriving assistant turns are always detected and appended.
    if (this._autoSessionId && this._autoSessionFileKey === filePath) {
      const hasNewUsers = newUserCount > prevUserCount;
      const hasNewAsst = newAsstCount > prevAsstCount;
      if (hasNewUsers || hasNewAsst) {
        this._setWatermark(filePath, newUserCount, newAsstCount);
        this._resetAutoSessionIdleTimer();

        // Process new user turns (requests after prevUserCount)
        if (hasNewUsers) {
          let userIdx = 0;
          for (const turn of turns) {
            if (turn.role !== "user") continue;
            if (userIdx >= prevUserCount) {
              const cleaned = this._cleanTurnContent(turn.content);
              if (!this._isNoiseTurn(cleaned)) {
                await appendUserTurn(this._repoRoot, this._autoSessionId, cleaned, { source: SOURCE_CHATSESSIONS }).catch(() => undefined);
              }
            }
            userIdx++;
          }
        }

        // Process new assistant turns. These may be late-arriving responses for
        // requests that were streaming when the previous read happened. They are
        // interleaved into the rebuilt flat array at positions below the old flat
        // watermark, so we track them by count rather than position.
        if (hasNewAsst) {
          let asstIdx = 0;
          for (const turn of turns) {
            if (turn.role !== "assistant") continue;
            if (asstIdx >= prevAsstCount) {
              const cleaned = this._cleanTurnContent(turn.content);
              if (cleaned.length >= 10) {
                await appendAssistantTurn(this._repoRoot, this._autoSessionId, cleaned, {
                  source: SOURCE_CHATSESSIONS,
                  reasoning: turn.reasoning,
                }).catch(() => undefined);
              }
            }
            asstIdx++;
          }
        }
      }
      return;
    }

    // Different file than current auto-session — close old one and start fresh
    if (this._autoSessionId && this._autoSessionFileKey !== filePath) {
      void this._closeAutoSession();
    }

    // Gap 1+4: Filter to fresh (today's) turns and strip injected context
    const freshTurns = this._filterFreshTurns(turns);
    const firstUser = freshTurns.find((t) => t.role === "user");
    if (!firstUser) {
      // No meaningful user turn today — record counts and skip
      this._setWatermark(filePath, newUserCount, newAsstCount);
      return;
    }

    // Cross-workspace contamination guard: VS Code stores ALL chat from a window
    // in the workspace-scoped chatSessions dir, regardless of which project was
    // discussed. Skip sessions whose content clearly references a different workspace.
    if (this._isForeignWorkspaceSession(freshTurns, chatTitle)) {
      this._setWatermark(filePath, newUserCount, newAsstCount);
      this._log(`Strategy A: skipping session — content references a different workspace`);
      return;
    }

    // Create the auto-session
    const sessionId = randomUUID();
    this._autoSessionId = sessionId;
    this._autoSessionFileKey = filePath;
    this._setWatermark(filePath, newUserCount, newAsstCount);

    // Use chatTitle as goal when present (it's the user-assigned session label, most accurate).
    // Fall back to the cleaned first user turn text.
    const cleanedFirstPrompt = this._cleanTurnContent(firstUser.content);
    const goal = chatTitle || cleanedFirstPrompt.slice(0, 120) || "Copilot chat session";

    try {
      await startSession(this._repoRoot, sessionId, { goal });
      await appendSessionCaptureSource(this._repoRoot, sessionId, SOURCE_CHATSESSIONS);

      // Seed intent from cleaned first user turn; include contextFiles if captured
      await updateSessionIntent(this._repoRoot, sessionId, {
        userPrompt: cleanedFirstPrompt,
        source: SOURCE_CHATSESSIONS,
        confidence: CONFIDENCE_CHATSESSIONS,
        ...(contextFiles?.length ? { contextFiles } : {}),
      }).catch(() => undefined);

      // Gap 5: persist model attribution and effort metrics
      if (chatMetrics?.modelId) {
        await updateSessionActor(this._repoRoot, sessionId, {
          tool: "vscode-copilot",
          model: chatMetrics.modelId,
          chatMetrics,
        }).catch(() => undefined);
      }

      // Gap 6: seed annotation with repo memory-tool context so LM enrichment
      // has accumulated codebase knowledge available from the start
      const priorContext = await this._readRepoMemoryContext();
      if (priorContext) {
        await updateSessionAnnotation(this._repoRoot, sessionId, {
          reasoning: priorContext,
          source: SOURCE_MEMORY,
        }).catch(() => undefined);
      }

      // Gap 2: write tool actions sidecar before turn seeding so it's available immediately
      if (toolActions && toolActions.length > 0) {
        await this._writeToolActionsSidecar(sessionId, toolActions).catch(() => undefined);
      }

      // Seed only fresh turns (today's, noise-filtered)
      for (const turn of freshTurns) {
        const cleaned = this._cleanTurnContent(turn.content);
        if (turn.role === "user") {
          await appendUserTurn(this._repoRoot, sessionId, cleaned, { source: SOURCE_CHATSESSIONS }).catch(() => undefined);
        } else {
          await appendAssistantTurn(this._repoRoot, sessionId, cleaned, {
            source: SOURCE_CHATSESSIONS,
            reasoning: turn.reasoning,
          }).catch(() => undefined);
        }
      }

      // Watermark local-history and snapshot memory baseline (same as onSessionStart)
      this._localHistory?.markSessionStart();
      await this.captureMemorySnapshot("start").catch(() => undefined);

      this._log(`Auto-session created: ${sessionId} (${freshTurns.length} fresh turns from ${path.basename(filePath)})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log(`Auto-session create failed: ${msg}`);
      this._autoSessionId = null;
      this._autoSessionFileKey = null;
      return;
    }

    this._resetAutoSessionIdleTimer();
  }

  /** Reset the 10-minute idle timer that closes the auto-session. */
  private _resetAutoSessionIdleTimer(): void {
    if (this._autoSessionIdleTimer) clearTimeout(this._autoSessionIdleTimer);
    const IDLE_MS = 10 * 60_000; // 10 minutes of no new chat activity
    this._autoSessionIdleTimer = setTimeout(() => {
      void this._closeAutoSession();
    }, IDLE_MS);
    if (typeof this._autoSessionIdleTimer === "object" && "unref" in this._autoSessionIdleTimer) {
      (this._autoSessionIdleTimer as NodeJS.Timeout).unref();
    }
  }

  /** Close and enrich the auto-created session. */
  /**
   * Write tool actions to a sidecar file ({sessionId}.actions.jsonl) outside the
   * turns array so watermark arithmetic is unaffected. Each line is one NativeToolAction.
   * Called only on initial session creation — delta reads don't append here (accepted tradeoff).
   */
  private async _writeToolActionsSidecar(sessionId: string, toolActions: NativeToolAction[]): Promise<void> {
    const sidecarPath = path.join(this._repoRoot, ".kodela", "sessions", `${sessionId}.actions.jsonl`);
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    const lines = toolActions.map((a) => JSON.stringify(a)).join("\n") + "\n";
    await fs.appendFile(sidecarPath, lines, "utf-8");
    this._log(`Gap 2: wrote ${toolActions.length} tool actions to ${sessionId}.actions.jsonl`);
  }

  private async _closeAutoSession(): Promise<void> {
    const sessionId = this._autoSessionId;
    if (!sessionId) return;
    this._autoSessionId = null;
    this._autoSessionFileKey = null;

    // Gap 3: If a @kodela session is now active, don't overwrite its data
    if (this._activeSessionId) {
      this._log(`Auto-session ${sessionId} abandoned — @kodela session is active.`);
      return;
    }

    this._log(`Auto-session closing: ${sessionId}`);
    try {
      await this.onSessionClose(sessionId);
      await closeSession(this._repoRoot, sessionId).catch(() => undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log(`Auto-session close error: ${msg}`);
    }
  }

  private _onChatSessionFileChanged(uri: vscode.Uri): void {
    const filePath = uri.fsPath;

    // Debounce to avoid partial-write reads
    const existing = this._debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this._debounceTimers.delete(filePath);
      void this._readChatSessionFile(filePath);
    }, this._debounceMs);

    this._debounceTimers.set(filePath, timer);
  }

  private async _readChatSessionFile(filePath: string): Promise<void> {
    try {
      // Update mtime so the poller doesn't re-fire for the same write
      try {
        const { mtimeMs } = await fs.stat(filePath);
        this._chatSessionsMtimes.set(filePath, mtimeMs);
      } catch { /* ignore stat errors */ }

      const raw = await fs.readFile(filePath, "utf-8");
      const { turns, title, contextFiles, chatMetrics, toolActions } = parseCopilotChatJson(raw);

      if (turns.length === 0) {
        this._log(`Strategy A: no turns parsed from ${path.basename(filePath)}`);
        return;
      }

      this._latestTurns = turns;
      this._latestSource = SOURCE_CHATSESSIONS;
      this._latestConfidence = CONFIDENCE_CHATSESSIONS;
      this._log(
        `Strategy A: captured ${turns.length} turns from ${path.basename(filePath)}` +
        (title ? ` [${title}]` : "") +
        (chatMetrics ? ` tokens=${chatMetrics.totalCompletionTokens} model=${chatMetrics.modelId ?? "?"}` : ""),
      );
      const preview = turns.find((t) => t.role === "user")?.content?.slice(0, 100) ?? "";
      this._metrics.update((s) => {
        s.metrics.filesParsed++;
        s.sources.chatSessions.filesParsed++;
        s.sources.chatSessions.lastFileParsed = path.basename(filePath);
        s.sources.chatSessions.lastTurnsCount = turns.length;
        s.sources.chatSessions.lastTurnPreview = preview;
        s.sources.chatSessions.lastEventTime = new Date().toISOString();
      });
      this._metrics.recordCapture("chatSessions", preview, turns.length);

      // Auto-create a Kodela session if none is currently open
      void this._autoCreateSessionFromTurns(turns, filePath, title, contextFiles, chatMetrics, toolActions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log(`Strategy A: failed to read ${path.basename(filePath)} — ${msg}`);
      this._metrics.logError(`Strategy A read error: ${msg}`);
    }
  }

  // ─── Strategy B: SQLite state.vscdb reader ────────────────────────────

  /** Run Strategy B as a fallback when Strategy A has no data. */
  private async _runSqliteFallback(): Promise<NativeChatTurn[]> {
    if (!this._userDataDir) return [];

    const storageRoot = path.join(this._userDataDir, "workspaceStorage");
    const hashDirs = this._workspaceStorageHash
      ? [this._workspaceStorageHash]
      : await this._listStorageHashes(storageRoot);

    for (const hash of hashDirs) {
      const dbPath = path.join(storageRoot, hash, "state.vscdb");
      try {
        await fs.access(dbPath);
      } catch {
        continue;
      }

      const turns = await this._querySqliteDb(dbPath);
      if (turns.length > 0) {
        this._log(`Strategy B: captured ${turns.length} turns from ${hash}/state.vscdb`);
        this._metrics.update((s) => {
          s.strategiesActive.sqlite = true;
          s.sources.sqlite.active = true;
          s.sources.sqlite.queriesRun++;
          s.sources.sqlite.available = true;
          s.metrics.filesParsed++;
        });
        this._metrics.recordCapture("sqlite", `${turns.length} turns from ${hash}`, turns.length);
        return turns;
      }
    }

    this._log("Strategy B: no chat data found in any state.vscdb.");
    return [];
  }

  private async _querySqliteDb(dbPath: string): Promise<NativeChatTurn[]> {
    try {
      const { stdout } = await execFileAsync(
        "sqlite3",
        [
          dbPath,
          "SELECT value FROM ItemTable WHERE key LIKE 'chat.%' OR key LIKE 'memento/interactive-session%';",
        ],
        { timeout: SQLITE_TIMEOUT_MS },
      );
      return parseSqliteChatData(stdout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log(`Strategy B: sqlite3 query failed — ${msg}`);
      this._metrics.logError(`Strategy B SQLite query failed: ${msg}`);
      return [];
    }
  }

  private async _listStorageHashes(storageRoot: string): Promise<string[]> {
    try {
      return await fs.readdir(storageRoot);
    } catch {
      return [];
    }
  }

  // ─── Strategy C: Memory files reader ──────────────────────────────────

  private _setupMemoryWatcher(): void {
    if (!this._userDataDir) return;

    // Watch workspace-scoped memory files
    const storageRoot = path.join(this._userDataDir, "workspaceStorage");
    const memoryGlob = new vscode.RelativePattern(
      storageRoot,
      "**/memory/**/*.md",
    );

    try {
      this._memoryWatcher = vscode.workspace.createFileSystemWatcher(memoryGlob);
      this._memoryWatcher.onDidCreate((uri) => {
        this._log("Strategy C: memory file created during session.");
        const name = path.basename(uri.fsPath);
        this._metrics.update((s) => {
          s.sources.memoryTool.filesRead++;
          s.sources.memoryTool.lastFileRead = name;
          s.metrics.memoryFilesRead++;
        });
        this._metrics.recordCapture("memoryTool", name, 1);
      });
      this._memoryWatcher.onDidChange((uri) => {
        this._log("Strategy C: memory file updated during session.");
        this._metrics.update((s) => { s.sources.memoryTool.lastFileRead = path.basename(uri.fsPath); });
      });
      this._log("Strategy C: memory file watcher registered.");
      const watchPathStr = path.join(this._userDataDir ?? "", "workspaceStorage");
      this._metrics.update((s) => {
        s.strategiesActive.memory = true;
        s.sources.memoryTool.active = true;
        s.sources.memoryTool.watchPath = watchPathStr;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log(`Strategy C: failed to create watcher — ${msg}`);
      this._metrics.logError(`Strategy C watcher failed: ${msg}`);
    }
  }

  /** Capture memory snapshots from both user and workspace scopes. */
  async captureMemorySnapshot(phase: "start" | "end"): Promise<string[]> {
    const snapshots: string[] = [];

    // User-scoped memory: globalStorage/github.copilot.chat/memory/
    if (this._userDataDir) {
      const userMemoryDir = path.join(
        this._userDataDir,
        "globalStorage",
        "github.copilot.chat",
        "memory",
      );
      const userFiles = await this._readMemoryDir(userMemoryDir);
      snapshots.push(...userFiles);
    }

    // Workspace-scoped memory: workspaceStorage/[hash]/memory/
    if (this._userDataDir && this._workspaceStorageHash) {
      const wsMemoryDir = path.join(
        this._userDataDir,
        "workspaceStorage",
        this._workspaceStorageHash,
        "memory",
      );
      const wsFiles = await this._readMemoryDir(wsMemoryDir);
      snapshots.push(...wsFiles);
    }

    if (phase === "start") {
      this._memoryStartSnapshot = [...snapshots];
    }

    this._log(`Strategy C: captured ${snapshots.length} memory files (${phase}).`);
    this._metrics.update((s) => { s.metrics.memoryFilesRead += snapshots.length; });
    return snapshots;
  }

  /**
   * Gap 6: Read the workspace-scoped Copilot repo-memory files and return a compact
   * summary (≤800 chars) usable as prior-context seed for a new session.
   *
   * VS Code writes these at:
   *   workspaceStorage/[hash]/GitHub.copilot-chat/memory-tool/memories/repo/
   */
  private async _readRepoMemoryContext(): Promise<string | undefined> {
    if (!this._userDataDir || !this._workspaceStorageHash) return undefined;
    const repoDir = path.join(
      this._userDataDir,
      "workspaceStorage",
      this._workspaceStorageHash,
      "GitHub.copilot-chat",
      "memory-tool",
      "memories",
      "repo",
    );
    try {
      const files = (await fs.readdir(repoDir)).filter((f) => f.endsWith(".md"));
      if (files.length === 0) return undefined;
      const snippets: string[] = [];
      let remaining = 800;
      for (const file of files.slice(0, 5)) {
        const content = await fs.readFile(path.join(repoDir, file), "utf-8").catch(() => "");
        const trimmed = content.trim();
        if (!trimmed) continue;
        const excerpt = trimmed.slice(0, remaining);
        snippets.push(`[${file.replace(".md", "")}]\n${excerpt}`);
        remaining -= excerpt.length;
        if (remaining <= 0) break;
      }
      return snippets.length > 0 ? snippets.join("\n\n") : undefined;
    } catch {
      return undefined;
    }
  }

  private async _readMemoryDir(dirPath: string): Promise<string[]> {
    const contents: string[] = [];
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        try {
          const content = await fs.readFile(path.join(dirPath, file), "utf-8");
          if (content.trim().length > 0) {
            contents.push(content.trim());
          }
        } catch {
          // skip unreadable files (locked by VS Code)
        }
      }
    } catch {
      // directory doesn't exist — expected on fresh installs
    }
    return contents;
  }

  // ─── Session Lifecycle API ────────────────────────────────────────────

  /**
   * GAP 4: When a @kodela session closes, absorb any codeChanges that were captured
   * passively by the auto-session during the same period. Called from copilot-session-capture.ts
   * before the session is finalised. @kodela annotation/intent is never overwritten.
   */
  async absorbAutoSessionCodeChanges(kodelaSessionId: string): Promise<void> {
    if (!this._autoSessionId) return;
    const autoId = this._autoSessionId;

    try {
      const [kodelaSession, autoSession] = await Promise.all([
        readSession(this._repoRoot, kodelaSessionId).catch(() => null),
        readSession(this._repoRoot, autoId).catch(() => null),
      ]);

      if (!kodelaSession || !autoSession) return;

      const extraChanges = autoSession.codeChanges ?? [];
      if (extraChanges.length === 0) return;

      const updated = {
        ...kodelaSession,
        codeChanges: [...(kodelaSession.codeChanges ?? []), ...extraChanges],
        captureSources: [...new Set([...(kodelaSession.captureSources ?? []), "local-history"])],
      };
      await writeSession(this._repoRoot, updated).catch(() => undefined);
      this._log(`GAP 4: absorbed ${extraChanges.length} codeChanges from auto-session ${autoId} into ${kodelaSessionId}`);
    } catch (err) {
      this._log(`GAP 4: absorb failed — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Discard the auto-session — its useful data is now in the @kodela session
      this._autoSessionId = null;
      this._autoSessionFileKey = null;
    }
  }

  /**
   * Call when a new Kodela session starts.
   * Records the Local History watermark and baselines memory state.
   */
  async onSessionStart(sessionId: string): Promise<void> {
    this._activeSessionId = sessionId;

    // Gap 3: @kodela session takes over — cancel auto-session idle timer and close gracefully
    if (this._autoSessionId) {
      if (this._autoSessionIdleTimer) {
        clearTimeout(this._autoSessionIdleTimer);
        this._autoSessionIdleTimer = undefined;
      }
      void this._closeAutoSession();
    }

    // Must be set BEFORE any watcher fires — watermarks the diff window
    this._localHistory?.markSessionStart();

    // Snapshot memory baseline for delta computation at close
    await this.captureMemorySnapshot("start").catch(() => undefined);

    // Pre-load cross-workspace empty-window sessions for context
    await this._emptyWindow?.readAllExisting().catch(() => undefined);
  }

  /**
   * Call when a Kodela session closes.
   * Runs all close-time captures in parallel and persists results to the session file.
   */
  async onSessionClose(sessionId: string): Promise<void> {
    const workspacePath = this._resolveWorkspaceUri()
      ? (() => { try { return new URL(this._resolveWorkspaceUri()!).pathname; } catch { return this._resolveWorkspaceUri()!; } })()
      : "";

    const sessionStart = this._localHistory
      ? (this._localHistory as unknown as { _sessionStartTime: number })["_sessionStartTime"] ?? 0
      : 0;

    // Run all close-time captures in parallel
    const [changesResult, cliResult] = await Promise.allSettled([
      this._localHistory?.captureSessionChanges() ?? Promise.resolve([]),
      this._copilotCLI?.getSessionsForWindow(workspacePath, sessionStart, Date.now()) ?? Promise.resolve([]),
    ]);

    // Read current session once to apply all updates atomically
    const session = await readSession(this._repoRoot, sessionId).catch(() => null);
    if (!session) {
      this._activeSessionId = null;
      return;
    }

    let updated = { ...session };

    // Local History diffs
    if (changesResult.status === "fulfilled" && changesResult.value.length > 0) {
      updated.codeChanges = changesResult.value;
      updated.captureSources = [...new Set([...(updated.captureSources ?? []), "local-history"])];
    }

    // Copilot CLI agent actions
    if (cliResult.status === "fulfilled" && cliResult.value.length > 0) {
      updated.agentActions = cliResult.value.flatMap((s) => s.toolCalls);
      updated.captureSources = [...new Set([...(updated.captureSources ?? []), "copilot-cli-session"])];
    }

    // Memory delta (use existing captureMemorySnapshot end + compute new insights)
    try {
      const endMemory = await this.captureMemorySnapshot("end");
      if (endMemory.length > 0) {
        const startSnap = this._memoryStartSnapshot;
        const startSet = new Set(startSnap);
        const newInsights = endMemory.filter((line) => !startSet.has(line));
        updated.copilotMemory = {
          ...updated.copilotMemory,
          startSnapshot: startSnap,
          endSnapshot: endMemory,
          newInsights: newInsights.length > 0 ? newInsights : undefined,
        };
        if (newInsights.length > 0) {
          updated.captureSources = [...new Set([...(updated.captureSources ?? []), SOURCE_MEMORY])];
        }
      }
    } catch { /* non-blocking */ }

    await writeSession(this._repoRoot, updated).catch(() => undefined);

    this._activeSessionId = null;

    // Auto-trigger LM enrichment when passive sources captured but no @kodela interaction
    const hasPassive = (updated.captureSources ?? []).some((s) =>
      ["local-history", SOURCE_CHATSESSIONS, "copilot-inline-edit"].includes(s),
    );
    const hasChatParticipant = (updated.captureSources ?? []).includes("vscode-chat-participant");
    if (hasPassive && !hasChatParticipant && !this._enrichedSessionIds.has(sessionId)) {
      this._enrichedSessionIds.add(sessionId);
      void this.mergeIntoSession(sessionId).catch(() => undefined);
    }
  }

  // ─── Inline edit / empty-window turn handlers ─────────────────────────

  private async _handleInlineEdit(edit: InlineEditCapture): Promise<void> {
    const sid = this._activeSessionId ?? this._autoSessionId;
    if (!sid) return;
    const session = await readSession(this._repoRoot, sid).catch(() => null);
    if (!session) return;
    const updated = {
      ...session,
      inlineEdits: [...(session.inlineEdits ?? []), edit],
      captureSources: [...new Set([...(session.captureSources ?? []), "copilot-inline-edit"])],
    };
    await writeSession(this._repoRoot, updated).catch(() => undefined);
  }

  private async _handleEmptyWindowTurns(turns: EmptyWindowChatTurn[]): Promise<void> {
    const sid = this._activeSessionId ?? this._autoSessionId;
    if (!sid || turns.length === 0) return;
    const lastUser = [...turns].reverse().find((t) => t.userContent);
    const lastAssistant = [...turns].reverse().find((t) => t.assistantContent);
    if (!lastUser) return;

    await appendUserTurn(this._repoRoot, sid, lastUser.userContent, { source: "empty-window-chat" })
      .catch(() => undefined);
    if (lastAssistant?.assistantContent) {
      await appendAssistantTurn(this._repoRoot, sid, lastAssistant.assistantContent, { source: "empty-window-chat" })
        .catch(() => undefined);
    }
    await appendSessionCaptureSource(this._repoRoot, sid, "empty-window-chat")
      .catch(() => undefined);
  }

  // ─── Public Merge API ─────────────────────────────────────────────────

  /**
   * Inject passively captured native Copilot data into a Kodela session.
   *
   * Merge rules:
   *   - Only writes if Path 1 (Chat Participant) has NOT already captured
   *     the same field (Path 1 is higher fidelity — exact prompt wins).
   *   - Strategy A has priority over Strategy B.
   *   - Strategy C writes to copilotMemory (never overwrites prompt/reasoning).
   *
   * Returns true if any data was merged.
   */
  async mergeIntoSession(sessionId: string): Promise<boolean> {
    const session = await readSession(this._repoRoot, sessionId).catch(() => null);
    if (!session) return false;
    this._metrics.update((s) => { s.metrics.enrichmentAttempts++; });

    // Check if Path 1 already has captured data
    const hasPath1Prompt = !!(session.intent?.userPrompt?.trim());
    const hasPath1Reasoning = !!(session.annotation?.reasoning?.trim());
    const path1Sources = session.captureSources ?? [];
    const hasPath1 = path1Sources.includes("vscode-chat-participant");

    let merged = false;

    // Strategy A first, Strategy B as fallback
    let turns = this._latestTurns;
    let source = this._latestSource;
    let confidence = this._latestConfidence;

    if (turns.length === 0) {
      // Try Strategy B
      turns = await this._runSqliteFallback();
      if (turns.length > 0) {
        source = SOURCE_SQLITE;
        confidence = CONFIDENCE_SQLITE;
      }
    }

    if (turns.length > 0 && !hasPath1) {
      // Gap 5: Use only fresh (today's) turns for watcher-session enrichment.
      // _latestTurns can contain ALL historical turns from a long-lived chatSessions file
      // (e.g. 79 turns since April 29). Without this filter, watcher sessions get the
      // last turn from weeks ago as their intent instead of today's conversation.
      const freshTurns = this._filterFreshTurns(turns);
      const turnsToWrite = freshTurns.length > 0 ? freshTurns : turns.slice(-10);

      const lastUser = [...turnsToWrite].reverse().find((t) => t.role === "user");
      const lastAssistant = [...turnsToWrite].reverse().find((t) => t.role === "assistant");

      // Write user prompt if not already captured
      if (lastUser && !hasPath1Prompt) {
        const cleanedPrompt = this._cleanTurnContent(lastUser.content);
        await updateSessionIntent(this._repoRoot, sessionId, {
          userPrompt: cleanedPrompt,
          source,
          confidence,
        }).catch(() => undefined);

        await appendUserTurn(
          this._repoRoot,
          sessionId,
          cleanedPrompt,
          { source },
        ).catch(() => undefined);

        merged = true;
      }

      // Write assistant reasoning if not already captured
      if (lastAssistant && !hasPath1Reasoning) {
        const cleanedReasoning = this._cleanTurnContent(lastAssistant.content);
        await updateSessionAnnotation(this._repoRoot, sessionId, {
          reasoning: cleanedReasoning,
          source,
        }).catch(() => undefined);

        await appendAssistantTurn(
          this._repoRoot,
          sessionId,
          cleanedReasoning,
          { source },
        ).catch(() => undefined);

        merged = true;
      }

      // Persist remaining fresh turns (noise-filtered and cleaned)
      for (const turn of turnsToWrite) {
        if (turn === lastUser || turn === lastAssistant) continue;
        const cleaned = this._cleanTurnContent(turn.content);
        if (this._isNoiseTurn(cleaned)) continue;
        if (turn.role === "user") {
          await appendUserTurn(this._repoRoot, sessionId, cleaned, { source }).catch(
            () => undefined,
          );
        } else {
          await appendAssistantTurn(this._repoRoot, sessionId, cleaned, { source }).catch(
            () => undefined,
          );
        }
      }

      // Add capture source
      await appendSessionCaptureSource(this._repoRoot, sessionId, source).catch(
        () => undefined,
      );
    }

    // Strategy C: memory data
    const endMemory = await this.captureMemorySnapshot("end");
    if (endMemory.length > 0 || this._memoryStartSnapshot.length > 0) {
      if (this._memoryStartSnapshot.length > 0) {
        await updateSessionCopilotMemory(
          this._repoRoot,
          sessionId,
          "start",
          this._memoryStartSnapshot,
          SOURCE_MEMORY,
        ).catch(() => undefined);
      }
      if (endMemory.length > 0) {
        await updateSessionCopilotMemory(
          this._repoRoot,
          sessionId,
          "end",
          endMemory,
          SOURCE_MEMORY,
        ).catch(() => undefined);
      }
      await appendSessionCaptureSource(this._repoRoot, sessionId, SOURCE_MEMORY).catch(
        () => undefined,
      );
      merged = true;
    }

    if (merged) {
      await appendSessionTimelineEvent(this._repoRoot, sessionId, {
        type: "native-copilot-merge",
        source,
        data: {
          turnsCount: turns.length,
          memoryFiles: endMemory.length,
          strategy: source,
        },
      }).catch(() => undefined);
    }

    return merged;
  }

  /**
   * Check whether native capture found data that requires LM enrichment.
   * Returns true if we have Strategy A/B data but no Path 1 data.
   */
  hasPassiveCaptureOnly(session: {
    captureSources?: string[];
    intent?: { source?: string };
  }): boolean {
    const sources = session.captureSources ?? [];
    const hasPath1 = sources.includes("vscode-chat-participant");
    const hasPassive =
      sources.includes(SOURCE_CHATSESSIONS) || sources.includes(SOURCE_SQLITE);
    return hasPassive && !hasPath1;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private _resolveWorkspaceUri(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0]!.uri.toString();
    }
    return undefined;
  }

  private _log(message: string): void {
    this._outputChannel?.appendLine(`[native-capture] ${message}`);
  }

  // ─── Session enrichment: auto-enrich watcher sessions ─────────────────

  /**
   * Watch `.kodela/sessions/` for session files created by the watcher daemon.
   * When a session file is created or modified, check if it lacks chat context
   * and auto-enrich it with any available native Copilot data.
   *
   * This closes the critical gap: without this, mergeIntoSession() was only
   * called from the Chat Participant path (Path 1), meaning watcher-originated
   * sessions always produced file-only memory with gaps 121–123.
   */
  private _setupSessionFileWatcher(): void {
    const sessionsDir = path.join(this._repoRoot, ".kodela", "sessions");
    const glob = new vscode.RelativePattern(sessionsDir, "*.json");

    try {
      this._sessionFileWatcher = vscode.workspace.createFileSystemWatcher(glob);

      const onSessionChanged = (uri: vscode.Uri): void => {
        // Skip summary/timeline sidecar files
        const name = path.basename(uri.fsPath);
        if (name.includes(".summary.") || name.includes(".timeline.") || name.includes(".turns.")) return;

        // Debounce to let the watcher finish writing
        const key = `session:${name}`;
        const existing = this._debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
          this._debounceTimers.delete(key);
          void this._tryEnrichSession(name.replace(".json", ""));
        }, SESSION_ENRICH_DEBOUNCE_MS);
        this._debounceTimers.set(key, timer);
      };

      this._sessionFileWatcher.onDidCreate(onSessionChanged);
      this._sessionFileWatcher.onDidChange(onSessionChanged);
      this._log("Session file watcher registered for auto-enrichment.");
    } catch (err) {
      this._log(`Session file watcher failed — ${err instanceof Error ? err.message : String(err)}`);
    }

    // Also run a periodic scan to catch sessions we may have missed
    this._sessionScanTimer = setInterval(() => {
      void this._scanAndEnrichSessions();
    }, SESSION_SCAN_INTERVAL_MS);
    // unref so the interval doesn't prevent Node from exiting in tests
    if (typeof this._sessionScanTimer === "object" && "unref" in this._sessionScanTimer) {
      this._sessionScanTimer.unref();
    }

    // Do an initial scan after a short delay
    const initTimer = setTimeout(() => void this._scanAndEnrichSessions(), 5_000);
    if (typeof initTimer === "object" && "unref" in initTimer) {
      initTimer.unref();
    }
  }

  /**
   * Check if a specific session needs enrichment and inject native capture data.
   * Only enriches sessions that:
   *   - Have no userPrompt (gap 121)
   *   - Have no annotation.reasoning (gap 122)
   *   - Haven't been enriched by this service already
   */
  private async _tryEnrichSession(sessionId: string): Promise<void> {
    if (this._enrichedSessionIds.has(sessionId)) return;

    const session = await readSession(this._repoRoot, sessionId).catch(() => null);
    if (!session) return;

    // Skip if Path 1 (Chat Participant) already captured this session
    const sources = session.captureSources ?? [];
    if (sources.includes("vscode-chat-participant")) {
      this._enrichedSessionIds.add(sessionId);
      return;
    }

    // Skip if already enriched by a native capture strategy
    if (sources.includes(SOURCE_CHATSESSIONS) || sources.includes(SOURCE_SQLITE)) {
      this._enrichedSessionIds.add(sessionId);
      return;
    }

    // Check if session is missing chat context (the gaps we want to close)
    const hasPrompt = !!(session.intent?.userPrompt?.trim());
    const hasReasoning = !!(session.annotation?.reasoning?.trim());
    if (hasPrompt && hasReasoning) {
      this._enrichedSessionIds.add(sessionId);
      return;
    }

    // Capture code changes for this session's time window from Local History
    let codeChangesMerged = false;
    if (this._localHistory && !(session.codeChanges ?? []).length) {
      const sessionStartMs = session.startedAt
        ? new Date(session.startedAt).getTime()
        : Date.now() - 3_600_000;
      this._localHistory.setSessionStartTime(sessionStartMs);
      const codeChanges = await this._localHistory.captureSessionChanges().catch(() => []);
      if (codeChanges.length > 0) {
        const updated = await readSession(this._repoRoot, sessionId).catch(() => null);
        if (updated) {
          await writeSession(this._repoRoot, {
            ...updated,
            codeChanges,
            captureSources: [...new Set([...(updated.captureSources ?? []), "local-history"])],
          }).catch(() => undefined);
          codeChangesMerged = true;
          this._log(`Session ${sessionId}: added ${codeChanges.length} local-history code change(s).`);
        }
      }
    }

    // Try to merge native capture data (chat turns / prompts)
    this._log(`Auto-enriching watcher session: ${sessionId}`);
    const merged = await this.mergeIntoSession(sessionId);
    if (merged || codeChangesMerged) {
      this._log(`Session ${sessionId} enriched with native Copilot data.`);
      // Only permanently mark as done when we successfully wrote data
      this._enrichedSessionIds.add(sessionId);
    } else {
      this._log(`Session ${sessionId}: no native Copilot data available yet — will retry.`);
      // Do NOT add to _enrichedSessionIds so we retry when new turns arrive
    }
  }

  /**
   * Scan all open sessions and enrich any that lack chat context.
   * Runs periodically to catch sessions created between watcher events.
   */
  private async _scanAndEnrichSessions(): Promise<void> {
    if (this._disposed) return;

    let sessions;
    try {
      sessions = await listSessions(this._repoRoot);
    } catch {
      return;
    }

    // Only look at recent open sessions (no endedAt) or recently closed ones
    const now = Date.now();
    const recentWindow = 5 * 60_000; // 5 minutes

    for (const session of sessions) {
      if (this._enrichedSessionIds.has(session.id)) continue;

      // Enrich open sessions, or sessions closed within the last 5 minutes
      const isOpen = !session.endedAt;
      const closedRecently =
        session.endedAt &&
        now - new Date(session.endedAt).getTime() < recentWindow;

      if (isOpen || closedRecently) {
        await this._tryEnrichSession(session.id);
      } else {
        // Mark old sessions as done so we don't re-scan them
        this._enrichedSessionIds.add(session.id);
      }
    }
  }
}
