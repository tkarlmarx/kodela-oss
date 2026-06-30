// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 123 — KodelaHandoff: Canonical AI-Transferable Context Export Format
 *
 * Defines the `KodelaHandoff` structure — a versioned, schema-validated
 * context export that can be passed between AI agents to resume a session
 * with full understanding of what was built, why, and what remains uncertain.
 *
 * Build the handoff payload with `buildHandoff()`, then:
 *   - Copy `markdownSummary` to clipboard via the dashboard button
 *   - Pipe JSON to a new agent via `kodela handoff --session <id>`
 *   - Fetch from `GET /api/context/handoff?sessionId=<id>`
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const HandoffFileChangeSchema = z.object({
  filePath:     z.string(),
  linesAdded:   z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
  changeType:   z.string(),
  /** From entry reasoning.intent (Gap 122) when available; summary.intent otherwise. */
  intent:       z.string(),
  confidence:   z.number().min(0).max(1),
  /** "mapped" | "uncertain" | "orphaned" */
  status:       z.string(),
});

export const HandoffConversationExchangeSchema = z.object({
  requestText: z.string(),
  requestAt: z.string().optional(),
  requestSource: z.string().optional(),
  responseText: z.string().optional(),
  responseAt: z.string().optional(),
  responseSource: z.string().optional(),
});

export const KodelaHandoffSchema = z.object({
  version:     z.literal("1.0"),
  exportedAt:  z.string().datetime(),
  projectName: z.string(),
  session: z.object({
    sessionId:        z.string(),
    tool:             z.string(),
    startedAt:        z.string(),
    endedAt:          z.string().optional(),
    /** Human-readable duration: "2.8h", "45m", "< 1 min". */
    duration:         z.string(),
    /**
     * The user's original prompt captured at SessionStart (Gap 121).
     * Empty string when not captured — session started before Gap 121 was implemented.
     */
    goal:             z.string(),
    /**
     * Synthesised intent from ClusterSummary (Gap 120), or from commit messages
     * / diff heuristics as a stopgap when Gap 120 is not yet active.
     */
    intent:           z.string(),
    /**
     * Synthesised reasoning from ClusterSummary (Gap 120).
     * Empty string when not available.
     */
    reasoning:        z.string(),
    /** Which path produced the intent field. */
    intentSource:     z.string(),
    author:           z.string(),
    commitSha:        z.string().optional(),
    commitMessage:    z.string().optional(),
    riskLevel:        z.enum(["low", "medium", "high"]),
    /** 0–1 average confidence across all entries in the session. */
    confidence:       z.number().min(0).max(1),
    totalAnnotations: z.number().int().nonnegative(),
    humanVerified:    z.number().int().nonnegative(),
    linesAdded:       z.number().int().nonnegative(),
    linesRemoved:     z.number().int().nonnegative(),
  }),
  /** Top files changed, sorted by (linesAdded + linesRemoved) descending. Max 20. */
  filesChanged:   z.array(HandoffFileChangeSchema),
  /**
   * Active gap IDs that reduce handoff quality.
   * Populated from the current state of Kodela's implementation.
   */
  gaps:           z.array(z.string()),
  /**
   * Uncertain or orphaned entries that need human review or continuation.
   * Grouped by file path.
   */
  continueFrom:   z.array(z.object({
    filePath: z.string(),
    issue:    z.string(),
    count:    z.number().int().nonnegative(),
  })),
  conversation: z.object({
    totalTurns: z.number().int().nonnegative(),
    exchangeCount: z.number().int().nonnegative(),
    exchanges: z.array(HandoffConversationExchangeSchema),
  }).optional(),
  continuity: z.object({
    lastRequest: z.string().optional(),
    lastResponse: z.string().optional(),
    unresolvedRequests: z.number().int().nonnegative(),
  }).optional(),
  /** Pre-rendered markdown for clipboard paste into any AI agent. */
  markdownSummary: z.string(),
});

export type KodelaHandoff = z.infer<typeof KodelaHandoffSchema>;
export type HandoffFileChange = z.infer<typeof HandoffFileChangeSchema>;
export type HandoffConversationExchange = z.infer<typeof HandoffConversationExchangeSchema>;

// ---------------------------------------------------------------------------
// Input types (loosely typed to accept data from the API layer)
// ---------------------------------------------------------------------------

export interface HandoffEntry {
  id: string;
  filePath: string;
  note: string;
  author: string;
  createdAt: string;
  confidence: number;
  status: string;
  source: string;
  aiTool: string;
  rawContext: { linesAdded: number; linesRemoved: number; diff?: string } | null;
  summary: { intent: string; changeType: string } | null;
  reasoning?: { intent: string; reasoning: string; confidence: string; extractionMethod: string } | null;
  origin: { sessionId?: string; tool?: string } | null;
}

