// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 55 Phase B — SessionManager
 *
 * High-level session lifecycle functions built on top of the Phase A storage
 * primitives (writeSession, readSession, appendEntryToSession, closeSession,
 * listSessions). Provides:
 *
 *   startSession     — create a new KodelaSession
 *   linkEntryToSession — append an entry + file to an open session
 *   computeAggregatedRisk — derive session-level risk from linked entries
 *   closeSession     — stamp endedAt + computed aggregatedRisk
 *   getSessionEntries — read a session + lazily close stale open sessions
 */

import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  writeSession,
  readSession,
  appendEntryToSession,
  closeSession as storageCloseSession,
  readContextEntry,
} from "../storage/index.js";
import { classifyScope, SENSITIVE_SCOPES } from "../scope/classifier.js";
import { inferProviderFromModel } from "../reasoning/index.js";
import type { KodelaSession, AggregatedRisk, ContextEntry } from "../schema/index.js";
import { synthesiseSessionIntent } from "./synthesizer.js";
import type { ClusterSummary } from "./synthesizer.js";

const SESSIONS_DIR = ".kodela/sessions";

// ---------------------------------------------------------------------------
// Gap 125+ — Continuous request/response turn storage
// ---------------------------------------------------------------------------

export type SessionTurnRole = "user" | "assistant";

/**
 * A normalized conversational turn persisted in `.turns.jsonl`.
 *
 * Backward compatibility: older assistant-only lines missing `id`/`seq` are
 * normalized during reads with generated values.
 */
export type SessionTurn = {
  id: string;
  sessionId: string;
  role: SessionTurnRole;
  text: string;
  ts: string;
  /** 1-based order in the session conversation stream. */
  seq: number;
  /** Capture source, e.g. vscode-chat-participant, claude-hook. */
  source?: string;
  /** For assistant turns, references the triggering user turn id when known. */
  promptId?: string;
  /** AI extended-thinking text that preceded this response (kind='thinking' chunks). */
  reasoning?: string;
};

export type AssistantTurn = SessionTurn & { role: "assistant" };
export type UserTurn = SessionTurn & { role: "user" };

export type SessionTurnInput = {
  role: SessionTurnRole;
  text: string;
  source?: string;
  promptId?: string;
  ts?: string;
  /** AI extended-thinking text captured alongside this assistant response. */
  reasoning?: string;
};

function isUserTurn(turn: SessionTurn | null): turn is UserTurn {
  return Boolean(turn && turn.role === "user");
}

function isAssistantTurn(turn: SessionTurn | null): turn is AssistantTurn {
  return Boolean(turn && turn.role === "assistant");
}

const MIN_TURN_TEXT_LENGTH = 20;

export type SessionTimelineEvent = {
  id: string;
  sessionId: string;
  ts: string;
  type: string;
  source?: string;
  message?: string;
  data?: Record<string, unknown>;
};

export type SessionTimelineEventInput = {
  type: string;
  source?: string;
  message?: string;
  data?: Record<string, unknown>;
  ts?: string;
};

function turnsFilePath(repoRoot: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9-_]/g, "");
  return path.join(repoRoot, SESSIONS_DIR, `${safeId}.turns.jsonl`);
}

function timelineFilePath(repoRoot: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9-_]/g, "");
  return path.join(repoRoot, SESSIONS_DIR, `${safeId}.timeline.jsonl`);
}

function summaryFilePath(repoRoot: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9-_]/g, "");
  return path.join(repoRoot, SESSIONS_DIR, `${safeId}.summary.json`);
}

