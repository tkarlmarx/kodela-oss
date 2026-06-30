// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Capture-denied audit logger — Phase 5.8.1 (internal design note).
 *
 * When `evaluateCapture` returns `allow: false`, the call site MUST append a
 * `capture_denied` entry to the hash chain so an external auditor can prove
 * the policy was enforced.  Without this, a denial is silent — the customer
 * sees a 4xx but the chain has no record that the policy module fired.
 *
 * Mirrors the rbac_violation pattern in artifacts/api-server/src/middlewares/
 * requireOrgId.ts — best-effort write, never propagates errors to the caller
 * because the policy enforcement itself must not be blocked by an audit-write
 * failure.
 */

import path from "node:path";
import { appendEntry } from "./hash-chain.js";
import type { CaptureDecision } from "../policy/capture-policy.js";

export interface LogCaptureDenialArgs {
  /** Absolute repo root — used to compose .kodela/audit/chain.jsonl path. */
  repoRoot: string;
  /** The decision returned by evaluateCapture; must be a deny variant. */
  decision: CaptureDecision;
  /** What was being captured. orgId stamped if known. */
  context: {
    actor?: string;
    sessionId?: string;
    filePath?: string;
    agentTool?: string;
    /** Free-form additional fields for forensics — never include the captured payload. */
    extra?: Record<string, unknown>;
  };
}

/** Best-effort write — swallows errors so audit failures don't shadow policy enforcement. */
export async function logCaptureDenial({ repoRoot, decision, context }: LogCaptureDenialArgs): Promise<void> {
  if (decision.allow) return; // defensive — allow-decisions never get logged
  const chainPath = path.join(repoRoot, ".kodela", "audit", "chain.jsonl");
  try {
    await appendEntry(chainPath, {
      kind: "capture_denied",
      actor: context.actor ?? "unknown",
      data: {
        reason: decision.reason,
        detail: decision.detail,
        sessionId: context.sessionId ?? null,
        filePath: context.filePath ?? null,
        agentTool: context.agentTool ?? null,
        ...(context.extra ?? {}),
      },
    });
  } catch {
    // Audit-write failure must not break the surrounding handler. Production
    // should monitor for absent capture_denied entries via a separate health
    // check, not by retrying here.
  }
}
