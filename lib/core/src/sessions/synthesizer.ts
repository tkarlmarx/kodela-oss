// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 120 — Session Intent Synthesizer
 *
 * Aggregates all ContextEntries in a session and produces a ClusterSummary:
 * a session-level synthesis of what was built, why, and what changed.
 *
 * Intent priority chain:
 *   1. `sessionGoal`      — from SessionMetadata (Gap 121) if available
 *   2. `commitMessages`   — most relevant commit message if passed by caller
 *   3. Entry reasoning    — aggregate non-generic `reasoning.intent` values
 *   4. Entry summary      — aggregate non-generic `summary.intent` values
 *   5. Structural         — "Modified N files: [file list]"
 *
 * The ClusterSummary is written to `.kodela/sessions/<sessionId>.summary.json`
 * by the caller (SessionEnd hook or synthesise CLI command).
 */

import type { ContextEntry } from "../schema/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClusterSummary {
  sessionId:       string;
  /** Synthesised intent — what was built during this session. */
  intent:          string;
  /** Synthesised reasoning — why this approach was taken. Empty when unavailable. */
  reasoning:       string;
  /** Goal from SessionMetadata (Gap 121), or empty string when not captured. */
  goal:            string;
  /** All file paths touched during the session. */
  filesChanged:    string[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
  /** Dominant change type across entries (e.g. "addition", "modification"). */
  dominantChangeType: string;
  riskLevel:       "low" | "medium" | "high";
  avgConfidence:   number;
  entryCount:      number;
  /** ISO-8601 timestamp of when this summary was synthesised. */
  synthesisedAt:   string;
  /** Which path produced the intent field. */
  intentSource:
    | "user-goal"
    | "assistant-response"
    | "commit-message"
    | "reasoning-aggregate"
    | "summary-aggregate"
    | "structural-fallback";
  /**
   * Gap 125 — Number of assistant response turns that were captured for this session.
   * Zero (or absent) means the session has only diff-heuristic or user-goal intent.
   */
  assistantTurnCount?: number;
  /**
   * Expanded memory payload used for richer handoff/history context.
   * This complements `intent`/`reasoning` with explicit "what changed",
   * "validation context", and "next actions" fields.
   */
  memory?: {
    whatChanged: string[];
    whyItMatters: string;
    validationContext: string;
    nextActions: string[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const CODE_FRAGMENT_KEYWORD_PATTERN =
  /\b(return|const|let|var|if|else|await|function|class|import|export)\b/i;

function isGeneric(text: string | undefined | null): boolean {
  if (!text) return true;
  return GENERIC_INTENTS.has(text.trim().toLowerCase());
}

function isIdentifierHeavyPlaceholder(text: string): boolean {
  const trimmed = text.trim();
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
  if (camelCaseTokens.length >= 2 && camelCaseRatio >= 0.6 && !INTENT_VERB_PATTERN.test(trimmed)) {
    return true;
  }

  return false;
}

function isCodeLikeSemanticFragment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  if (/\\["'`]/.test(trimmed)) return true;
  if (/[{}()[\]<>]/.test(trimmed)) return true;
  if (CODE_FRAGMENT_KEYWORD_PATTERN.test(trimmed)) return true;

  const words = trimmed.match(/\b[A-Za-z][A-Za-z0-9_-]*\b/g) ?? [];
  const hasVerb = INTENT_VERB_PATTERN.test(trimmed);

  if (/["'`],?\s*[A-Za-z][A-Za-z0-9_-]*:\s*$/.test(trimmed)) {
    return true;
  }

  if (trimmed.endsWith(":") && words.length <= 4 && !hasVerb) {
    return true;
  }

  if (trimmed.includes(";") && !hasVerb && words.length <= 8) {
    return true;
  }

  const punctuationCount = (trimmed.match(/[,:;'"`]/g) ?? []).length;
  const alphaCount = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  if (alphaCount > 0 && punctuationCount / alphaCount > 0.22 && !hasVerb) {
    return true;
  }

  return false;
}

function hasNaturalLanguageSignal(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) return false;
  if (!/\s/.test(trimmed)) return false;
  if (isIdentifierHeavyPlaceholder(trimmed)) return false;
  if (isCodeLikeSemanticFragment(trimmed)) return false;

  const words: string[] = trimmed.match(/\b[A-Za-z][A-Za-z0-9_-]*\b/g) ?? [];
  if (words.length < 2) return false;

  const lower = trimmed.toLowerCase();
  const hasVerb = INTENT_VERB_PATTERN.test(trimmed);
  const hasPathSeparator = /[\\/]/.test(trimmed);
  if (hasPathSeparator && (!hasVerb || words.length < 3)) {
    return false;
  }

  const hasKnownFileExtension = /\.(ts|tsx|js|jsx|json|md|yml|yaml|toml|lock)\b/.test(lower);
  if (hasKnownFileExtension && !hasVerb) {
    return false;
  }

  const alphaChars = words.reduce<number>(
    (sum, word) => sum + word.replace(/[^A-Za-z]/g, "").length,
    0,
  );
  if (alphaChars < 10) return false;

  const longWords = words.filter((word) => word.length >= 4);
  if (hasVerb) return true;
  return words.length >= 3 && longWords.length >= 2;
}

function extractQuotedSemanticSnippets(diffText: string | undefined): string[] {
  if (!diffText) return [];

  const snippets: string[] = [];
  const seen = new Set<string>();
  const quotedPattern = /["'`](.{8,220}?)["'`]/g;

  for (const match of diffText.matchAll(quotedPattern)) {
    const candidate = (match[1] ?? "").replace(/\s+/g, " ").trim();
    if (!candidate) continue;
    if (candidate.includes("\\n")) continue;
    if (candidate.includes("\\")) continue;

    const symbolCount = (candidate.match(/[{}()[\]<>]/g) ?? []).length;
    if (symbolCount >= 3) continue;

    if (isGeneric(candidate)) continue;
    if (isStructuralPlaceholder(candidate)) continue;
    if (isCodeLikeSemanticFragment(candidate)) continue;
    if (!hasNaturalLanguageSignal(candidate)) continue;

    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    snippets.push(candidate);
  }

  return snippets;
}

function isStructuralPlaceholder(text: string | undefined | null): boolean {
  if (!text) return false;
  const normalized = text.trim().toLowerCase();
  if (isIdentifierHeavyPlaceholder(text)) return true;
  return (
    normalized.startsWith("modified ") ||
    normalized.startsWith("auto-annotated:") ||
    normalized === "ai session — no file changes recorded"
  );
}

/**
 * Minimum overlap (lowercase chars) before two candidates are treated as
 * prefix-related. Below this threshold short generic phrases would falsely
 * collapse — above it, truncated-vs-full pairs reliably overlap.
 */
const PREFIX_OVERLAP_THRESHOLD = 50;

/** True when `short` is a real prefix of `long` and overlap meets the threshold. */
function isPrefixOf(short: string, long: string): boolean {
  return (
    short.length >= PREFIX_OVERLAP_THRESHOLD &&
    long.length > short.length &&
    long.toLowerCase().startsWith(short.toLowerCase())
  );
}

function collectUniqueSemanticTexts(
  values: Array<string | undefined | null>,
  minLength: number,
): string[] {
  const seen = new Set<string>();
  const collected: string[] = [];

  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length < minLength) continue;
    if (isGeneric(trimmed)) continue;
    if (isStructuralPlaceholder(trimmed)) continue;
    if (!hasNaturalLanguageSignal(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;

    // Substring-aware dedup: when one candidate is a prefix of another (the
    // most common source of duplication — `origin.summary` is the first 200
    // chars of `note`), keep only the longer text. Prevents the handoff
    // "Approach" paragraph from rendering a truncated version of the same
    // sentence twice ("…safe place to clear i" followed by the full text).
    const shorterIdx = collected.findIndex((existing) => isPrefixOf(existing, trimmed));
    if (shorterIdx !== -1) {
      // New candidate supersedes a previously collected shorter prefix.
      const prevKey = collected[shorterIdx]!.toLowerCase();
      seen.delete(prevKey);
      collected[shorterIdx] = trimmed;
      seen.add(key);
      continue;
    }
    const isPrefixOfExisting = collected.some((existing) => isPrefixOf(trimmed, existing));
    if (isPrefixOfExisting) continue;

    seen.add(key);
    collected.push(trimmed);
  }

  return collected;
}

function collectSemanticIntentCandidates(entries: ContextEntry[]): string[] {
  const candidates: Array<string | undefined> = [];
  for (const e of entries) {
    candidates.push(e.origin?.summary);
    candidates.push(e.summary?.intent);
    candidates.push(e.summary?.shortSummary);
    candidates.push(e.note);
    candidates.push(...extractQuotedSemanticSnippets(e.rawContext?.diff));
  }
  return collectUniqueSemanticTexts(candidates, 8);
}

function collectReasoningCandidates(entries: ContextEntry[]): string[] {
  const candidates: Array<string | undefined> = [];

  for (const e of entries) {
    const r = (e as Record<string, unknown>)["reasoning"];
    if (
      typeof r === "object" &&
      r !== null &&
      typeof (r as Record<string, unknown>)["reasoning"] === "string"
    ) {
      candidates.push((r as Record<string, string>)["reasoning"]);
    }

    candidates.push(e.origin?.summary);
    candidates.push(e.summary?.shortSummary);
    candidates.push(e.summary?.intent);
    candidates.push(e.note);
    candidates.push(...extractQuotedSemanticSnippets(e.rawContext?.diff));
  }

  return collectUniqueSemanticTexts(candidates, 10);
}

function dominantValue<T extends string>(
  values: T[],
): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

type ClusterSummaryDraft = Omit<ClusterSummary, "memory">;

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function isTestLikePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    /(^|[/.-])(test|spec)\.[a-z0-9]+$/.test(lower) ||
    lower.includes("__tests__/") ||
    lower.endsWith(".test.ts") ||
    lower.endsWith(".test.tsx") ||
    lower.endsWith(".spec.ts") ||
    lower.endsWith(".spec.tsx")
  );
}

function uniqueStable(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function buildMemoryWhatChanged(
  draft: ClusterSummaryDraft,
  entries: ContextEntry[],
): string[] {
  const highlights = collectSemanticIntentCandidates(entries).slice(0, 3);
  const fallbackIntent =
    highlights.length === 0 && !isLowValueSessionText(draft.intent)
      ? [draft.intent.trim()]
      : [];
  const combined = uniqueStable([...highlights, ...fallbackIntent]);

  const fileScope =
    draft.filesChanged.length === 0
      ? "No tracked file-path changes were captured."
      : `Changed ${draft.filesChanged.length} file${draft.filesChanged.length !== 1 ? "s" : ""} (+${draft.totalLinesAdded}/-${draft.totalLinesRemoved} lines).`;

  const topFiles = draft.filesChanged
    .slice(0, 3)
    .map((fp) => fp.split("/").slice(-2).join("/"));
  const fileFocus =
    topFiles.length === 0
      ? ""
      : `Primary files: ${topFiles.join(", ")}${draft.filesChanged.length > 3 ? " …" : ""}.`;

  return uniqueStable([
    ...combined,
    fileScope,
    fileFocus,
  ]).slice(0, 5);
}

function buildMemoryWhy(
  draft: ClusterSummaryDraft,
  entries: ContextEntry[],
): string {
  const reasoningCandidates = collectReasoningCandidates(entries);
  if (reasoningCandidates.length > 0) {
    return extractFirstSentence(reasoningCandidates[0]!, 240);
  }
  if (draft.reasoning.trim().length > 0) {
    return extractFirstSentence(draft.reasoning, 240);
  }
  if (!isLowValueSessionText(draft.intent)) {
    return `Intent was inferred from session artifacts (${draft.intentSource}) and indicates this session focused on ${draft.intent.toLowerCase()}`;
  }
  return `No explicit rationale was captured; context is inferred from file and diff metadata`;
}

function buildMemoryValidation(
  draft: ClusterSummaryDraft,
): string {
  const touchedTests = draft.filesChanged.some(isTestLikePath);
  if (touchedTests) {
    return "Test-related files changed in this session, but pass/fail execution results are not stored in session artifacts.";
  }
  return "No explicit test execution results were captured in session artifacts.";
}

function buildMemoryNextActions(
  draft: ClusterSummaryDraft,
  entries: ContextEntry[],
): string[] {
  const uncertain = entries.filter((e) => e.status === "uncertain");
  const orphaned = entries.filter((e) => e.status === "orphaned");
  const actions: string[] = [];

  if (orphaned.length > 0) {
    actions.push(`Re-map ${orphaned.length} orphaned annotation${orphaned.length !== 1 ? "s" : ""} before relying on these references.`);
  }
  if (uncertain.length > 0) {
    actions.push(`Review ${uncertain.length} uncertain annotation${uncertain.length !== 1 ? "s" : ""} to confirm intent and mapping accuracy.`);
  }
  if (!draft.goal.trim()) {
    actions.push("Capture a session goal at start-time to improve future handoff quality.");
  }
  if (actions.length === 0) {
    actions.push("Continue from the changed files listed above; current mappings look stable.");
  }

  return actions.slice(0, 4);
}

function isLowValueSessionText(text: string | undefined | null): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  return isGeneric(trimmed) || isStructuralPlaceholder(trimmed) || isCodeLikeSemanticFragment(trimmed);
}

function buildExpandedReasoning(
  draft: ClusterSummaryDraft,
  whyItMatters: string,
  validationContext: string,
): string {
  const base = draft.reasoning.trim().length > 0
    ? draft.reasoning.trim()
    : whyItMatters;

  const scope =
    `Session scope: ${draft.filesChanged.length} file${draft.filesChanged.length !== 1 ? "s" : ""} changed (+${draft.totalLinesAdded}/-${draft.totalLinesRemoved} lines), risk ${draft.riskLevel}, confidence ${Math.round(draft.avgConfidence * 100)}%.`;

  // Paragraph-join (\n\n) instead of space-join: the dashboard renders this
  // text in a multi-line block, and three distinct sentences (base rationale,
  // session scope stats, validation context) read as one run-on paragraph
  // when joined with a single space. Markdown-ish double-newline preserves
  // semantic boundaries while still rendering cleanly in plain-text consumers.
  return [
    sentence(base),
    sentence(scope),
    sentence(validationContext),
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 1400);
}

function finalizeSummary(
  draft: ClusterSummaryDraft,
  entries: ContextEntry[],
): ClusterSummary {
  const whatChanged = buildMemoryWhatChanged(draft, entries);
  const whyItMatters = buildMemoryWhy(draft, entries);
  const validationContext = buildMemoryValidation(draft);
  const nextActions = buildMemoryNextActions(draft, entries);

  return {
    ...draft,
    reasoning: buildExpandedReasoning(draft, whyItMatters, validationContext),
    memory: {
      whatChanged,
      whyItMatters,
      validationContext,
      nextActions,
    },
  };
}

// ---------------------------------------------------------------------------
// Main synthesis function
// ---------------------------------------------------------------------------

/**
 * Synthesise a `ClusterSummary` from the entries in a session.
 *
 * Intent priority chain:
 *   1. `sessionGoal`      — from SessionMetadata (Gap 121) if available
 *   2. `assistantTurns`   — first meaningful assistant response (Gap 125) if available
 *   3. `commitMessages`   — most relevant commit message if passed by caller
 *   4. Entry reasoning    — aggregate non-generic `reasoning.intent` values
 *   5. Entry summary      — aggregate non-generic `summary.intent` values
 *   6. Structural         — "Modified N files: [file list]"
 *
 * @param sessionId      The session UUID.
 * @param entries        All ContextEntries linked to this session.
 * @param sessionGoal    The user's original prompt/goal (from Gap 121 capture).
 * @param commitMessages Commit messages associated with this session period,
 *                       ordered newest-first. Used as fallback intent source.
 * @param riskLevel      Aggregated risk already computed by SessionManager.
 * @param assistantTurns Gap 125 — assistant response texts captured during the session.
 */
export function synthesiseSessionIntent(
  sessionId: string,
  entries: ContextEntry[],
  sessionGoal?: string,
  commitMessages?: string[],
  riskLevel: "low" | "medium" | "high" = "low",
  assistantTurns?: string[],
): ClusterSummary {
  const now = new Date().toISOString();

  // Aggregate file paths
  const filesChanged = [...new Set(entries.map((e) => e.filePath))];

  // Aggregate line counts
  const totalLinesAdded = entries.reduce(
    (s, e) => s + (e.rawContext?.linesAdded ?? 0),
    0,
  );
  const totalLinesRemoved = entries.reduce(
    (s, e) => s + (e.rawContext?.linesRemoved ?? 0),
    0,
  );

  // Average confidence
  const avgConfidence =
    entries.length > 0
      ? entries.reduce((s, e) => s + e.confidence, 0) / entries.length
      : 0;

  // Dominant change type
  const changeTypes = entries
    .map((e) => e.summary?.changeType ?? "modification")
    .filter(Boolean) as string[];
  const dominantChangeType = dominantValue(changeTypes) ?? "modification";

  // ── Intent resolution ───────────────────────────────────────────────────

  // 1. User-captured goal (Gap 121)
  if (!isGeneric(sessionGoal)) {
    return finalizeSummary({
      sessionId,
      intent: sessionGoal!.trim(),
      reasoning: buildReasoningAggregate(entries),
      goal: sessionGoal!.trim(),
      filesChanged,
      totalLinesAdded,
      totalLinesRemoved,
      dominantChangeType,
      riskLevel,
      avgConfidence,
      entryCount: entries.length,
      synthesisedAt: now,
      intentSource: "user-goal",
    }, entries);
  }

  // 2. Assistant response turns (Gap 125) — richest source when no explicit user goal
  const turnCount = assistantTurns?.length ?? 0;
  const firstMeaningfulTurn = (assistantTurns ?? []).find(
    (t) => !isGeneric(t) && t.trim().length >= 30,
  );
  if (firstMeaningfulTurn) {
    // Truncate to a reasonable intent sentence (first sentence or first 200 chars)
    const intentText = extractFirstSentence(firstMeaningfulTurn, 200);
    return finalizeSummary({
      sessionId,
      intent: intentText,
      reasoning: buildReasoningFromTurns(assistantTurns!, entries),
      goal: "",
      filesChanged,
      totalLinesAdded,
      totalLinesRemoved,
      dominantChangeType,
      riskLevel,
      avgConfidence,
      entryCount: entries.length,
      synthesisedAt: now,
      intentSource: "assistant-response",
      assistantTurnCount: turnCount,
    }, entries);
  }

  // 3. Commit message fallback
  const firstMeaningfulCommit = (commitMessages ?? []).find(
    (m) => !isGeneric(m),
  );
  if (firstMeaningfulCommit) {
    return finalizeSummary({
      sessionId,
      intent: firstMeaningfulCommit.trim(),
      reasoning: buildReasoningAggregate(entries),
      goal: "",
      filesChanged,
      totalLinesAdded,
      totalLinesRemoved,
      dominantChangeType,
      riskLevel,
      avgConfidence,
      entryCount: entries.length,
      synthesisedAt: now,
      intentSource: "commit-message",
      assistantTurnCount: turnCount,
    }, entries);
  }

  // 4. Aggregate non-generic reasoning.intent values from entries
  const reasoningIntents = entries
    .map((e) => (e as Record<string, unknown>)["reasoning"])
    .filter(
      (r): r is { intent: string } =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as Record<string, unknown>)["intent"] === "string" &&
        !isGeneric((r as Record<string, string>)["intent"]),
    )
    .map((r) => r.intent.trim());

  if (reasoningIntents.length > 0) {
    const deduped = [...new Set(reasoningIntents)];
    const intent =
      deduped.length === 1
        ? deduped[0]!
        : deduped.slice(0, 3).join("; ");
    return finalizeSummary({
      sessionId,
      intent,
      reasoning: buildReasoningAggregate(entries),
      goal: "",
      filesChanged,
      totalLinesAdded,
      totalLinesRemoved,
      dominantChangeType,
      riskLevel,
      avgConfidence,
      entryCount: entries.length,
      synthesisedAt: now,
      intentSource: "reasoning-aggregate",
    }, entries);
  }

  // 5. Aggregate semantic intent hints from summaries, origin metadata, and notes.
  // This prevents low-context watcher sessions from dropping to file-path-only intent.
  const semanticIntents = collectSemanticIntentCandidates(entries);

  if (semanticIntents.length > 0) {
    const intent =
      semanticIntents.length === 1
        ? semanticIntents[0]!
        : semanticIntents.slice(0, 3).join("; ");
    return finalizeSummary({
      sessionId,
      intent,
      reasoning: buildReasoningAggregate(entries),
      goal: "",
      filesChanged,
      totalLinesAdded,
      totalLinesRemoved,
      dominantChangeType,
      riskLevel,
      avgConfidence,
      entryCount: entries.length,
      synthesisedAt: now,
      intentSource: "summary-aggregate",
    }, entries);
  }

  // 6. Structural fallback
  const fileList =
    filesChanged.length <= 3
      ? filesChanged.join(", ")
      : `${filesChanged.slice(0, 3).join(", ")} and ${filesChanged.length - 3} more`;

  const intent =
    filesChanged.length === 0
      ? `AI session — no file changes recorded`
      : `Modified ${filesChanged.length} file${filesChanged.length !== 1 ? "s" : ""}: ${fileList}`;

  return finalizeSummary({
    sessionId,
    intent,
    reasoning: "",
    goal: "",
    filesChanged,
    totalLinesAdded,
    totalLinesRemoved,
    dominantChangeType,
    riskLevel,
    avgConfidence,
    entryCount: entries.length,
    synthesisedAt: now,
    intentSource: "structural-fallback",
  }, entries);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Gap 125 — Extract the first meaningful sentence from an assistant response turn.
 * Falls back to truncating at maxChars when no sentence boundary is found.
 */
function extractFirstSentence(text: string, maxChars: number): string {
  const trimmed = text.trim();
  const sentenceEnd = trimmed.search(/(?<=[.!?])\s/);
  if (sentenceEnd > 10 && sentenceEnd <= maxChars) {
    return trimmed.slice(0, sentenceEnd).trim();
  }
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars - 1).trimEnd() + "\u2026";
}

/**
 * Gap 125 — Build a reasoning aggregate that incorporates assistant turn text.
 * Prefers the full set of turn texts over entry-level reasoning when turns are present.
 */
function buildReasoningFromTurns(turns: string[], entries: ContextEntry[]): string {
  if (turns.length === 0) return buildReasoningAggregate(entries);
  const deduped = [...new Set(turns.map((t) => t.trim()).filter((t) => t.length > 10))];
  // Paragraph-join so two distinct turns don't read as one run-on sentence.
  return deduped.slice(0, 2).join("\n\n").slice(0, 1000);
}

/**
 * Aggregate non-empty reasoning text from entries into a 2–4 sentence summary.
 * Returns empty string when there is nothing meaningful to aggregate.
 */
function buildReasoningAggregate(entries: ContextEntry[]): string {
  const reasoningTexts = collectReasoningCandidates(entries);

  if (reasoningTexts.length === 0) return "";

  // Paragraph-join so two distinct whyChanged sources stay visually separated
  // in the dashboard's Approach paragraph instead of reading as run-on text.
  return reasoningTexts.slice(0, 2).join("\n\n");
}
