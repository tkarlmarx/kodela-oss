// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { randomUUID } from "node:crypto";

export function generateSessionId(): string {
  return randomUUID();
}

export function generateExchangeId(): string {
  return randomUUID();
}

export interface SessionGroupState {
  lastSessionId: string;
  lastSessionGroupId: string;
  lastClosedAt: number;
  lastBranch: string;
}

const SESSION_GROUP_WINDOW_MS = 30 * 60 * 1000;

export function resolveSessionGroupId(
  currentBranch: string,
  state: SessionGroupState | null,
): string | undefined {
  if (!state) return undefined;

  const elapsed = Date.now() - state.lastClosedAt;
  if (elapsed <= SESSION_GROUP_WINDOW_MS && currentBranch === state.lastBranch) {
    return state.lastSessionGroupId;
  }

  return undefined;
}
