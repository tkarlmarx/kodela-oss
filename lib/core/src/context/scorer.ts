// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import type { EntryRow } from "../storage/sqlite-index.js";
import type {
  EntryScoreBreakdown,
  QueryContext,
  ScoredEntryRow,
  ScoringWeights,
} from "./types.js";
import { DEFAULT_WEIGHTS } from "./types.js";

function computeRecency(createdAt: string): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 1) return 1.0;
  if (ageDays <= 7) return 0.9;
  if (ageDays <= 30) return 0.75;
  if (ageDays <= 90) return 0.5;
  if (ageDays <= 180) return 0.3;
  return 0.1;
}

function computeFileRelevance(entryPath: string, queryPath?: string): number {
  if (!queryPath) return 0;
  if (entryPath === queryPath) return 1.0;
  const entryParts = entryPath.split("/");
  const queryParts = queryPath.split("/");
  let shared = 0;
  const minLen = Math.min(entryParts.length, queryParts.length);
  for (let i = 0; i < minLen; i++) {
    if (entryParts[i] === queryParts[i]) shared++;
    else break;
  }
  if (shared === 0) return 0;
  return Math.min(0.9, shared / Math.max(entryParts.length, queryParts.length));
}

function computeIntentMatch(entryScope: string | null, queryIntent?: string): number {
  if (!queryIntent || !entryScope) return 0;
  const q = queryIntent.toLowerCase().trim();
  const s = entryScope.toLowerCase().trim();
  if (s === q) return 1.0;
  if (s.includes(q) || q.includes(s)) return 0.7;
  const qTokens = new Set(q.split(/\W+/).filter(Boolean));
  const sTokens = s.split(/\W+/).filter(Boolean);
  const matches = sTokens.filter((t) => qTokens.has(t)).length;
  if (matches === 0) return 0;
  return Math.min(0.6, matches / Math.max(qTokens.size, sTokens.length));
}

export function scoreEntry(
  entry: EntryRow,
  query: QueryContext,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): EntryScoreBreakdown {
  const recency = computeRecency(entry.createdAt);
  const fileRelevance = computeFileRelevance(entry.filePath, query.filePath);
  const intentMatch = computeIntentMatch(entry.scope, query.intent);
  const confidence = Math.max(0, Math.min(1, entry.confidence));
  const usageSignal = 0;

  const finalScore =
    recency * weights.recency +
    fileRelevance * weights.fileRelevance +
    intentMatch * weights.intentMatch +
    confidence * weights.confidence +
    usageSignal * weights.usageSignal;

  return { recency, fileRelevance, intentMatch, confidence, usageSignal, finalScore };
}

export function scoreEntries(
  entries: EntryRow[],
  query: QueryContext,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): ScoredEntryRow[] {
  return entries.map((entry) => ({
    id: entry.id,
    filePath: entry.filePath,
    confidence: entry.confidence,
    createdAt: entry.createdAt,
    scope: entry.scope,
    sessionId: entry.sessionId,
    clusterId: entry.clusterId,
    scores: scoreEntry(entry, query, weights),
  }));
}
