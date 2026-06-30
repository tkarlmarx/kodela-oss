// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Capture tier — how strictly Kodela enforces per-file context before a
 * session may close.
 *
 *   "enforced" (default) — a session cannot close until every file it touched
 *      has per-file context. Highest assurance; the historical behavior.
 *   "assisted" — close is allowed, but missing files are enqueued for async
 *      synthesis and the result flags that they need review.
 *   "ambient"  — close always succeeds immediately; missing files are enqueued
 *      for async synthesis silently. "Install, do nothing, get populated."
 *
 * The tier is read from `.kodela/config.json` (`{ "captureTier": "ambient" }`),
 * overridable per-process with the `KODELA_CAPTURE_TIER` env var. Both the CLI
 * and the MCP server read it through this one helper so the policy is single-
 * sourced. Open-core (Apache-2.0): the gate is just which check runs; the async
 * synthesis worker that fills the gap is a separate, commercial component.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const CAPTURE_TIERS = ["enforced", "assisted", "ambient"] as const;
export type CaptureTier = (typeof CAPTURE_TIERS)[number];

export const DEFAULT_CAPTURE_TIER: CaptureTier = "enforced";

/** True when this tier blocks session close on missing per-file context. */
export function tierBlocksClose(tier: CaptureTier): boolean {
  return tier === "enforced";
}

function coerceTier(value: unknown): CaptureTier | null {
  return typeof value === "string" && (CAPTURE_TIERS as readonly string[]).includes(value)
    ? (value as CaptureTier)
    : null;
}

function configPath(repoRoot: string): string {
  return path.join(repoRoot, ".kodela", "config.json");
}

/**
 * Resolve the active capture tier. Precedence: KODELA_CAPTURE_TIER env →
 * `.kodela/config.json` `captureTier` → default ("enforced"). Never throws;
 * an unreadable or malformed config falls back to the default.
 */
export function readCaptureTier(repoRoot: string): CaptureTier {
  const fromEnv = coerceTier(process.env.KODELA_CAPTURE_TIER);
  if (fromEnv) return fromEnv;

  try {
    const file = configPath(repoRoot);
    if (!existsSync(file)) return DEFAULT_CAPTURE_TIER;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { captureTier?: unknown };
    return coerceTier(parsed.captureTier) ?? DEFAULT_CAPTURE_TIER;
  } catch {
    return DEFAULT_CAPTURE_TIER;
  }
}

/**
 * Persist the capture tier to `.kodela/config.json`, preserving any other keys
 * already in the file. Creates the `.kodela` directory if needed.
 */
export function writeCaptureTier(repoRoot: string, tier: CaptureTier): void {
  const dir = path.join(repoRoot, ".kodela");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = configPath(repoRoot);
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(file)) existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  existing.captureTier = tier;
  writeFileSync(file, JSON.stringify(existing, null, 2) + "\n", "utf8");
}
