// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { generateSessionId, generateExchangeId, resolveSessionGroupId, type SessionGroupState } from "./id.js";
import type { ProxySessionRecord, SessionExchange, SessionIntent } from "./schema.js";
import { calculateConfidence } from "./schema.js";
import type { GitContext } from "../capture/git.js";
import type { ProxyConfig } from "../config/loader.js";
import { logger } from "../utils/logger.js";

const PROXY_VERSION = "1.0.0";

interface ActiveSession {
  record: ProxySessionRecord;
  timer: ReturnType<typeof setTimeout>;
  gitContext: GitContext;
}

let activeSession: ActiveSession | null = null;
let lastGroupState: SessionGroupState | null = null;

export function getActiveSession(): ProxySessionRecord | null {
  return activeSession?.record ?? null;
}

export async function getOrCreateSession(
  gitContext: GitContext,
  firstPrompt: string,
  tool: string,
  model: string,
  config: ProxyConfig,
): Promise<ProxySessionRecord> {
  if (activeSession) {
    resetIdleTimer(config);
    return activeSession.record;
  }

  const id = generateSessionId();
  const now = new Date().toISOString();

  const intentSource: SessionIntent["source"] = firstPrompt ? "proxy-T1" : "branch";
  const branchContext = gitContext.branch !== "unknown" ? gitContext.branch : undefined;

  const ticketMatch = (branchContext ?? gitContext.commitMessage).match(
    /\b([A-Z][A-Z0-9]+-[0-9]+)\b/,
  );

  const intent: SessionIntent = {
    userPrompt: firstPrompt || undefined,
    branchContext,
    linkedTicket: ticketMatch?.[1],
    source: intentSource,
    confidence: calculateConfidence(intentSource),
  };

  const sessionGroupId = resolveSessionGroupId(gitContext.branch, lastGroupState);

  const record: ProxySessionRecord = {
    schemaVersion: "2.0.0",
    id,
    startedAt: now,
    actor: {
      tool,
      model,
      author: gitContext.author,
      email: gitContext.email || undefined,
    },
    intent,
    git: gitContext,
    exchanges: [],
    exchangeCount: 0,
    confidence: intent.confidence,
    proxyVersion: PROXY_VERSION,
    captureMethod: "proxy",
    projectId: gitContext.projectId || undefined,
    sessionGroupId,
  };

  activeSession = {
    record,
    timer: scheduleIdleClose(config),
    gitContext,
  };

  logger.info({ sessionId: id, tool, model }, "[kodela] session opened");
  return record;
}

export function appendExchange(
  prompt: string,
  response: string,
  model: string,
  streaming: boolean,
  durationMs: number,
  requestBody: string,
  responseBody: string,
): void {
  if (!activeSession) return;

  const exchange: SessionExchange = {
    id: generateExchangeId(),
    timestamp: new Date().toISOString(),
    durationMs,
    prompt,
    response,
    model,
    streaming,
  };

  activeSession.record.exchanges.push(exchange);
  activeSession.record.exchangeCount = activeSession.record.exchanges.length;

  if (activeSession.record.exchanges.length === 1 && !activeSession.record.intent.aiReasoning) {
    const aiReasoning = response.slice(0, 500);
    if (aiReasoning && activeSession.record.intent.source !== "proxy-T1") {
      activeSession.record.intent.aiReasoning = aiReasoning;
      activeSession.record.intent.source = "proxy-T2";
      activeSession.record.intent.confidence = calculateConfidence("proxy-T2");
      activeSession.record.confidence = calculateConfidence("proxy-T2");
    }
  }

  void requestBody;
  void responseBody;
}

export async function closeSession(config: ProxyConfig): Promise<void> {
  if (!activeSession) return;

  const session = activeSession;
  clearTimeout(session.timer);
  activeSession = null;

  const now = new Date().toISOString();
  session.record.endedAt = now;
  session.record.durationMs = Date.now() - new Date(session.record.startedAt).getTime();

  lastGroupState = {
    lastSessionId: session.record.id,
    lastSessionGroupId: session.record.sessionGroupId ?? session.record.id,
    lastClosedAt: Date.now(),
    lastBranch: session.gitContext.branch,
  };

  await writeSessionRecord(session.record, config);

  logger.info(
    {
      sessionId: session.record.id,
      exchanges: session.record.exchangeCount,
      confidence: session.record.confidence,
    },
    `[kodela] session closed — ${session.record.exchangeCount} exchanges, confidence ${session.record.confidence.toFixed(2)}`,
  );
}

function scheduleIdleClose(config: ProxyConfig): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    void closeSession(config);
  }, config.sessionTimeoutMs);
}

function resetIdleTimer(config: ProxyConfig): void {
  if (!activeSession) return;
  clearTimeout(activeSession.timer);
  activeSession.timer = scheduleIdleClose(config);
}

async function writeSessionRecord(record: ProxySessionRecord, config: ProxyConfig): Promise<void> {
  try {
    const dir = config.kodela.sessionsDir;
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${record.id}.json`);
    const json = JSON.stringify(record, null, 2);
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, json, "utf-8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    logger.error({ err, sessionId: record.id }, "[kodela] failed to write session record");
  }
}
