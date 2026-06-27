// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Replit-specific context helpers for Kodela.
 *
 * These utilities surface Replit workspace metadata that Kodela
 * uses when attributing AI-generated code changes and generating
 * annotation summaries in the dashboard.
 */

export type ReplitContext = {
  isReplit: boolean;
  isAgent: boolean;
  owner?: string;
  replId?: string;
  replSlug?: string;
  devDomain?: string;
};

/**
 * Collect all available Replit context from the process environment.
 * Returns a typed record so callers can branch on individual fields
 * without repeated env-var lookups.
 */
export function getReplitContext(): ReplitContext {
  const env = process.env;

  const replId    = env["REPL_ID"];
  const replSlug  = env["REPL_SLUG"];
  const devDomain = env["REPLIT_DEV_DOMAIN"];
  const owner     = env["REPL_OWNER"] ?? env["REPLIT_OWNER"];

  const isReplit  = Boolean(replId ?? replSlug ?? devDomain);
  const isAgent   = Boolean(env["REPLIT_AGENT"]);

  const ctx: ReplitContext = { isReplit, isAgent };
  if (owner)     ctx.owner     = owner;
  if (replId)    ctx.replId    = replId;
  if (replSlug)  ctx.replSlug  = replSlug;
  if (devDomain) ctx.devDomain = devDomain;

  return ctx;
}

/**
 * Returns a short display string describing the Replit context.
 * Used in CLI status output and dashboard attribution panels.
 *
 * Examples:
 *   "Replit Agent (owner: alice)"
 *   "Replit (repl: my-project)"
 *   "local"
 */
export function describeReplitContext(ctx: ReplitContext): string {
  if (!ctx.isReplit) return "local";

  const parts: string[] = [];
  if (ctx.isAgent) parts.push("Replit Agent");
  else             parts.push("Replit");

  if (ctx.owner)    parts.push(`owner: ${ctx.owner}`);
  else if (ctx.replSlug) parts.push(`repl: ${ctx.replSlug}`);

  return parts.join(" ");
}

/**
 * Returns true if the caller is running inside a Replit Agent session.
 * This is the canonical check used by the Kodela watcher attribution engine.
 */
export function isRunningAsReplitAgent(): boolean {
  return Boolean(process.env["REPLIT_AGENT"]);
}
