// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { randomUUID } from "node:crypto";
import type { IntentCluster, IntentClusterTrigger } from "../schema/intent-cluster.schema.js";
import { classifyScope, SENSITIVE_SCOPES } from "../scope/classifier.js";
import type { CodeScope } from "../scope/classifier.js";

export interface HookEvent {
  type: "PostToolUse" | "UserPromptSubmit" | "SessionStart" | "SessionEnd";
  sessionId: string;
  timestamp: number;
  filePath?: string;
  toolName?: string;
  lineRange?: { start: number; end: number };
  prompt?: string;
}

export interface ClusteringConfig {
  time_gap_ms?: number;
}

export interface ProcessEventResult {
  clusterId: string;
  isNewCluster: boolean;
}

interface ActiveCluster {
  cluster: IntentCluster;
  lastEventTimestamp: number;
}

const activeClusters = new Map<string, ActiveCluster>();

export function shouldStartNewCluster(
  lastTimestamp: number,
  currentEvent: HookEvent,
  currentCluster: IntentCluster,
  config: ClusteringConfig,
): { newCluster: boolean; triggerType: IntentClusterTrigger } {
  if (currentEvent.type === "UserPromptSubmit") {
    return { newCluster: true, triggerType: "new_prompt" };
  }

  const gapMs = currentEvent.timestamp - lastTimestamp;
  const timeGapThreshold = config.time_gap_ms ?? 300_000;
  if (gapMs > timeGapThreshold) {
    return { newCluster: true, triggerType: "time_gap" };
  }

  if (currentEvent.filePath && currentCluster.scope) {
    const currentScope = classifyScope(currentEvent.filePath);
    if (currentScope !== currentCluster.scope) {
      const isSensitiveShift =
        SENSITIVE_SCOPES.has(currentScope) ||
        SENSITIVE_SCOPES.has(currentCluster.scope as CodeScope);
      if (isSensitiveShift) {
        return { newCluster: true, triggerType: "scope_shift" };
      }
    }
  }

  return { newCluster: false, triggerType: "session_end" };
}

function createNewCluster(
  sessionId: string,
  index: number,
  triggerType: IntentClusterTrigger,
  filePath?: string,
  goal?: string,
): IntentCluster {
  return {
    id: randomUUID(),
    sessionId,
    index,
    startedAt: new Date().toISOString(),
    triggerType,
    goal,
    filesChanged: filePath ? [filePath] : [],
    eventCount: 0,
    entryIds: [],
    scope: filePath ? classifyScope(filePath) : undefined,
    version: 1,
  };
}

export function processEvent(
  sessionId: string,
  event: HookEvent,
  config: ClusteringConfig = {},
): ProcessEventResult {
  const active = activeClusters.get(sessionId);

  if (!active) {
    const cluster = createNewCluster(sessionId, 0, "new_prompt", event.filePath);
    cluster.eventCount = 1;
    activeClusters.set(sessionId, { cluster, lastEventTimestamp: event.timestamp });
    return { clusterId: cluster.id, isNewCluster: true };
  }

  const { newCluster, triggerType } = shouldStartNewCluster(
    active.lastEventTimestamp,
    event,
    active.cluster,
    config,
  );

  if (newCluster) {
    active.cluster.endedAt = new Date().toISOString();
    const nextIndex = active.cluster.index + 1;
    const newClusterRecord = createNewCluster(
      sessionId,
      nextIndex,
      triggerType,
      event.filePath,
      event.type === "UserPromptSubmit" ? event.prompt : undefined,
    );
    newClusterRecord.eventCount = 1;
    activeClusters.set(sessionId, {
      cluster: newClusterRecord,
      lastEventTimestamp: event.timestamp,
    });
    return { clusterId: newClusterRecord.id, isNewCluster: true };
  }

  active.cluster.eventCount += 1;
  active.lastEventTimestamp = event.timestamp;

  if (event.filePath && !active.cluster.filesChanged.includes(event.filePath)) {
    active.cluster.filesChanged.push(event.filePath);
    const newScope = classifyScope(event.filePath);
    if (!active.cluster.scope) {
      active.cluster.scope = newScope;
    }
  }

  return { clusterId: active.cluster.id, isNewCluster: false };
}

export function onNewPrompt(
  sessionId: string,
  prompt: string,
  config: ClusteringConfig = {},
): string {
  const event: HookEvent = {
    type: "UserPromptSubmit",
    sessionId,
    timestamp: Date.now(),
    prompt,
  };
  const result = processEvent(sessionId, event, config);
  return result.clusterId;
}

export function closeSession(sessionId: string): IntentCluster | null {
  const active = activeClusters.get(sessionId);
  if (!active) return null;
  active.cluster.endedAt = new Date().toISOString();
  active.cluster.triggerType = "session_end";
  activeClusters.delete(sessionId);
  return active.cluster;
}

export function getActiveCluster(sessionId: string): IntentCluster | null {
  return activeClusters.get(sessionId)?.cluster ?? null;
}

export function linkEntryToCluster(sessionId: string, entryId: string): void {
  const active = activeClusters.get(sessionId);
  if (active && !active.cluster.entryIds.includes(entryId)) {
    active.cluster.entryIds.push(entryId);
  }
}
