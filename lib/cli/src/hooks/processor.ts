// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 52 — Claude Code Hook Payload Parser
 *
 * Parses the raw JSON payload from a Claude Code hook invocation and
 * normalises it into a `ParsedClaudeHookEvent`.
 *
 * Claude Code hook payloads arrive via stdin as JSON. The shape differs by
 * event type:
 *
 *   PostToolUse:
 *     { session_id, tool_name, tool_input, tool_response }
 *
 *   SessionStart:
 *     { session_id, model?, created_at? }
 *
 *   SessionEnd:
 *     { session_id }
 *
 *   UserPromptSubmit:
 *     { session_id, prompt }
 *
 * The parser is intentionally lenient — it extracts what it can and always
 * returns a valid `ParsedClaudeHookEvent` or null if the payload cannot be
 * parsed at all.
 */

export type ClaudeHookEventType =
  | "PostToolUse"
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "AssistantResponse";

/**
 * Normalised hook event produced by `parseHookPayload`.
 * This is the primary input to the hook processor logic.
 */
export type ParsedClaudeHookEvent = {
  event: ClaudeHookEventType;
  sessionId: string;
  timestamp: string;
  /** Present for PostToolUse events */
  toolName?: string;
  /** Extracted file path from Write/Edit/MultiEdit tool inputs */
  filePath?: string;
  /** Raw diff text extracted from tool_response or tool_input */
  rawDiff?: string;
  /** Line range from tool_input if available */
  lineRange?: { start: number; end: number };
  /** Model identifier from SessionStart metadata */
  model?: string;
  /** Bash command from tool_input for Bash tool events */
  bashCommand?: string;
  /** Prompt text for UserPromptSubmit events */
  prompt?: string;
  /**
   * Gap 125 — Extracted text from the first text block of an AssistantResponse event.
   * Only populated when the response contains at least one text content block
   * with more than 20 characters.
   */
  assistantText?: string;
  /** Raw unparsed payload — kept for debugging */
  rawPayload: string;
};

// ---------------------------------------------------------------------------
// Claude tool input shapes (lenient types — all fields optional)
// ---------------------------------------------------------------------------

type WriteInput = {
  file_path?: string;
  content?: string;
  new_content?: string;
};

type EditInput = {
  file_path?: string;
  old_string?: string;
  new_string?: string;
};

type MultiEditInput = {
  file_path?: string;
  edits?: Array<{ old_string?: string; new_string?: string }>;
};

type BashInput = {
  command?: string;
  restart?: boolean;
};

type ToolInput = WriteInput & EditInput & MultiEditInput & BashInput & Record<string, unknown>;

type RawClaudePayload = {
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: ToolInput;
  tool_response?: unknown;
  model?: unknown;
  created_at?: unknown;
  prompt?: unknown;
  /** Gap 125 — AssistantResponse message payload */
  message?: {
    role?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
};

// ---------------------------------------------------------------------------
// File-write tools whose inputs contain a file_path
// ---------------------------------------------------------------------------

const FILE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "str_replace_editor",
  "create_file",
  "write_file",
]);

const BASH_TOOLS = new Set(["Bash", "bash", "shell", "execute_command"]);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw Claude Code hook payload string into a `ParsedClaudeHookEvent`.
 *
 * Returns `null` only when the raw string cannot be JSON-parsed at all or
 * when no `session_id` is present. Partial payloads are accepted — missing
 * optional fields are simply absent from the result.
 */
export function parseHookPayload(
  event: ClaudeHookEventType,
  raw: string,
): ParsedClaudeHookEvent | null {
  let parsed: RawClaudePayload;
  try {
    parsed = JSON.parse(raw) as RawClaudePayload;
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const sessionId =
    typeof parsed.session_id === "string" && parsed.session_id.trim()
      ? parsed.session_id.trim()
      : null;

  if (!sessionId) return null;

  const timestamp = new Date().toISOString();

  const base: ParsedClaudeHookEvent = {
    event,
    sessionId,
    timestamp,
    rawPayload: raw,
  };

  // ── SessionStart ──────────────────────────────────────────────────────────
  if (event === "SessionStart") {
    if (typeof parsed.model === "string" && parsed.model) {
      base.model = parsed.model;
    }
    return base;
  }

  // ── SessionEnd ────────────────────────────────────────────────────────────
  if (event === "SessionEnd") {
    return base;
  }

  // ── UserPromptSubmit ──────────────────────────────────────────────────────
  if (event === "UserPromptSubmit") {
    if (typeof parsed.prompt === "string" && parsed.prompt) {
      base.prompt = parsed.prompt;
    }
    return base;
  }

  // ── AssistantResponse (Gap 125) ───────────────────────────────────────────
  if (event === "AssistantResponse") {
    // Extract the first text block from message.content that is long enough
    // to be a meaningful reasoning explanation (> 20 chars).
    const content = parsed.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          typeof block === "object" &&
          block !== null &&
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim().length > 20
        ) {
          base.assistantText = block.text.trim();
          break;
        }
      }
    }
    return base;
  }

  // ── PostToolUse ───────────────────────────────────────────────────────────
  const toolName =
    typeof parsed.tool_name === "string" ? parsed.tool_name : undefined;
  if (toolName) base.toolName = toolName;

  const input = parsed.tool_input ?? {};

  // Bash tool — extract command, no file path
  if (toolName && BASH_TOOLS.has(toolName)) {
    if (typeof input.command === "string" && input.command) {
      base.bashCommand = input.command;
    }
    return base;
  }

  // File-write tools — extract file path and diff
  if (!toolName || FILE_TOOLS.has(toolName)) {
    const filePath =
      typeof input.file_path === "string" && input.file_path
        ? input.file_path
        : undefined;
    if (filePath) base.filePath = filePath;

    // Build a minimal diff representation from tool input
    const diff = buildDiffFromInput(toolName, input);
    if (diff) base.rawDiff = diff;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDiffFromInput(
  toolName: string | undefined,
  input: ToolInput,
): string | undefined {
  if (!toolName || toolName === "Write" || toolName === "create_file" || toolName === "write_file") {
    const content = input.content ?? input.new_content;
    if (typeof content === "string" && content) {
      const preview = content.length > 2000 ? content.slice(0, 2000) + "\n..." : content;
      const filePath = input.file_path ?? "<unknown>";
      return `--- /dev/null\n+++ ${filePath}\n${preview
        .split("\n")
        .map((l) => `+${l}`)
        .join("\n")}`;
    }
    return undefined;
  }

  if (toolName === "Edit" || toolName === "str_replace_editor") {
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (!oldStr && !newStr) return undefined;
    const filePath = input.file_path ?? "<unknown>";
    const removedLines = oldStr
      .split("\n")
      .map((l) => `-${l}`)
      .join("\n");
    const addedLines = newStr
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n");
    return `--- ${filePath}\n+++ ${filePath}\n${removedLines}\n${addedLines}`;
  }

  if (toolName === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const filePath = input.file_path ?? "<unknown>";
    const parts: string[] = [`--- ${filePath}\n+++ ${filePath}`];
    for (const edit of edits.slice(0, 10)) {
      const oldStr = typeof edit.old_string === "string" ? edit.old_string : "";
      const newStr = typeof edit.new_string === "string" ? edit.new_string : "";
      parts.push(
        oldStr
          .split("\n")
          .map((l) => `-${l}`)
          .join("\n"),
      );
      parts.push(
        newStr
          .split("\n")
          .map((l) => `+${l}`)
          .join("\n"),
      );
    }
    return parts.join("\n");
  }

  return undefined;
}
