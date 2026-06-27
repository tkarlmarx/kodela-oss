// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Shared AI tool name → canonical URL resolution.
 *
 * Kept in @kodela/core so both the CLI and the VS Code extension can
 * import `KNOWN_AI_TOOL_LINKS` and `resolveToolNameAttribution` without
 * duplicating the table.
 */

export type AiToolAttribution = {
  aiTool: string;
  link: string;
};

/**
 * Canonical homepage URL for each known AI tool name.
 * Keys are lowercase; lookup normalises the input before matching.
 */
export const KNOWN_AI_TOOL_LINKS: ReadonlyMap<string, string> = new Map([
  // VS Code extensions — auto-detected via command prefix
  ["copilot", "https://github.com/features/copilot"],
  ["continue", "https://continue.dev"],
  ["codeium", "https://codeium.com"],
  ["tabnine", "https://www.tabnine.com"],
  ["supermaven", "https://supermaven.com"],
  ["cursor", "https://cursor.sh"],
  ["amazon-q", "https://aws.amazon.com/q/developer/"],
  ["windsurf", "https://codeium.com/windsurf"],
  ["gemini-code-assist", "https://cloud.google.com/gemini/docs/codeassist"],
  ["qodo", "https://qodo.ai"],
  ["amp", "https://sourcegraph.com/amp"],
  ["pieces", "https://pieces.app"],
  // Web tools — manual override via --ai-tool or preferredAiTool
  ["claude", "https://claude.ai"],
  ["chatgpt", "https://chatgpt.com"],
  ["gemini", "https://gemini.google.com"],
  // Terminal agents / autonomous coding agents (Category C)
  ["claude-code", "https://claude.ai/code"],
  ["codex", "https://github.com/openai/codex"],
  ["replit-agent", "https://replit.com/ai"],
  ["aider", "https://aider.chat"],
  ["plandex", "https://plandex.ai"],
  ["devin", "https://cognition.ai/devin"],
  ["openHands", "https://github.com/All-Hands-AI/OpenHands"],
]);

/**
 * Resolve a tool name string (e.g. from `--ai-tool` or
 * `kodela.preferredAiTool`) to a full attribution object.
 *
 * - Returns `undefined` for empty / "none" values.
 * - `link` will be the canonical URL when the name is known, or "" otherwise
 *   (callers may override with `--link`).
 */
export function resolveToolNameAttribution(
  toolName: string,
): AiToolAttribution | undefined {
  const trimmed = toolName.trim().toLowerCase();
  if (!trimmed || trimmed === "none") return undefined;
  const link =
    KNOWN_AI_TOOL_LINKS.get(trimmed) ??
    KNOWN_AI_TOOL_LINKS.get(toolName.trim());
  return { aiTool: toolName.trim(), link: link ?? "" };
}

/**
 * Detect Cursor IDE from environment variables and return an attribution
 * object if detected, otherwise `undefined`.
 *
 * Cursor sets CURSOR_TRACE_ID or CURSOR_SESSION_ID in its process
 * environment; we piggyback on this to auto-attribute annotations.
 */
export function detectCursorFromEnv(): AiToolAttribution | undefined {
  if (process.env["CURSOR_TRACE_ID"] || process.env["CURSOR_SESSION_ID"]) {
    return { aiTool: "cursor", link: "https://cursor.sh" };
  }
  return undefined;
}
