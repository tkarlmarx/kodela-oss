// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 123 — kodela handoff
 *
 * Exports a structured, AI-transferable context handoff for a session.
 * The handoff contains what was built, why, who, key files, and what
 * remains uncertain — formatted for direct paste into any AI agent.
 *
 * Usage:
 *   kodela handoff --session <id>            → JSON envelope (full KodelaHandoff)
 *   kodela handoff --session <id> --markdown → markdown summary only (for pbcopy/pipe)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { KODELA_DIR, readContextEntry, buildHandoff } from "@kodela/core";
import type { HandoffEntry, HandoffSessionMeta } from "@kodela/core";
import {
  readSessionTimeline,
  readSessionTurns,
  synthesiseAndWriteSessionSummary,
  synthesiseSessionIntent,
} from "@kodela/core/sessions";
import type {
  ClusterSummary,
  SessionTimelineEvent,
  SessionTurn,
} from "@kodela/core/sessions";

export type HandoffOptions = {
  repoRoot: string;
  sessionId?: string;
  markdownOnly?: boolean;
};

type RawSessionFile = {
  id?: string;
  goal?: string;
  startedAt: string;
  endedAt?: string;
  model?: string;
  aggregatedRisk?: string;
  handoffSummary?: string;
  actor?: {
    tool?: string;
    model?: string;
    author?: string;
  };
  intent?: {
    userPrompt?: string;
    synthesised?: string;
    aiReasoning?: string;
    branchContext?: string;
    commitMessage?: string;
    source?: string;
    confidence?: number;
  };
  git?: {
    end?: {
      filesChanged?: string[];
    };
  };
};

const GENERIC_INTENTS = new Set([
  "ai-generated change",
  "ai generated change",
  "no goal captured",
  "unknown",
  "auto-annotated",
  "",
]);

const INTENT_VERB_PATTERN =
  /\b(add|added|build|built|capture|captured|centrali[sz]e(?:d)?|create|created|ensure|ensured|fix|fixed|improve|improved|implement|implemented|prefer|preferred|refactor|refactored|reuse|reused|stabili[sz]e(?:d)?|support|supported|synthesi[sz]e(?:d)?|test(?:ed)?|update|updated|write|wrote)\b/i;

const IDENTIFIER_LIST_PATTERN =
  /^[a-zA-Z_$][\w$]*(?:,\s*[a-zA-Z_$][\w$]*){1,}(?:\s*\(\d+[+\-]?\/\d+[+\-]?\))?$/;

function isIdentifierHeavyIntent(intent: string): boolean {
  const trimmed = intent.trim();
  if (trimmed.length === 0) return true;

  const chunks = trimmed
    .split(";")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  if (chunks.length > 0 && chunks.every((chunk) => IDENTIFIER_LIST_PATTERN.test(chunk))) {
    return true;
  }

  if (
    chunks.length > 0 &&
    chunks.every((chunk) => /^[A-Za-z0-9_.@-]+:[A-Za-z0-9_.@\/-]+$/.test(chunk))
  ) {
    return true;
  }

  const words = trimmed.match(/\b[A-Za-z][A-Za-z0-9_-]*\b/g) ?? [];
  if (words.length === 0) return true;

  const camelCaseTokens = trimmed.match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g) ?? [];
  const camelCaseRatio = camelCaseTokens.length / words.length;
  return camelCaseTokens.length >= 2 && camelCaseRatio >= 0.6 && !INTENT_VERB_PATTERN.test(trimmed);
}

function isLowValueIntent(intent: string | null | undefined): boolean {
  if (!intent) return true;
  const normalized = intent.trim().toLowerCase();
  return (
    GENERIC_INTENTS.has(normalized) ||
    isIdentifierHeavyIntent(intent) ||
    normalized.startsWith("modified ") ||
    normalized.startsWith("auto-annotated:") ||
    normalized === "ai session — no file changes recorded"
  );
}

function isLowValueReasoning(reasoning: string | null | undefined): boolean {
  if (!reasoning) return true;
  const trimmed = reasoning.trim();
  return trimmed.length < 12 || isLowValueIntent(trimmed);
}

