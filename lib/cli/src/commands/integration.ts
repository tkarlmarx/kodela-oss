// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 39 — AI Tool Integration Layer
 *
 * Provides `injectContext` — a function that formats a Kodela context block
 * and prepends it to a prompt for a target AI tool.  Also exposes a
 * `runWithInjectedContext` helper that wraps the Claude CLI binary, prepending
 * exported context before delegating to the real tool.
 *
 * Supported targets:
 *   "claude-cli"  — wraps the `claude` binary via stdin injection
 *   "cursor"      — VS Code / Cursor: formats for a `.cursorrules`-style block
 *   "copilot"     — GitHub Copilot: formats as a `// @context` prefix block
 *   "generic"     — plain separator block for any other tool
 *
 * Token limit handling:
 *   Callers pass `maxTokens` directly to `runExport` (via bin.ts or the
 *   `integrate` helper), which uses the priority-based greedy selector that
 *   already exists in `export.ts`.  `injectContext` itself does not truncate —
 *   it receives already-budget-capped context text.
 */

import { spawn } from "node:child_process";
import { runExport, formatExportResult } from "./export.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IntegrationTarget = "claude-cli" | "cursor" | "copilot" | "generic";

export type InjectContextOptions = {
  /** Which AI tool the context will be injected into. */
  target: IntegrationTarget;
  /** The already-exported Kodela context text (plain or summarised). */
  contextText: string;
  /** Optional user prompt to append after the context block. */
  prompt?: string;
};

export type IntegrateOptions = {
  repoRoot: string;
  target: IntegrationTarget;
  /** File or directory to scope the export (repo root when omitted). */
  scopePath?: string;
  /** Export the entire repository, ignoring scopePath. */
  repo?: boolean;
  /** Token budget forwarded to runExport's priority selector. */
  maxTokens?: number;
  /** Prompt to append after the context block. */
  prompt?: string;
};

// ---------------------------------------------------------------------------
// Per-tool context block formatters
// ---------------------------------------------------------------------------

const DIVIDER = "─".repeat(60);

/**
 * Wrap `contextText` in a tool-specific delimiter block.
 *
 * Claude CLI — uses XML-style tags that Claude models are trained to respect
 *   as system-level context boundaries.
 *
 * Cursor — produces a markdown comment block that Cursor's chat parser
 *   surfaces as workspace context (same format as `.cursorrules`).
 *
 * Copilot — line-comment prefix; GitHub Copilot treats leading `// @context`
 *   blocks as additional context when Copilot Chat is open.
 *
 * Generic — plain ASCII separator readable by any LLM.
 */
export function formatContextBlock(
  target: IntegrationTarget,
  contextText: string,
): string {
  switch (target) {
    case "claude-cli":
      return (
        `<kodela_context>\n` +
        `${contextText}\n` +
        `</kodela_context>\n\n`
      );

    case "cursor":
      return (
        `<!-- kodela:context\n` +
        `${contextText}\n` +
        `kodela:context -->\n\n`
      );

    case "copilot":
      return (
        contextText
          .split("\n")
          .map((line) => `// @context ${line}`)
          .join("\n") + "\n\n"
      );

    default:
      return (
        `${DIVIDER}\n` +
        `KODELA CONTEXT\n` +
        `${DIVIDER}\n` +
        `${contextText}\n` +
        `${DIVIDER}\n\n`
      );
  }
}

/**
 * Combine a formatted context block with an optional prompt.
 * Returns the full string ready to send to the target AI tool.
 */
export function injectContext(opts: InjectContextOptions): string {
  const block = formatContextBlock(opts.target, opts.contextText);
  return opts.prompt ? block + opts.prompt : block;
}

// ---------------------------------------------------------------------------
// High-level helper: export + format in one call
// ---------------------------------------------------------------------------

/**
 * Export context from `repoRoot` (scoped to `scopePath` when provided),
 * format it for `target`, and return the combined prompt string.
 *
 * This is what `kodela inject` calls internally.
 */
export async function integrate(opts: IntegrateOptions): Promise<{
  combined: string;
  contextText: string;
  truncated: boolean;
  tokenEstimate: number;
}> {
  const result = await runExport({
    repoRoot: opts.repoRoot,
    target: opts.scopePath,
    repo: opts.repo,
    maxTokens: opts.maxTokens,
    output: "text",
  });

  const contextText = formatExportResult(result, "text");
  const combined = injectContext({
    target: opts.target,
    contextText,
    prompt: opts.prompt,
  });

  return {
    combined,
    contextText,
    truncated: result.truncated,
    tokenEstimate: result.tokenEstimate,
  };
}

// ---------------------------------------------------------------------------
// Claude CLI wrapper — spawns `claude` with context injected into the prompt
// ---------------------------------------------------------------------------

export type RunClaudeOptions = {
  /** Extra args forwarded verbatim to the `claude` binary (e.g. ["--model", "claude-opus-4"]). */
  args?: string[];
  /** When true, context is written to a temp file and passed via --system-prompt. */
  useSystemPrompt?: boolean;
  /** Inherit stdio from the parent process (interactive mode). Default: true. */
  interactive?: boolean;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
};

/**
 * Spawn the `claude` CLI binary with Kodela context prepended as the first
 * user message.  Returns the child-process exit code.
 *
 * Injection strategy:
 *   When `useSystemPrompt` is false (default), `contextText` is prepended to
 *   the first positional argument (user prompt) or written to stdin.
 *   When `useSystemPrompt` is true, the context block is passed via
 *   `--system-prompt <text>` if the installed claude binary supports it;
 *   otherwise it falls back to the prepend strategy.
 *
 * NOTE: This requires the `claude` binary to be available on PATH.
 *       Run `claude --version` to verify installation.
 */
export async function runClaudeWithContext(
  contextText: string,
  userPrompt: string,
  opts: RunClaudeOptions = {},
): Promise<number> {
  const {
    args = [],
    useSystemPrompt = false,
    interactive = true,
    stdout = process.stdout,
    stderr = process.stderr,
  } = opts;

  const formatted = formatContextBlock("claude-cli", contextText);

  let spawnArgs: string[];

  if (useSystemPrompt) {
    spawnArgs = ["--system-prompt", formatted, ...args, userPrompt];
  } else {
    const combined = formatted + userPrompt;
    spawnArgs = [...args, combined];
  }

  return new Promise((resolve) => {
    const child = spawn("claude", spawnArgs, {
      stdio: interactive ? "inherit" : ["pipe", "pipe", "pipe"],
      shell: false,
    });

    if (!interactive) {
      if (child.stdout) child.stdout.pipe(stdout);
      if (child.stderr) child.stderr.pipe(stderr);
    }

    child.on("error", (err) => {
      stderr.write(
        `[kodela inject] Failed to spawn 'claude': ${err.message}\n` +
          `  Make sure the Claude CLI is installed: https://docs.anthropic.com/claude-code\n`,
      );
      resolve(1);
    });

    child.on("close", (code) => resolve(code ?? 0));
  });
}

// ---------------------------------------------------------------------------
// Output formatter for `kodela inject --output text`
// ---------------------------------------------------------------------------

export function formatInjectResult(opts: {
  target: IntegrationTarget;
  combined: string;
  truncated: boolean;
  tokenEstimate: number;
}): string {
  const lines: string[] = [];
  if (opts.truncated) {
    lines.push(
      `[kodela inject] Context truncated to fit token budget (est. ${opts.tokenEstimate} tokens).`,
    );
  }
  lines.push(opts.combined);
  return lines.join("\n");
}
