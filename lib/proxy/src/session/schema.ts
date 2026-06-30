// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { GitContext } from "../capture/git.js";

export interface SessionActor {
  tool: string;
  model: string;
  author: string;
  email?: string;
}

export interface SessionIntent {
  userPrompt?: string;
  aiReasoning?: string;
  commitMessage?: string;
  branchContext?: string;
  linkedTicket?: string;
  synthesised?: string;
  source: "proxy-T1" | "proxy-T2" | "commit" | "branch" | "heuristic";
  confidence: number;
}

export interface RawCapture {
  requestBody: string;
  responseBody: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs: number;
}

export interface SessionExchange {
  id: string;
  timestamp: string;
  durationMs: number;
  prompt: string;
  response: string;
  model: string;
  streaming: boolean;
}

export interface ProxySessionRecord {
  schemaVersion: "2.0.0";
  id: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;

  actor: SessionActor;
  intent: SessionIntent;
  git: GitContext;

  exchanges: SessionExchange[];
  exchangeCount: number;

  filesChanged?: string[];
  linesAdded?: number;
  linesRemoved?: number;

  confidence: number;
  risk?: "low" | "medium" | "high";

  projectId?: string;
  sessionGroupId?: string;
  parentSessionId?: string;

  handoffSummary?: string;
  clusterId?: string;

  proxyVersion: string;
  captureMethod: "proxy";

  checksum?: string;
}

export function calculateConfidence(source: SessionIntent["source"]): number {
  switch (source) {
    case "proxy-T1": return 0.94;
    case "proxy-T2": return 0.85;
    case "commit":   return 0.72;
    case "branch":   return 0.65;
    default:         return 0.45;
  }
}