function summaryQualityScore(summary: ClusterSummary | null | undefined): number {
  if (!summary) return -1;

  const intent = summary.intent?.trim() ?? "";
  const reasoning = summary.reasoning?.trim() ?? "";

  let score = 0;
  if (!isLowValueIntent(intent)) {
    score += 3;
  } else if (intent.length > 0) {
    score += 1;
  }
  if (!isLowValueReasoning(reasoning)) {
    score += 2;
  }
  if (summary.intentSource && summary.intentSource !== "structural-fallback") {
    score += 1;
  }
  if ((summary.memory?.whatChanged?.length ?? 0) > 0) {
    score += 1;
  }
  if ((summary.memory?.validationContext ?? "").trim().length > 0) {
    score += 1;
  }

  return score;
}

function pickBetterSummary(
  first: ClusterSummary | null | undefined,
  second: ClusterSummary | null | undefined,
): ClusterSummary | null {
  if (!first && !second) return null;
  if (!first) return second ?? null;
  if (!second) return first;
  return summaryQualityScore(second) >= summaryQualityScore(first)
    ? second
    : first;
}

function normalizeSummaryRiskLevel(raw: string | undefined): "low" | "medium" | "high" {
  if (raw === "high" || raw === "critical") return "high";
  if (raw === "medium") return "medium";
  return "low";
}

type SessionThreadItem = {
  requestText: string;
  requestAt?: string;
  requestSource?: string;
  responseText?: string;
  responseAt?: string;
  responseSource?: string;
};

function buildSessionTurnThread(turns: SessionTurn[]): SessionThreadItem[] {
  const sorted = [...turns].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    const at = new Date(a.ts).getTime();
    const bt = new Date(b.ts).getTime();
    const safeA = Number.isFinite(at) ? at : 0;
    const safeB = Number.isFinite(bt) ? bt : 0;
    return safeA - safeB;
  });

  const thread: SessionThreadItem[] = [];
  const byPromptId = new Map<string, SessionThreadItem>();

  for (const turn of sorted) {
    if (turn.role === "user") {
      const item: SessionThreadItem = {
        requestText: turn.text,
        requestAt: turn.ts,
        ...(turn.source ? { requestSource: turn.source } : {}),
      };
      thread.push(item);
      byPromptId.set(turn.id, item);
      continue;
    }

    const hinted = turn.promptId ? byPromptId.get(turn.promptId) : undefined;
    const fallback = [...thread].reverse().find((item) => !item.responseText);
    const target = hinted ?? fallback;

    if (target) {
      target.responseText = turn.text;
      target.responseAt = turn.ts;
      if (turn.source) target.responseSource = turn.source;
      continue;
    }

    thread.push({
      requestText: "",
      responseText: turn.text,
      responseAt: turn.ts,
      ...(turn.source ? { responseSource: turn.source } : {}),
    });
  }

  return thread;
}

function sortTimeline(events: SessionTimelineEvent[]): SessionTimelineEvent[] {
  return [...events].sort((a, b) => {
    const at = new Date(a.ts).getTime();
    const bt = new Date(b.ts).getTime();
    const safeA = Number.isFinite(at) ? at : 0;
    const safeB = Number.isFinite(bt) ? bt : 0;
    return safeA - safeB;
  });
}

function extractTimelineText(event: SessionTimelineEvent): string {
  if (typeof event.message === "string" && event.message.trim().length > 0) {
    return event.message.trim();
  }

  const data =
    event.data && typeof event.data === "object"
      ? (event.data as Record<string, unknown>)
      : null;

  const candidates = [
    data?.["promptPreview"],
    data?.["userPromptPreview"],
    data?.["reasoningPreview"],
    data?.["responsePreview"],
    data?.["synthesisPreview"],
    data?.["aiReasoningPreview"],
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }

  return "";
}

function buildTimelineFallbackThread(events: SessionTimelineEvent[]): SessionThreadItem[] {
  const sorted = sortTimeline(events);
  const thread: SessionThreadItem[] = [];
  const unresolved: SessionThreadItem[] = [];

  for (const event of sorted) {
    const type = event.type.trim().toLowerCase();
    const text = extractTimelineText(event);
    if (text.length === 0) continue;

    if (type === "chat-request-captured" || type === "user-turn-captured") {
      const item: SessionThreadItem = {
        requestText: text,
        requestAt: event.ts,
        ...(event.source ? { requestSource: event.source } : {}),
        responseText: "",
      };
      thread.push(item);
      unresolved.push(item);
      continue;
    }

    if (type === "chat-response-captured" || type === "assistant-turn-captured") {
      const target = unresolved.find((item) => (item.responseText ?? "").trim().length === 0);
      if (target) {
        target.responseText = text;
        target.responseAt = event.ts;
        if (event.source) target.responseSource = event.source;
        continue;
      }

      thread.push({
        requestText: "",
        responseText: text,
        responseAt: event.ts,
        ...(event.source ? { responseSource: event.source } : {}),
      });
    }
  }

  return thread;
}