function normalizeStoredTurn(
  rawTurn: unknown,
  sessionId: string,
  fallbackSeq: number,
): SessionTurn | null {
  if (!rawTurn || typeof rawTurn !== "object") return null;

  const parsed = rawTurn as Partial<SessionTurn> & {
    role?: unknown;
    text?: unknown;
    ts?: unknown;
    seq?: unknown;
    source?: unknown;
    promptId?: unknown;
    id?: unknown;
    sessionId?: unknown;
  };

  if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
    return null;
  }

  const role: SessionTurnRole = parsed.role === "user" ? "user" : "assistant";
  const ts =
    typeof parsed.ts === "string" && parsed.ts.trim().length > 0
      ? parsed.ts
      : new Date().toISOString();

  const seq =
    typeof parsed.seq === "number" && Number.isInteger(parsed.seq) && parsed.seq > 0
      ? parsed.seq
      : fallbackSeq;

  const id =
    typeof parsed.id === "string" && parsed.id.trim().length > 0
      ? parsed.id
      : randomUUID();

  return {
    id,
    sessionId:
      typeof parsed.sessionId === "string" && parsed.sessionId.trim().length > 0
        ? parsed.sessionId
        : sessionId,
    role,
    text: parsed.text.trim(),
    ts,
    seq,
    ...(typeof parsed.source === "string" && parsed.source.trim().length > 0
      ? { source: parsed.source }
      : {}),
    ...(typeof parsed.promptId === "string" && parsed.promptId.trim().length > 0
      ? { promptId: parsed.promptId }
      : {}),
    ...(typeof parsed.reasoning === "string" && parsed.reasoning.trim().length > 0
      ? { reasoning: parsed.reasoning }
      : {}),
  };
}

function toSummaryRiskLevel(risk: AggregatedRisk): "low" | "medium" | "high" {
  if (risk === "critical" || risk === "high") return "high";
  if (risk === "medium") return "medium";
  return "low";
}

async function appendTimelineSafely(
  repoRoot: string,
  sessionId: string,
  event: SessionTimelineEventInput,
): Promise<void> {
  await appendSessionTimelineEvent(repoRoot, sessionId, event).catch(() => undefined);
}

/**
 * Append a session timeline event to `.kodela/sessions/<sid>.timeline.jsonl`.
 *
 * Timeline files are append-only and durable across VS Code restarts, providing
 * a chronological event history for session continuity and handoff quality.
 */
export async function appendSessionTimelineEvent(
  repoRoot: string,
  sessionId: string,
  event: SessionTimelineEventInput,
): Promise<void> {
  const type = event.type.trim();
  if (!type) return;

  const timelineEvent: SessionTimelineEvent = {
    id: randomUUID(),
    sessionId,
    ts: event.ts ?? new Date().toISOString(),
    type,
    ...(event.source ? { source: event.source } : {}),
    ...(event.message ? { message: event.message } : {}),
    ...(event.data && Object.keys(event.data).length > 0 ? { data: event.data } : {}),
  };

  const filePath = timelineFilePath(repoRoot, sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(timelineEvent) + "\n", "utf-8");
}

/**
 * Read all timeline events for a session from `.timeline.jsonl`.
 * Returns an empty array when no timeline exists yet.
 */
export async function readSessionTimeline(
  repoRoot: string,
  sessionId: string,
): Promise<SessionTimelineEvent[]> {
  const filePath = timelineFilePath(repoRoot, sessionId);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as Partial<SessionTimelineEvent>;
          if (typeof parsed.type !== "string" || parsed.type.trim().length === 0) {
            return null;
          }

          return {
            id:
              typeof parsed.id === "string" && parsed.id.trim().length > 0
                ? parsed.id
                : randomUUID(),
            sessionId:
              typeof parsed.sessionId === "string" && parsed.sessionId.trim().length > 0
                ? parsed.sessionId
                : sessionId,
            ts:
              typeof parsed.ts === "string" && parsed.ts.trim().length > 0
                ? parsed.ts
                : new Date().toISOString(),
            type: parsed.type.trim(),
            ...(typeof parsed.source === "string" && parsed.source.trim().length > 0
              ? { source: parsed.source }
              : {}),
            ...(typeof parsed.message === "string" && parsed.message.trim().length > 0
              ? { message: parsed.message }
              : {}),
            ...(parsed.data && typeof parsed.data === "object"
              ? { data: parsed.data }
              : {}),
          } satisfies SessionTimelineEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is SessionTimelineEvent => event !== null);
  } catch {
    return [];
  }
}

/**
 * Read all turns from `.kodela/sessions/<sid>.turns.jsonl`.
 * Returns an empty array when the file does not exist.
 */