export interface HandoffSessionMeta {
  sessionId:     string;
  tool:          string;
  goal:          string;
  intent:        string;
  reasoning:     string;
  intentSource:  string;
  riskLevel:     "low" | "medium" | "high";
  avgConfidence: number;
  createdAt:     string;
  endedAt?:      string;
  author?:       string;
  commitSha?:    string;
  commitMessage?: string;
}

export interface HandoffBuildOptions {
  conversation?: {
    totalTurns: number;
    exchanges: HandoffConversationExchange[];
  };
  continuity?: {
    lastRequest?: string;
    lastResponse?: string;
    unresolvedRequests?: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GENERIC_INTENTS = new Set([
  "ai-generated change",
  "ai generated change",
  "auto-annotated",
  "no goal captured",
  "unknown",
  "",
]);

function isGenericIntent(text: string | null | undefined): boolean {
  if (!text) return true;
  return GENERIC_INTENTS.has(text.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `< 1 min`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function shortPath(fp: string): string {
  const parts = fp.split("/");
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : fp;
}

/**
 * Build a `KodelaHandoff` from session metadata and its entries.
 *
 * @param projectName Human-readable project name.
 * @param meta        Session-level metadata (from ClusterSummary + session file).
 * @param entries     All ContextEntries in the session.
 */
export function buildHandoff(
  projectName: string,
  meta: HandoffSessionMeta,
  entries: HandoffEntry[],
  options: HandoffBuildOptions = {},
): KodelaHandoff {
  const now = new Date().toISOString();

  // Duration
  const ts = Math.min(...entries.map((e) => new Date(e.createdAt).getTime()), new Date(meta.createdAt).getTime());
  const te = meta.endedAt ? new Date(meta.endedAt).getTime() : Math.max(...entries.map((e) => new Date(e.createdAt).getTime()), ts);
  const duration = te > ts ? fmtDuration(te - ts) : "< 1 min";

  // Author
  const author =
    meta.author ??
    entries.find((e) => e.author && e.author !== "unknown" && e.author !== "sdk")?.author ??
    "unknown";

  // Line counts
  const linesAdded = entries.reduce((s, e) => s + (e.rawContext?.linesAdded ?? 0), 0);
  const linesRemoved = entries.reduce((s, e) => s + (e.rawContext?.linesRemoved ?? 0), 0);
  const humanVerified = entries.filter(
    (e) => e.status === "mapped" && e.source !== "ai",
  ).length;

  // Files changed (grouped, sorted by impact)
  const fileMap = new Map<string, HandoffFileChange>();
  for (const e of entries) {
    // Pick the best intent for this entry: prefer non-diff-inference reasoning,
    // then a non-generic summary intent, then a structural description.
    const reasoningIntent =
      e.reasoning?.intent && e.reasoning.extractionMethod !== "diff-inference" && !isGenericIntent(e.reasoning.intent)
        ? e.reasoning.intent
        : null;
    const summaryIntent = !isGenericIntent(e.summary?.intent) ? (e.summary?.intent ?? null) : null;
    const fileName = e.filePath.split("/").pop() ?? e.filePath;
    const structuralIntent =
      (e.rawContext?.linesAdded ?? 0) > 0
        ? `Modified ${fileName} (+${e.rawContext!.linesAdded} lines)`
        : `Modified ${fileName}`;
    const entryIntent = reasoningIntent ?? summaryIntent ?? structuralIntent;

    if (!fileMap.has(e.filePath)) {
      fileMap.set(e.filePath, {
        filePath:     e.filePath,
        linesAdded:   0,
        linesRemoved: 0,
        changeType:   e.summary?.changeType ?? "modification",
        intent:       entryIntent,
        confidence:   e.confidence,
        status:       e.status,
      });
    }
    const fc = fileMap.get(e.filePath)!;
    fc.linesAdded += e.rawContext?.linesAdded ?? 0;
    fc.linesRemoved += e.rawContext?.linesRemoved ?? 0;
    // Upgrade intent if a better (non-generic) source appears in later entries for this file
    if (reasoningIntent) {
      fc.intent = reasoningIntent;
    } else if (summaryIntent && isGenericIntent(fc.intent)) {
      fc.intent = summaryIntent;
    }
    // Average confidence across entries for this file
    fc.confidence = (fc.confidence + e.confidence) / 2;
  }

  // Second pass: any file whose intent is still a structural placeholder gets the
  // correct aggregated line count now that all entries have been summed.
  for (const fc of fileMap.values()) {
    if (!isGenericIntent(fc.intent) && !fc.intent.startsWith("Modified ")) continue;
    const fileName = fc.filePath.split("/").pop() ?? fc.filePath;
    fc.intent =
      fc.linesAdded > 0
        ? `Modified ${fileName} (+${fc.linesAdded} lines)`
        : fc.linesRemoved > 0
        ? `Modified ${fileName} (-${fc.linesRemoved} lines)`
        : `Modified ${fileName}`;
  }

  const filesChanged = [...fileMap.values()]
    .sort((a, b) => (b.linesAdded + b.linesRemoved) - (a.linesAdded + a.linesRemoved))
    .slice(0, 20);

  // Active gaps
  const gaps: string[] = [];
  const hasReasoning = !!meta.reasoning && meta.reasoning.trim().length > 0;
  const usesHeuristicIntent =
    meta.intentSource === "structural-fallback" ||
    meta.intentSource === "commit-message";

  if (!meta.goal) gaps.push("Gap 121 — user prompt not captured at session start");
  if (usesHeuristicIntent) {
    gaps.push("Gap 120 — session intent synthesised from heuristics/commit messages only");
  }
  if (!hasReasoning) gaps.push("Gap 122 — reasoning fields not populated (run kodela enrich --reasoning)");
  // Gap 123 is self-referential — it's always partly active before the full pipeline is implemented
  if (usesHeuristicIntent || !hasReasoning) {
    gaps.push("Gap 123 — handoff quality limited by unresolved gaps 120–122");
  }

  // Continue-from: uncertain and orphaned entries, grouped by file
  const continueMap = new Map<string, { count: number; issues: string[] }>();
  for (const e of entries) {
    if (e.status === "uncertain" || e.status === "orphaned") {
      if (!continueMap.has(e.filePath)) {
        continueMap.set(e.filePath, { count: 0, issues: [] });
      }
      const item = continueMap.get(e.filePath)!;
      item.count++;
      if (e.status === "orphaned") item.issues.push("orphaned — code has drifted");
    }
  }

  const continueFrom = [...continueMap.entries()]
    .slice(0, 10)
    .map(([fp, { count, issues }]) => ({
      filePath: fp,
      issue: issues.length > 0 ? issues[0]! : `${count} unverified change${count !== 1 ? "s" : ""}`,
      count,
    }));

  // Markdown summary
  const markdownSummary = buildMarkdownSummary({
    projectName,
    meta,
    duration,
    author,
    linesAdded,
    linesRemoved,
    humanVerified,
    totalAnnotations: entries.length,
    filesChanged,
    gaps,
    continueFrom,
    conversation: options.conversation,
    continuity: options.continuity,
  });

  const conversationPayload =
    options.conversation
      ? {
          conversation: {
            totalTurns: Math.max(0, options.conversation.totalTurns),
            exchangeCount: options.conversation.exchanges.length,
            exchanges: options.conversation.exchanges,
          },
        }
      : {};

  const continuityPayload = options.continuity
    ? {
        continuity: {
          ...(options.continuity.lastRequest
            ? { lastRequest: options.continuity.lastRequest }
            : {}),
          ...(options.continuity.lastResponse
            ? { lastResponse: options.continuity.lastResponse }
            : {}),
          unresolvedRequests: Math.max(0, options.continuity.unresolvedRequests ?? 0),
        },
      }
    : {};

  return {
    version:     "1.0",
    exportedAt:  now,
    projectName,
    session: {
      sessionId:        meta.sessionId,
      tool:             meta.tool,
      startedAt:        meta.createdAt,
      endedAt:          meta.endedAt,
      duration,
      goal:             meta.goal,
      intent:           meta.intent,
      reasoning:        meta.reasoning,
      intentSource:     meta.intentSource,
      author,
      commitSha:        meta.commitSha,
      commitMessage:    meta.commitMessage,
      riskLevel:        meta.riskLevel,
      confidence:       meta.avgConfidence,
      totalAnnotations: entries.length,
      humanVerified,
      linesAdded,
      linesRemoved,
    },
    filesChanged,
    gaps,
    continueFrom,
    ...conversationPayload,
    ...continuityPayload,
    markdownSummary,
  };
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

interface MarkdownInputs {
  projectName: string;
  meta: HandoffSessionMeta;
  duration: string;
  author: string;
  linesAdded: number;
  linesRemoved: number;
  humanVerified: number;
  totalAnnotations: number;
  filesChanged: HandoffFileChange[];
  gaps: string[];
  continueFrom: Array<{ filePath: string; issue: string; count: number }>;
  conversation?: {
    totalTurns: number;
    exchanges: HandoffConversationExchange[];
  };
  continuity?: {
    lastRequest?: string;
    lastResponse?: string;
    unresolvedRequests?: number;
  };
}

function buildMarkdownSummary(inputs: MarkdownInputs): string {
  const {
    projectName,
    meta,
    duration,
    author,
    linesAdded,
    linesRemoved,
    humanVerified,
    totalAnnotations,
    filesChanged,
    gaps,
    continueFrom,
    conversation,
    continuity,
  } = inputs;

  const confPct = Math.round(meta.avgConfidence * 100);
  const confStatus =
    confPct >= 80 ? "✓ on target" : confPct >= 60 ? "below 80% target" : "⚠ below 60% floor";

  const ts = meta.createdAt
    ? new Date(meta.createdAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "unknown";

  const lines: string[] = [
    `## Kodela AI Handoff v1.0 — ${projectName}`,
    ``,
    `**Session**: ${meta.sessionId.slice(0, 8)}…  **Started**: ${ts}  **Duration**: ${duration}`,
    `**Actor**: ${meta.tool}  **Author**: ${author}`,
    `**Confidence**: ${confPct}% (${confStatus})  **Risk**: ${meta.riskLevel}`,
    ``,
  ];

  if (meta.commitSha) {
    lines.push(`**Commit**: \`${meta.commitSha}\`${meta.commitMessage ? ` — ${meta.commitMessage}` : ""}`);
    lines.push(``);
  }

  lines.push(`### 🎯 What was built`);
  lines.push(meta.intent || "Intent not captured");
  lines.push(``);

  if (meta.goal && meta.goal !== meta.intent) {
    lines.push(`### 💬 Original request`);
    lines.push(`> ${meta.goal}`);
    lines.push(``);
  }

  if (meta.reasoning) {
    lines.push(`### 💡 Why this approach`);
    lines.push(meta.reasoning);
    lines.push(``);
  }

  lines.push(`### 📦 Files changed (${filesChanged.length})`);
  for (const fc of filesChanged.slice(0, 15)) {
    const add = fc.linesAdded > 0 ? `+${fc.linesAdded}` : "";
    const rem = fc.linesRemoved > 0 ? `-${fc.linesRemoved}` : "";
    const stats = [add, rem].filter(Boolean).join("/");
    const confPctFile = Math.round(fc.confidence * 100);
    lines.push(
      `- \`${shortPath(fc.filePath)}\`${stats ? ` (${stats})` : ""}  ${fc.changeType}  ${confPctFile}% conf`,
    );
    if (fc.intent && fc.intent !== `Modified ${fc.filePath}`) {
      lines.push(`  → ${fc.intent}`);
    }
  }
  if (filesChanged.length > 15) {
    lines.push(`- *(${filesChanged.length - 15} more files — fetch full JSON for complete list)*`);
  }
  lines.push(``);

  lines.push(`### 📊 Session scope`);
  lines.push(`- ${totalAnnotations} annotations captured, ${humanVerified} human-verified`);
  if (linesAdded > 0) lines.push(`- +${linesAdded.toLocaleString()} lines added`);
  if (linesRemoved > 0) lines.push(`- -${linesRemoved.toLocaleString()} lines removed`);
  lines.push(``);

  if (continueFrom.length > 0) {
    lines.push(`### ⚠ Continue from here (uncertain / orphaned)`);
    for (const cf of continueFrom) {
      lines.push(`- \`${shortPath(cf.filePath)}\` — ${cf.issue}`);
    }
    lines.push(``);
  }

  if ((conversation?.exchanges.length ?? 0) > 0) {
    lines.push(`### 🧵 Context request/response`);
    for (const exchange of conversation!.exchanges.slice(0, 5)) {
      lines.push(`- Request: ${exchange.requestText || "(empty)"}`);
      if (exchange.responseText) {
        lines.push(`  → Response: ${exchange.responseText}`);
      } else {
        lines.push(`  → Response: (pending)`);
      }
    }
    if (conversation!.exchanges.length > 5) {
      lines.push(`- *(${conversation!.exchanges.length - 5} more exchanges in JSON payload)*`);
    }
    lines.push(``);
  }

  if (continuity) {
    lines.push(`### ▶ Continuous handoff anchor`);
    if (continuity.lastRequest) {
      lines.push(`- Last request: ${continuity.lastRequest}`);
    }
    if (continuity.lastResponse) {
      lines.push(`- Last response: ${continuity.lastResponse}`);
    }
    if ((continuity.unresolvedRequests ?? 0) > 0) {
      lines.push(`- ${continuity.unresolvedRequests} request(s) still awaiting an explicit response`);
    }
    lines.push(``);
  }

  if (gaps.length > 0) {
    lines.push(`### ℹ️ Handoff quality notes`);
    for (const gap of gaps) {
      lines.push(`- ${gap}`);
    }
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`*Generated by Kodela v1.0 · \`kodela handoff --session ${meta.sessionId.slice(0, 8)}\`*`);

  return lines.join("\n");
}
