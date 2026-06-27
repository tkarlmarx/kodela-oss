// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 19 — AI-specific edge cases
 *
 * Three optional prompts shown during `kodela.add` when specific AI tools or
 * URL patterns are detected.  All prompts are purely additive — pressing
 * Escape on any of them skips that field rather than cancelling the
 * annotation.
 *
 * Exported as pure functions with injectable `showInputBox` / `showInfo`
 * arguments so they can be unit-tested without VS Code APIs.
 */

/** Result of the Gap 19 prompt flow. */
export interface Gap19Context {
  /**
   * 19a / 19b — Summary stored in `origin.summary`.
   * - For Cursor: the full Composer session intent.
   * - For Claude Artifacts / ChatGPT Canvas: the root URL version and context
   *   (`"claude artifact v7 · handle edge case in refresh rotation"`).
   */
  originSummary?: string;
  /**
   * 19c — Thread / session title for shared team accounts.
   * Appended to the annotation note as ` · Thread: <title>`.
   */
  threadTitle?: string;
}

/** Minimal input-box options passed to the injected `showInputBox`. */
export interface InputBoxOptions {
  prompt: string;
  placeHolder?: string;
}

export type ShowInputBoxFn = (
  opts: InputBoxOptions,
) => Promise<string | undefined>;

export type ShowInfoFn = (message: string) => void;

/**
 * Collect additional annotation context for Gap 19 edge cases.
 *
 * @param aiTool       The detected AI tool name (e.g. `"cursor"`, `"claude"`).
 * @param link         The AI session URL stored in `entry.link`, if any.
 * @param showInputBox Injectable prompt function (use `vscode.window.showInputBox` in production).
 * @param showInfo     Injectable information banner (use `vscode.window.showInformationMessage` in production).
 *
 * All prompts are optional — `undefined` returned by `showInputBox` means
 * the user skipped the field, not that they cancelled the annotation.
 */
export async function collectGap19Context(
  aiTool: string | undefined,
  link: string | undefined,
  showInputBox: ShowInputBoxFn,
  showInfo: ShowInfoFn,
): Promise<Gap19Context> {
  const result: Gap19Context = {};

  // ---------------------------------------------------------------------------
  // 19a — Cursor Composer: full session intent
  //
  // When Cursor is detected, the 3 lines that Composer changed don't capture
  // the 200-line prompt that produced them.  Ask the developer for a plain-text
  // summary of the session intent; stored in `origin.summary`.
  // ---------------------------------------------------------------------------
  if (aiTool === "cursor") {
    const summary = await showInputBox({
      prompt:
        "Cursor Composer: paste your full session intent or summary (optional — provides context if the link expires)",
      placeHolder:
        "e.g. Refactored auth middleware to async/await — session covered all token-refresh edge cases",
    });
    // undefined = Escape = skip this field (do not cancel the annotation)
    if (summary) result.originSummary = summary;
  }

  // ---------------------------------------------------------------------------
  // 19b — Claude Artifacts / ChatGPT Canvas: versioned document convention
  //
  // Versioned artifact/canvas links change with each revision.  If a
  // revision URL is stored, future teammates can't reach the latest version.
  // When an artifact-like URL is detected, show the convention and ask for a
  // root-URL + version summary.  Skipped when 19a already set originSummary.
  // ---------------------------------------------------------------------------
  if (link && isArtifactUrl(link) && !result.originSummary) {
    showInfo(
      "Kodela: versioned artifact URL detected. " +
        "Convention: store the root artifact URL and add the version + context in the summary field below " +
        "(e.g. 'claude artifact v7 · handle edge case in refresh rotation').",
    );
    const artifactSummary = await showInputBox({
      prompt: "Artifact version + context (optional — helps teammates reach the right revision)",
      placeHolder: "claude artifact v3 · handle edge cases in refresh rotation",
    });
    if (artifactSummary) result.originSummary = artifactSummary;
  }

  // ---------------------------------------------------------------------------
  // 19c — Shared team AI accounts: thread / session title
  //
  // On shared Claude Team or Cursor Business accounts all links look identical
  // but point to different conversations.  An optional session title appended
  // to the note lets teammates identify the correct thread without opening it.
  // ---------------------------------------------------------------------------
  if (aiTool === "claude" || aiTool === "cursor") {
    const toolLabel = aiTool === "claude" ? "Claude" : "Cursor";
    const title = await showInputBox({
      prompt: `${toolLabel} thread / session title — helps teammates find the right conversation on shared accounts (optional)`,
      placeHolder: "e.g. Auth refactor sprint — handle refresh token rotation",
    });
    if (title) result.threadTitle = title;
  }

  return result;
}

/**
 * Returns `true` when `url` looks like a versioned Claude Artifact or
 * ChatGPT Canvas URL — i.e. the kind that changes between revisions.
 *
 * Exported for unit tests.
 */
export function isArtifactUrl(url: string): boolean {
  return /claude\.ai\/(artifact|canvas)\/|chatgpt\.com\/canvas\/|chat\.openai\.com\/canvas\//i.test(
    url,
  );
}