export async function readSessionTurns(
  repoRoot: string,
  sessionId: string,
): Promise<SessionTurn[]> {
  const filePath = turnsFilePath(repoRoot, sessionId);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const turns = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, idx) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return normalizeStoredTurn(parsed, sessionId, idx + 1);
        } catch {
          return null;
        }
      })
      .filter((turn): turn is SessionTurn => turn !== null);

    return turns
      .sort((a, b) => a.seq - b.seq)
      .map((turn, idx) => ({
        ...turn,
        seq: Number.isInteger(turn.seq) && turn.seq > 0 ? turn.seq : idx + 1,
      }));
  } catch {
    return [];
  }
}

/**
 * Append a normalized conversation turn to `.turns.jsonl`.
 *
 * Silently no-ops when `text` is shorter than MIN_TURN_TEXT_LENGTH to avoid
 * persisting tool-use-only fragments.
 */
export async function appendSessionTurn(
  repoRoot: string,
  sessionId: string,
  input: SessionTurnInput,
): Promise<SessionTurn | null> {
  const trimmed = input.text.trim();
  if (trimmed.length < MIN_TURN_TEXT_LENGTH) return null;

  const existing = await readSessionTurns(repoRoot, sessionId);
  const nextSeq = existing.length > 0
    ? Math.max(...existing.map((turn) => turn.seq)) + 1
    : 1;

  const turn: SessionTurn = {
    id: randomUUID(),
    sessionId,
    role: input.role,
    text: trimmed,
    ts: input.ts ?? new Date().toISOString(),
    seq: nextSeq,
    ...(input.source ? { source: input.source } : {}),
    ...(input.promptId ? { promptId: input.promptId } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
  };

  const filePath = turnsFilePath(repoRoot, sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(turn) + "\n", "utf-8");

  await appendTimelineSafely(repoRoot, sessionId, {
    type: input.role === "user" ? "user-turn-captured" : "assistant-turn-captured",
    source: input.source ?? "session-manager",
    data: {
      turnId: turn.id,
      role: turn.role,
      seq: turn.seq,
      chars: trimmed.length,
      ...(input.promptId ? { promptId: input.promptId } : {}),
    },
  });

  return turn;
}

/** Append a user prompt turn to the durable turns stream. */
export async function appendUserTurn(
  repoRoot: string,
  sessionId: string,
  text: string,
  opts: { source?: string } = {},
): Promise<UserTurn | null> {
  const turn = await appendSessionTurn(repoRoot, sessionId, {
    role: "user",
    text,
    source: opts.source,
  });

  return isUserTurn(turn) ? turn : null;
}

/** Append an assistant response turn to the durable turns stream. */
export async function appendAssistantTurn(
  repoRoot: string,
  sessionId: string,
  text: string,
  opts: { source?: string; promptId?: string; reasoning?: string } = {},
): Promise<AssistantTurn | null> {
  const turn = await appendSessionTurn(repoRoot, sessionId, {
    role: "assistant",
    text,
    source: opts.source,
    promptId: opts.promptId,
    reasoning: opts.reasoning,
  });

  return isAssistantTurn(turn) ? turn : null;
}

/**
 * Read assistant turns from `.turns.jsonl`.
 * Backward compatible with legacy assistant-only turn lines.
 */
export async function readAssistantTurns(
  repoRoot: string,
  sessionId: string,
): Promise<AssistantTurn[]> {
  const turns = await readSessionTurns(repoRoot, sessionId);
  return turns.filter((turn): turn is AssistantTurn => turn.role === "assistant");
}

const RISK_ORDER: AggregatedRisk[] = ["low", "medium", "high", "critical"];

const SESSION_STALENESS_MS = 60 * 60 * 1000; // 1 hour

const MULTI_FILE_THRESHOLD = 5;
const CROSS_SCOPE_THRESHOLD = 2;

export type StartSessionOptions = {
  model?: string;
  goal?: string;
};

function severityToRisk(severity: string): AggregatedRisk {
  switch (severity) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    default:
      return "low";
  }
}

function riskIndex(risk: AggregatedRisk): number {
  return RISK_ORDER.indexOf(risk);
}