/**
 * List all session IDs by reading `.kodela/sessions/` directory.
 * Returns only UUIDs found as `<id>.json` files.
 */
async function listSessionIds(repoRoot: string): Promise<string[]> {
  const sessionsDir = path.join(repoRoot, KODELA_DIR, "sessions");
  try {
    const files = await fs.readdir(sessionsDir);
    return files
      .filter((f) => f.endsWith(".json") && !f.endsWith(".summary.json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/**
 * Load the ClusterSummary for a session if it exists.
 * Written at SessionEnd by Gap 120 — falls back gracefully if not present.
 */
async function loadClusterSummary(
  repoRoot: string,
  sessionId: string,
): Promise<ClusterSummary | null> {
  const summaryPath = path.join(
    repoRoot,
    KODELA_DIR,
    "sessions",
    `${sessionId}.summary.json`,
  );
  try {
    const raw = await fs.readFile(summaryPath, "utf-8");
    return JSON.parse(raw) as ClusterSummary;
  } catch {
    return null;
  }
}

/**
 * Load a raw KodelaSession file.
 */
async function loadKodelaSession(
  repoRoot: string,
  sessionId: string,
): Promise<RawSessionFile | null> {
  const sessionPath = path.join(
    repoRoot,
    KODELA_DIR,
    "sessions",
    `${sessionId}.json`,
  );
  try {
    const raw = await fs.readFile(sessionPath, "utf-8");
    return JSON.parse(raw) as RawSessionFile;
  } catch {
    return null;
  }
}

/**
 * Load all context entries for a given session from `.kodela/objects/`.
 * Reads the index.json to get all entry IDs, then filters by sessionId.
 */
async function loadSessionEntries(
  repoRoot: string,
  sessionId: string,
): Promise<HandoffEntry[]> {
  const indexPath = path.join(repoRoot, KODELA_DIR, "index.json");
  let allEntryIds: string[] = [];
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const idx = JSON.parse(raw) as { entries?: string[] };
    allEntryIds = idx.entries ?? [];
  } catch {
    // No index yet; fall through to empty
  }

  const entries: HandoffEntry[] = [];
  for (const entryId of allEntryIds) {
    try {
      const d = await readContextEntry(repoRoot, entryId) as Record<string, unknown>;

      const entrySessionId =
        (d["sessionId"] as string | undefined) ??
        ((d["origin"] as Record<string, unknown> | null | undefined)?.["sessionId"] as string | undefined);

      if (entrySessionId !== sessionId) continue;

      const rawContext = d["rawContext"] as
        | { linesAdded: number; linesRemoved: number; diff?: string }
        | null
        | undefined;

      const reasoning = d["reasoning"] as
        | { intent: string; reasoning: string; confidence: string; extractionMethod: string }
        | null
        | undefined;

      const summary = d["summary"] as
        | { intent: string; changeType: string }
        | null
        | undefined;

      const origin = d["origin"] as
        | { sessionId?: string; tool?: string }
        | null
        | undefined;

      entries.push({
        id:         String(d["id"] ?? entryId),
        filePath:   String(d["filePath"] ?? ""),
        note:       String(d["note"] ?? ""),
        author:     String(d["author"] ?? "unknown"),
        createdAt:  String(d["createdAt"] ?? new Date().toISOString()),
        confidence: typeof d["confidence"] === "number" ? d["confidence"] : 0,
        status:     String(d["status"] ?? "uncertain"),
        source:     String(d["source"] ?? "unknown"),
        aiTool:     String(d["aiTool"] ?? "unknown"),
        rawContext: rawContext ?? null,
        summary:    summary ?? null,
        reasoning:  reasoning ?? null,
        origin:     origin ?? null,
      });
    } catch {
      // Skip corrupt or unreadable entries
    }
  }

  return entries;
}

export async function runHandoff(opts: HandoffOptions): Promise<string> {
  const { repoRoot, sessionId, markdownOnly = false } = opts;

  if (!sessionId) {
    return [
      "kodela handoff — Gap 123: Export an AI-transferable context handoff for a session.",
      "",
      "Usage:",
      "  kodela handoff --session <uuid>             Export full JSON handoff",
      "  kodela handoff --session <uuid> --markdown  Export markdown summary only",
      "",
      "Example:",
      "  kodela handoff --session a8287fdc --markdown | pbcopy",
      "",
      "Tip: Use a short prefix instead of the full UUID.",
    ].join("\n");
  }

  // Resolve session ID (accept prefix)
  let resolvedSessionId = sessionId;
  if (sessionId.length < 36) {
    const allIds = await listSessionIds(repoRoot);
    const match = allIds.find((id) => id.startsWith(sessionId));
    if (match) resolvedSessionId = match;
  }

  // Load session metadata and ClusterSummary in parallel
  const [session, summary, entries] = await Promise.all([
    loadKodelaSession(repoRoot, resolvedSessionId),
    loadClusterSummary(repoRoot, resolvedSessionId),
    loadSessionEntries(repoRoot, resolvedSessionId),
  ]);

  const sessionTurns = await readSessionTurns(repoRoot, resolvedSessionId).catch(
    () => [],
  );
  const sessionTimeline = await readSessionTimeline(repoRoot, resolvedSessionId).catch(
    () => [],
  );
  const threadFromTurns = buildSessionTurnThread(sessionTurns);
  const thread =
    threadFromTurns.length > 0
      ? threadFromTurns
      : buildTimelineFallbackThread(sessionTimeline);

  const gitEndFilesRaw = session?.git?.end?.filesChanged;
  const gitEndFiles = Array.isArray(gitEndFilesRaw)
    ? gitEndFilesRaw.filter(
        (filePath): filePath is string => typeof filePath === "string" && filePath.length > 0,
      )
    : [];

  const watchFallbackEntries: HandoffEntry[] =
    entries.length === 0 && gitEndFiles.length > 0
      ? gitEndFiles.map((filePath, index) => ({
          id: `watch-file-${resolvedSessionId.slice(0, 8)}-${index + 1}`,
          filePath,
          note: `Watch snapshot recorded file activity for ${filePath}`,
          author: session?.actor?.author ?? "unknown",
          createdAt: session?.startedAt ?? new Date().toISOString(),
          confidence: 0,
          status: "uncertain",
          source: "watch",
          aiTool: session?.actor?.tool ?? "unknown",
          rawContext: {
            linesAdded: 0,
            linesRemoved: 0,
          },
          summary: {
            intent: `Captured watch snapshot for ${filePath}`,
            changeType: "modification",
          },
          reasoning: null,
          origin: {
            sessionId: resolvedSessionId,
            tool: session?.actor?.tool,
          },
        }))
      : [];
  const effectiveEntries = watchFallbackEntries.length > 0 ? watchFallbackEntries : entries;

  const fallbackRisk = normalizeSummaryRiskLevel(session?.aggregatedRisk);

  const liveSummary =
    entries.length > 0
      ? synthesiseSessionIntent(
          resolvedSessionId,
          entries as unknown as Parameters<typeof synthesiseSessionIntent>[1],
          session?.goal,
          undefined,
          fallbackRisk,
        )
      : null;

  let effectiveSummary = summary;
  const missingMemoryPayload =
    !!effectiveSummary &&
    (
      (effectiveSummary.memory?.whatChanged?.length ?? 0) === 0 ||
      (effectiveSummary.memory?.validationContext ?? "").trim().length === 0
    );
  const staleOrLowQualitySummary =
    !!effectiveSummary &&
    (
      effectiveSummary.intentSource === "structural-fallback" ||
      isLowValueIntent(effectiveSummary.intent) ||
      isLowValueReasoning(effectiveSummary.reasoning) ||
      missingMemoryPayload
    );

  if (!effectiveSummary || staleOrLowQualitySummary) {
    // Refresh sidecar when missing or when it still contains a low-quality
    // structural fallback from older synthesis logic.
    const refreshed = await synthesiseAndWriteSessionSummary(
      repoRoot,
      resolvedSessionId,
    ).catch(() => null);
    effectiveSummary = refreshed ?? effectiveSummary;
  }

  effectiveSummary = pickBetterSummary(effectiveSummary, liveSummary);

  // Project name from repo root
  const projectName = path.basename(repoRoot);

  // Intent source
  const intentSource =
    effectiveSummary?.intentSource ??
    session?.intent?.source ??
    "structural-fallback";
  const watchFallbackIntent =
    entries.length === 0 && gitEndFiles.length > 0
      ? `Captured file activity in ${gitEndFiles.length} file${gitEndFiles.length === 1 ? "" : "s"} during this watch session.`
      : "";
  const intent =
    (!isLowValueIntent(effectiveSummary?.intent)
      ? effectiveSummary?.intent
      : !isLowValueIntent(session?.intent?.synthesised)
        ? session?.intent?.synthesised
        : !isLowValueIntent(session?.handoffSummary)
          ? session?.handoffSummary
          : effectiveSummary?.intent ?? session?.intent?.synthesised ?? watchFallbackIntent) ??
    "Intent not synthesised — run `kodela enrich` or wait for the next SessionEnd hook";
  const reasoning =
    (!isLowValueReasoning(effectiveSummary?.reasoning)
      ? effectiveSummary?.reasoning
      : !isLowValueReasoning(session?.intent?.aiReasoning)
        ? session?.intent?.aiReasoning
        : effectiveSummary?.reasoning ?? session?.intent?.aiReasoning) ??
    "";
  const goal =
    session?.intent?.userPrompt ??
    session?.goal ??
    effectiveSummary?.goal ??
    "";

  // Risk level normalisation
  const riskRaw = session?.aggregatedRisk ?? effectiveSummary?.riskLevel;
  const riskLevel = normalizeSummaryRiskLevel(riskRaw);

  const avgConfidence =
    entries.length > 0
      ? entries.reduce((s, e) => s + e.confidence, 0) / entries.length
      : session?.intent?.confidence ?? effectiveSummary?.avgConfidence ?? 0;

  const inferredTurnCount =
    sessionTurns.length > 0
      ? sessionTurns.length
      : thread.reduce(
          (count, item) =>
            count +
            (item.requestText.trim().length > 0 ? 1 : 0) +
            ((item.responseText ?? "").trim().length > 0 ? 1 : 0),
          0,
        );

  const meta: HandoffSessionMeta = {
    sessionId:     resolvedSessionId,
    tool:
      session?.actor?.tool ??
      effectiveEntries.find((e) => e.aiTool && e.aiTool !== "unknown")?.aiTool ??
      session?.actor?.model ??
      session?.model ??
      "unknown",
    goal,
    intent: intent || watchFallbackIntent,
    reasoning,
    intentSource,
    riskLevel,
    avgConfidence,
    createdAt:     session?.startedAt ?? effectiveEntries[0]?.createdAt ?? new Date().toISOString(),
    endedAt:       session?.endedAt,
    author:
      session?.actor?.author ??
      effectiveEntries.find((e) => e.author && e.author !== "unknown")?.author,
    commitMessage: session?.intent?.commitMessage,
  };

  const handoff = buildHandoff(projectName, meta, effectiveEntries, {
    conversation: {
      totalTurns: inferredTurnCount,
      exchanges: thread.map((item) => ({
        requestText: item.requestText,
        ...(item.requestAt ? { requestAt: item.requestAt } : {}),
        ...(item.requestSource ? { requestSource: item.requestSource } : {}),
        ...(item.responseText ? { responseText: item.responseText } : {}),
        ...(item.responseAt ? { responseAt: item.responseAt } : {}),
        ...(item.responseSource ? { responseSource: item.responseSource } : {}),
      })),
    },
    continuity: {
      lastRequest: [...thread].reverse().find((item) => item.requestText.trim().length > 0)?.requestText,
      lastResponse: [...thread].reverse().find((item) => (item.responseText ?? "").trim().length > 0)?.responseText,
      unresolvedRequests: thread.filter(
        (item) => item.requestText.trim().length > 0 && (item.responseText ?? "").trim().length === 0,
      ).length,
    },
  });

  return markdownOnly
    ? handoff.markdownSummary
    : JSON.stringify(handoff, null, 2);
}
