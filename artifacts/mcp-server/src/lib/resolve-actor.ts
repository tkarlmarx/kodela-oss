// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Resolve actor (tool/model) from KODELA_* env vars with input fallbacks.
 * Used by session start and annotate so MCP calls label the correct IDE.
 *
 * Resolution order for `model`:
 *   1. explicit input.actor_model (caller-supplied)
 *   2. KODELA_MODEL env var (Kodela-specific override)
 *   3. AI_AGENT env var, parsed — Claude Code sets this to e.g.
 *      "claude-code_2-1-145_agent" which we surface as
 *      "claude-code-2.1.145" so the dashboard shows a version-tagged
 *      identifier instead of "unknown".
 *   4. undefined (rendered as "unknown" downstream)
 */

export type ActorInput = {
  actor_tool: string;
  actor_model?: string;
  actor_author?: string;
};

export type ResolvedActor = {
  tool: string;
  model?: string;
  author?: string;
};

/**
 * Parse the AI_AGENT env var (Claude Code sets this to
 * `<tool>_<version-with-dashes>_agent`) into a human-friendly model id like
 * `claude-code-2.1.145`. Returns undefined when AI_AGENT is missing or
 * doesn't match the expected shape.
 */
function deriveModelFromAiAgentEnv(): string | undefined {
  const raw = process.env["AI_AGENT"]?.trim();
  if (!raw) return undefined;
  // Strip the trailing "_agent" suffix Claude Code adds.
  const trimmed = raw.replace(/_agent$/, "");
  // Expect <tool>_<version> — version uses dashes instead of dots.
  const match = trimmed.match(/^(.+?)_([\d-]+)$/);
  if (!match) return trimmed; // No version detected; surface the tag as-is.
  const [, tool, version] = match;
  return `${tool}-${version!.replaceAll("-", ".")}`;
}

function resolveModel(explicit?: string): string | undefined {
  const envModel = process.env["KODELA_MODEL"]?.trim();
  return explicit ?? envModel ?? deriveModelFromAiAgentEnv();
}

export function resolveActorFromEnv(input: ActorInput): ResolvedActor {
  const envAgent = process.env["KODELA_AGENT"]?.trim();
  if (envAgent) {
    return {
      tool: envAgent,
      model: resolveModel(input.actor_model),
      author: input.actor_author,
    };
  }
  return {
    tool: input.actor_tool,
    model: resolveModel(input.actor_model),
    author: input.actor_author,
  };
}

/** Session actor defaults for annotate — env wins over stale session metadata. */
export function resolveSessionActorForAnnotate(session: {
  actor?: { tool?: string; model?: string | null; author?: string } | null;
}): { tool: string; model: string | null; author: string } {
  const envAgent = process.env["KODELA_AGENT"]?.trim();
  if (envAgent) {
    return {
      tool: envAgent,
      model: resolveModel(undefined) ?? session.actor?.model ?? null,
      author: session.actor?.author ?? "ai-agent",
    };
  }
  return {
    tool: session.actor?.tool ?? "unknown",
    model: session.actor?.model ?? resolveModel(undefined) ?? null,
    author: session.actor?.author ?? "ai-agent",
  };
}
