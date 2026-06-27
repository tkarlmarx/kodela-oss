// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Runtime environment detection for Kodela.
 *
 * Detects Replit, CI, and other hosting environments by inspecting
 * well-known environment variables.
 */

export type KodelaEnvironment = {
  isReplit: boolean;
  isCI: boolean;
  replId?: string;
  replitDomain?: string;
  replSlug?: string;
};

/**
 * Inspect the current Node.js process environment and return a structured
 * description of the hosting context.
 *
 * All environment variable reads are guarded — this function never throws.
 */
export function detectEnvironment(): KodelaEnvironment {
  const env = process.env;

  const replId = env["REPL_ID"] ?? env["REPL_ID"];
  const replitDomain = env["REPLIT_DEV_DOMAIN"];
  const replSlug = env["REPL_SLUG"];

  const isReplit = Boolean(replId ?? replitDomain ?? replSlug);

  const isCI = Boolean(
    env["CI"] ??
      env["GITHUB_ACTIONS"] ??
      env["GITLAB_CI"] ??
      env["CIRCLECI"] ??
      env["TRAVIS"] ??
      env["BUILDKITE"] ??
      env["JENKINS_URL"],
  );

  const result: KodelaEnvironment = { isReplit, isCI };
  if (replId) result.replId = replId;
  if (replitDomain) result.replitDomain = replitDomain;
  if (replSlug) result.replSlug = replSlug;
  return result;
}

/**
 * Returns a human-readable label for the current environment.
 * Used in onboarding messages and CLI hints.
 */
export function environmentLabel(env: KodelaEnvironment): string {
  if (env.isReplit) return "Replit";
  if (env.isCI) return "CI";
  return "local";
}

/**
 * Returns true when the process is running inside a Replit Agent session.
 * Checks for the REPLIT_AGENT environment variable which is set by the
 * Replit Agent runtime when it executes code on your behalf.
 */
export function isReplitAgent(): boolean {
  return Boolean(process.env["REPLIT_AGENT"] ?? process.env["REPL_OWNER"]);
}

/**
 * Returns the Replit owner/username for the current repl, if available.
 * Useful for surfacing context in CLI output and dashboard attribution.
 */
export function getReplitOwner(): string | undefined {
  return process.env["REPL_OWNER"] ?? process.env["REPLIT_OWNER"];
}

/**
 * Returns a structured summary of AI tool attribution for the current session.
 * Combines environment detection with known agent signals to produce a label
 * that the Kodela watcher uses when auto-annotating code changes.
 *
 * Priority order:
 *  1. KODELA_AGENT  — explicit agent declaration (highest confidence)
 *  2. REPLIT_AGENT  — Replit Agent session
 *  3. REPL_OWNER    — Replit user environment (fallback)
 *  4. undefined     — not running in a known AI context
 */
export function getAiToolAttribution(): { tool: string; confidence: number } | undefined {
  const env = process.env;
  if (env["KODELA_AGENT"]) return { tool: env["KODELA_AGENT"], confidence: 1.0 };
  if (env["REPLIT_AGENT"]) return { tool: "replit-agent", confidence: 0.85 };
  if (env["REPL_OWNER"])   return { tool: "replit-agent", confidence: 0.50 };
  return undefined;
}