function maxRisk(a: AggregatedRisk, b: AggregatedRisk): AggregatedRisk {
  return riskIndex(a) >= riskIndex(b) ? a : b;
}

function bumpRisk(risk: AggregatedRisk): AggregatedRisk {
  const idx = riskIndex(risk);
  return RISK_ORDER[Math.min(idx + 1, RISK_ORDER.length - 1)];
}

function sentence(text: string | undefined | null): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function toTimestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

function clampConfidence(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function dominantClusterId(entries: ContextEntry[]): string | undefined {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const cid = entry.clusterId?.trim();
    if (!cid) continue;
    counts.set(cid, (counts.get(cid) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function buildSessionHandoffSummary(
  session: KodelaSession,
  summary: ClusterSummary | null,
  files: string[],
  totalAdded: number,
  totalRemoved: number,
): string {
  const baseIntent =
    summary?.intent?.trim() ||
    session.intent?.synthesised?.trim() ||
    session.intent?.userPrompt?.trim() ||
    (files.length > 0
      ? `Updated ${files.slice(0, 2).map((fp) => fp.split("/").slice(-2).join("/")).join(", ")}${files.length > 2 ? ` and ${files.length - 2} more file${files.length - 2 === 1 ? "" : "s"}` : ""}`
      : "Session changes captured");

  const why =
    summary?.memory?.whyItMatters?.trim() ||
    session.intent?.aiReasoning?.trim() ||
    summary?.reasoning?.trim() ||
    "";

  const riskLabel = session.aggregatedRisk;
  const scope =
    files.length > 0
      ? `${files.length} file${files.length === 1 ? "" : "s"} (+${totalAdded}/-${totalRemoved} lines)`
      : "no tracked file changes";

  const handoff = [
    sentence(baseIntent),
    why ? sentence(why) : "",
    `${riskLabel[0]?.toUpperCase() ?? "L"}${riskLabel.slice(1)} risk — ${scope}.`,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);

  return handoff;
}

function applySessionSnapshot(
  session: KodelaSession,
  entries: ContextEntry[],
  summary: ClusterSummary | null,
): KodelaSession {
  const files = session.filesChanged.length > 0
    ? [...session.filesChanged]
    : [...new Set(entries.map((e) => e.filePath))];

  const totalAdded = entries.reduce((sum, entry) => sum + (entry.rawContext?.linesAdded ?? 0), 0);
  const totalRemoved = entries.reduce((sum, entry) => sum + (entry.rawContext?.linesRemoved ?? 0), 0);

  const startedAtMs = toTimestampMs(session.startedAt);
  const endedAtMs =
    toTimestampMs(session.endedAt) ??
    (entries.length > 0
      ? Math.max(...entries.map((entry) => toTimestampMs(entry.createdAt) ?? 0))
      : startedAtMs);
  const duration =
    typeof startedAtMs === "number" && typeof endedAtMs === "number" && endedAtMs >= startedAtMs
      ? Math.round(endedAtMs - startedAtMs)
      : session.duration;

  const avgEntryConfidence =
    entries.length > 0
      ? entries.reduce((sum, entry) => sum + entry.confidence, 0) / entries.length
      : undefined;
  const dominantCluster = dominantClusterId(entries);

  const actor = {
    tool:
      session.actor?.tool ??
      entries.find((entry) => entry.aiTool && entry.aiTool !== "unknown")?.aiTool ??
      "unknown",
    model: session.actor?.model ?? session.model,
    author:
      session.actor?.author ??
      entries.find((entry) => entry.author && entry.author !== "unknown")?.author ??
      session.git?.end?.author ??
      session.git?.start?.author,
  };

  const intentConfidence =
    clampConfidence(summary?.avgConfidence) ??
    clampConfidence(session.intent?.confidence) ??
    clampConfidence(avgEntryConfidence);

  return {
    ...session,
    actor,
    intent: {
      ...(session.intent ?? {}),
      ...(session.goal?.trim() ? { userPrompt: session.intent?.userPrompt ?? session.goal.trim() } : {}),
      ...(summary?.intent?.trim() ? { synthesised: summary.intent.trim() } : {}),
      ...(summary?.reasoning?.trim()
        ? { aiReasoning: summary.reasoning.trim() }
        : {}),
      ...(session.git?.end?.branch || session.git?.start?.branch
        ? { branchContext: session.intent?.branchContext ?? session.git?.end?.branch ?? session.git?.start?.branch }
        : {}),
      ...(summary?.intentSource
        ? { source: session.intent?.source ?? `summary-${summary.intentSource}` }
        : {}),
      ...(typeof intentConfidence === "number" ? { confidence: intentConfidence } : {}),
      updatedAt: new Date().toISOString(),
    },
    changes: {
      files,
      added: Math.max(0, totalAdded),
      removed: Math.max(0, totalRemoved),
    },
    risk: session.aggregatedRisk,
    ...(typeof duration === "number" ? { duration } : {}),
    ...(dominantCluster ? { clusterId: dominantCluster } : {}),
    handoffSummary: buildSessionHandoffSummary(session, summary, files, totalAdded, totalRemoved),
  };
}

/**
 * Create a new KodelaSession and persist it to `.kodela/sessions/<id>.json`.
 * If a session with the same ID already exists it is overwritten (idempotent
 * for repeated SessionStart hooks).
 */
export async function startSession(
  repoRoot: string,
  sessionId: string,
  opts: StartSessionOptions = {},
): Promise<KodelaSession> {
  const existing = await readSession(repoRoot, sessionId);
  if (existing && !existing.endedAt) {
    return existing;
  }
  const now = new Date().toISOString();
  const providerHint = inferProviderFromModel(opts.model);
  const session: KodelaSession = {
    id: sessionId,
    startedAt: now,
    model: opts.model,
    providerHint,
    goal: opts.goal,
    entries: [],
    aggregatedRisk: "low",
    filesChanged: [],
  };
  await writeSession(repoRoot, session);
  await appendTimelineSafely(repoRoot, sessionId, {
    type: "session-started",
    source: "session-manager",
    data: {
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.goal ? { goalPreview: opts.goal.slice(0, 500) } : {}),
    },
  });
  return session;
}

/**
 * Append a ContextEntry UUID and its file path to an open session.
 * Delegates to the Phase A `appendEntryToSession` storage function which
 * handles deduplication and creates the session if it is missing.
 */
export async function linkEntryToSession(
  repoRoot: string,
  sessionId: string,
  entryId: string,
  filePath: string,
): Promise<void> {
  await appendEntryToSession(repoRoot, sessionId, entryId, filePath);
  await appendTimelineSafely(repoRoot, sessionId, {
    type: "entry-linked",
    source: "session-manager",
    data: { entryId, filePath },
  });
}

/**
 * Compute the aggregated risk for a session from its linked entries.
 *
 * Algorithm:
 *   1. Load all linked ContextEntries; take the maximum severity.
 *   2. +1 risk level if `filesChanged.length > 5` (multi-file penalty).
 *   3. +1 risk level if `filesChanged` spans 2+ distinct SENSITIVE_SCOPES
 *      (cross-scope penalty: auth + payments, db + infra, …).
 *
 * Pure I/O function — does not write anything.
 */
export async function computeAggregatedRisk(
  repoRoot: string,
  sessionId: string,
): Promise<AggregatedRisk> {
  const session = await readSession(repoRoot, sessionId);
  if (!session || session.entries.length === 0) return "low";

  const entries: ContextEntry[] = [];
  for (const id of session.entries) {
    try {
      const entry = await readContextEntry(repoRoot, id);
      entries.push(entry);
    } catch {
      // skip entries that cannot be loaded
    }
  }

  let risk: AggregatedRisk = "low";
  for (const entry of entries) {
    risk = maxRisk(risk, severityToRisk(entry.severity));
  }

  if (session.filesChanged.length > MULTI_FILE_THRESHOLD) {
    risk = bumpRisk(risk);
  }

  const sensitiveScopes = new Set<string>();
  for (const fp of session.filesChanged) {
    const scope = classifyScope(fp);
    if (SENSITIVE_SCOPES.has(scope)) {
      sensitiveScopes.add(scope);
    }
  }
  if (sensitiveScopes.size >= CROSS_SCOPE_THRESHOLD) {
    risk = bumpRisk(risk);
  }

  return risk;
}

export type CloseSessionOptions = {
  goal?: string;
};

export type SessionIntentPatch = Partial<NonNullable<KodelaSession["intent"]>>;
export type SessionActorPatch = Partial<NonNullable<KodelaSession["actor"]>>;
export type SessionAnnotationPatch = Partial<NonNullable<KodelaSession["annotation"]>>;
export type SessionGitSnapshot = NonNullable<NonNullable<KodelaSession["git"]>["start"]>;

/**
 * Gap 121 — Update the goal (user's original prompt) on an open session.
 *
 * Only sets the goal when:
 *   - The session exists and is still open (no endedAt).
 *   - No goal has been recorded yet (first prompt wins — never overwritten).
 *
 * Returns the updated session, or null if the session does not exist.
 */
export async function updateSessionGoal(
  repoRoot: string,
  sessionId: string,
  goal: string,
): Promise<KodelaSession | null> {
  const session = await readSession(repoRoot, sessionId);
  if (!session) return null;

  // First prompt wins — never overwrite an existing goal
  if (session.goal && session.goal.trim().length > 0) return session;

  // Don't update closed sessions
  if (session.endedAt) return session;

  const trimmed = goal.trim();
  if (!trimmed) return session;

  const updated: KodelaSession = {
    ...session,
    goal: trimmed,
  };
  await writeSession(repoRoot, updated);
  await appendTimelineSafely(repoRoot, sessionId, {
    type: "goal-updated",
    source: "session-manager",
    data: {
      goalPreview: trimmed.slice(0, 500),
      chars: trimmed.length,
    },
  });
  return updated;
}

/**
 * Merge a patch into `session.intent` and persist.
 *
 * Returns null when the session does not exist.
 */
export async function updateSessionIntent(
  repoRoot: string,
  sessionId: string,
  patch: SessionIntentPatch,
): Promise<KodelaSession | null> {
  const session = await readSession(repoRoot, sessionId);
  if (!session) return null;

  const updated: KodelaSession = {
    ...session,
    intent: {
      ...(session.intent ?? {}),
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    },
  };

  await writeSession(repoRoot, updated);
  await appendTimelineSafely(repoRoot, sessionId, {
    type: "intent-updated",
    source: "session-manager",
    data: {
      fields: Object.keys(patch),
      ...(patch.source ? { source: patch.source } : {}),
      ...(typeof patch.confidence === "number" ? { confidence: patch.confidence } : {}),
      ...(patch.userPrompt
        ? { userPromptPreview: patch.userPrompt.slice(0, 500) }
        : {}),
      ...(patch.synthesised
        ? { synthesisedPreview: patch.synthesised.slice(0, 500) }
        : {}),
      ...(patch.aiReasoning
        ? { aiReasoningPreview: patch.aiReasoning.slice(0, 500) }
        : {}),
    },
  });
  return updated;
}

/**
 * Merge a patch into `session.actor` and persist.
 *
 * Returns null when the session does not exist.
 */
export async function updateSessionActor(
  repoRoot: string,
  sessionId: string,
  patch: SessionActorPatch,
): Promise<KodelaSession | null> {
  const session = await readSession(repoRoot, sessionId);
  if (!session) return null;

  const mergedActor = {
    ...(session.actor ?? {}),
    ...patch,
  };

  if (!mergedActor.tool) {
    return session;
  }

  const actor: NonNullable<KodelaSession["actor"]> = {
    tool: mergedActor.tool,
    ...(mergedActor.model ? { model: mergedActor.model } : {}),
    ...(mergedActor.author ? { author: mergedActor.author } : {}),
  };

  const updated: KodelaSession = {
    ...session,
    actor,
  };

  await writeSession(repoRoot, updated);
  await appendTimelineSafely(repoRoot, sessionId, {
    type: "actor-updated",
    source: "session-manager",
    data: {
      tool: actor.tool,
      ...(actor.model ? { model: actor.model } : {}),
      ...(actor.author ? { author: actor.author } : {}),
    },
  });
  return updated;
}

/**
 * Merge a patch into `session.annotation` and persist.
 *
 * Returns null when the session does not exist.
 */
export async function updateSessionAnnotation(
  repoRoot: string,
  sessionId: string,
  patch: SessionAnnotationPatch,
): Promise<KodelaSession | null> {
  const session = await readSession(repoRoot, sessionId);
  if (!session) return null;

  const updated: KodelaSession = {
    ...session,
    annotation: {
      ...(session.annotation ?? {}),
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    },
  };

  await writeSession(repoRoot, updated);
  await appendTimelineSafely(repoRoot, sessionId, {
    type: "annotation-updated",
    source: "session-manager",
    data: {
      fields: Object.keys(patch),
      ...(patch.source ? { source: patch.source } : {}),
      ...(patch.reasoning
        ? {
            reasoningPreview: patch.reasoning.slice(0, 500),
            chars: patch.reasoning.length,
          }
        : {}),
    },
  });
  return updated;
}

/**
 * Write a git snapshot into `session.git.start` or `session.git.end`.
 *
 * Returns null when the session does not exist.
 */
export async function updateSessionGitSnapshot(
  repoRoot: string,
  sessionId: string,
  phase: "start" | "end",
  snapshot: SessionGitSnapshot,
): Promise<KodelaSession | null> {
  const session = await readSession(repoRoot, sessionId);
  if (!session) return null;

  const endFiles =
    phase === "end"
      ? (snapshot.filesChanged ?? []).filter(
          (filePath): filePath is string => typeof filePath === "string" && filePath.length > 0,
        )
      : [];
  const mergedFilesChanged =
    endFiles.length > 0
      ? [...new Set([...session.filesChanged, ...endFiles])]
      : session.filesChanged;

  const updated: KodelaSession = {
    ...session,
    filesChanged: mergedFilesChanged,
    git: {
      ...(session.git ?? {}),
      [phase]: snapshot,
    },
  };

  await writeSession(repoRoot, updated);
  await appendTimelineSafely(repoRoot, sessionId, {
    type: "git-snapshot-captured",
    source: "session-manager",
    data: {
      phase,
      ...(snapshot.branch ? { branch: snapshot.branch } : {}),
      ...(snapshot.headCommit ? { headCommit: snapshot.headCommit } : {}),
      ...(snapshot.filesChanged ? { filesChanged: snapshot.filesChanged } : {}),
      ...(snapshot.diffStats ? { diffStats: snapshot.diffStats } : {}),
    },
  });
  return updated;
}

/**
 * Close an open session: compute aggregatedRisk, stamp endedAt, persist.
 * Returns the closed session, or null if the session does not exist.
 */
export async function closeSession(
  repoRoot: string,
  sessionId: string,
  opts: CloseSessionOptions = {},
): Promise<KodelaSession | null> {
  const aggregatedRisk = await computeAggregatedRisk(repoRoot, sessionId);
  let closed = await storageCloseSession(repoRoot, sessionId, {
    aggregatedRisk,
    goal: opts.goal,
  });

  if (closed) {
    const startedAtMs = toTimestampMs(closed.startedAt);
    const endedAtMs = toTimestampMs(closed.endedAt);
    const duration =
      typeof startedAtMs === "number" && typeof endedAtMs === "number" && endedAtMs >= startedAtMs
        ? Math.round(endedAtMs - startedAtMs)
        : closed.duration;

    const enrichedClosed: KodelaSession = {
      ...closed,
      risk: closed.aggregatedRisk,
      ...(typeof duration === "number" ? { duration } : {}),
    };
    closed = enrichedClosed;
    await writeSession(repoRoot, enrichedClosed);

    await appendTimelineSafely(repoRoot, sessionId, {
      type: "session-closed",
      source: "session-manager",
      data: {
        aggregatedRisk: closed.aggregatedRisk,
        ...(closed.endedAt ? { endedAt: closed.endedAt } : {}),
      },
    });
  }

  return closed;
}

export type SessionWithEntries = {
  session: KodelaSession;
  entries: ContextEntry[];
};

/**
 * Read a session and load all its linked ContextEntries.
 *
 * Lazy close: if the session has no `endedAt` and its `startedAt` is older
 * than SESSION_STALENESS_MS (1 hour), `closeSession()` is called before
 * returning so abandoned sessions are always eventually stamped.
 *
 * Returns null if the session does not exist.
 */
export async function getSessionEntries(
  repoRoot: string,
  sessionId: string,
): Promise<SessionWithEntries | null> {
  let session = await readSession(repoRoot, sessionId);
  if (!session) return null;

  if (!session.endedAt) {
    const age = Date.now() - new Date(session.startedAt).getTime();
    if (age > SESSION_STALENESS_MS) {
      const closed = await closeSession(repoRoot, sessionId);
      if (closed) session = closed;
    }
  }

  const entries: ContextEntry[] = [];
  for (const id of session.entries) {
    try {
      const entry = await readContextEntry(repoRoot, id);
      entries.push(entry);
    } catch {
      // skip entries that cannot be loaded (deleted or corrupt)
    }
  }

  return { session, entries };
}

/**
 * Synthesize and persist a session summary sidecar at
 * `.kodela/sessions/<sid>.summary.json`.
 *
 * This is shared by CLI hook flow and VS Code capture flow to keep session
 * summary artifact behavior consistent across capture paths.
 */
export async function synthesiseAndWriteSessionSummary(
  repoRoot: string,
  sessionId: string,
): Promise<ClusterSummary | null> {
  const sessionWithEntries = await getSessionEntries(repoRoot, sessionId);
  if (!sessionWithEntries) return null;

  const { session, entries } = sessionWithEntries;
  const turns = await readAssistantTurns(repoRoot, sessionId);
  const assistantTurnTexts = turns.map((t) => t.text);

  const summary = synthesiseSessionIntent(
    sessionId,
    entries,
    session.goal ?? undefined,
    undefined,
    toSummaryRiskLevel(session.aggregatedRisk),
    assistantTurnTexts,
  );

  const filePath = summaryFilePath(repoRoot, sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(summary, null, 2), "utf-8");

  const sessionSnapshot = applySessionSnapshot(session, entries, summary);
  await writeSession(repoRoot, sessionSnapshot);

  await appendTimelineSafely(repoRoot, sessionId, {
    type: "session-summary-written",
    source: "session-manager",
    data: {
      intentSource: summary.intentSource,
      entryCount: summary.entryCount,
      assistantTurnCount: summary.assistantTurnCount ?? 0,
    },
  });

  return summary;
}

/**
 * Append a capture-source tag to `session.captureSources[]` with dedup.
 *
 * Returns the updated session, or null when the session does not exist.
 */
export async function appendSessionCaptureSource(
  repoRoot: string,
  sessionId: string,
  source: string,
): Promise<KodelaSession | null> {
  const session = await readSession(repoRoot, sessionId);
  if (!session) return null;

  const existing = session.captureSources ?? [];
  if (existing.includes(source)) return session;

  const updated: KodelaSession = {
    ...session,
    captureSources: [...existing, source],
  };

  await writeSession(repoRoot, updated);
  await appendTimelineSafely(repoRoot, sessionId, {
    type: "capture-source-added",
    source: "session-manager",
    data: { captureSource: source },
  });
  return updated;
}

/**
 * Write Copilot memory snapshot into `session.copilotMemory`.
 *
 * Returns the updated session, or null when the session does not exist.
 */
export async function updateSessionCopilotMemory(
  repoRoot: string,
  sessionId: string,
  phase: "start" | "end",
  snapshot: string[],
  source: string,
): Promise<KodelaSession | null> {
  const session = await readSession(repoRoot, sessionId);
  if (!session) return null;

  const key = phase === "start" ? "startSnapshot" : "endSnapshot";
  const updated: KodelaSession = {
    ...session,
    copilotMemory: {
      ...(session.copilotMemory ?? {}),
      [key]: snapshot,
      source,
    },
  };

  await writeSession(repoRoot, updated);
  await appendTimelineSafely(repoRoot, sessionId, {
    type: "copilot-memory-captured",
    source: "session-manager",
    data: { phase, fileCount: snapshot.length, source },
  });
  return updated;
}
