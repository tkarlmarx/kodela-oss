// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * AI Tool Auto-Detection (Task #1)
 *
 * Tracks which AI tool extension was most recently used in the IDE by listening
 * to `vscode.commands.onDidExecuteCommand`. When an annotation is saved, the
 * most recently active AI tool within the configured window is auto-attributed.
 *
 * Priority order (first non-null value wins):
 *   1. `kodela.preferredAiTool` VS Code workspace setting
 *   2. Most recent AI command fired within `kodela.aiDetectionWindowMs`
 *   3. Cursor environment heuristic (CURSOR_TRACE_ID env var)
 *   4. undefined (no attribution stored)
 */

import * as vscode from "vscode";
import {
  KNOWN_AI_TOOL_LINKS,
  resolveToolNameAttribution,
  type AiToolAttribution,
} from "@kodela/core";

export type { AiToolAttribution };
export { KNOWN_AI_TOOL_LINKS, resolveToolNameAttribution };

/**
 * Ordered list of command-ID prefixes → attribution.
 * More-specific prefixes (longer) are listed first within the same tool so
 * they match before the shorter generic prefix would.
 */
export const KNOWN_AI_COMMAND_PREFIXES: ReadonlyArray<[string, AiToolAttribution]> = [
  ["github.copilot-chat", { aiTool: "copilot", link: "https://github.com/features/copilot" }],
  ["github.copilot", { aiTool: "copilot", link: "https://github.com/features/copilot" }],
  ["GitHub.copilot-chat", { aiTool: "copilot", link: "https://github.com/features/copilot" }],
  ["GitHub.copilot", { aiTool: "copilot", link: "https://github.com/features/copilot" }],
  ["continue.", { aiTool: "continue", link: "https://continue.dev" }],
  ["Continue.", { aiTool: "continue", link: "https://continue.dev" }],
  ["codeium.", { aiTool: "codeium", link: "https://codeium.com" }],
  ["Codeium.", { aiTool: "codeium", link: "https://codeium.com" }],
  ["tabnine.", { aiTool: "tabnine", link: "https://www.tabnine.com" }],
  ["TabNine.", { aiTool: "tabnine", link: "https://www.tabnine.com" }],
  ["supermaven.", { aiTool: "supermaven", link: "https://supermaven.com" }],
  ["cursorai.", { aiTool: "cursor", link: "https://cursor.sh" }],
  ["cursor.", { aiTool: "cursor", link: "https://cursor.sh" }],
  ["amazonq.", { aiTool: "amazon-q", link: "https://aws.amazon.com/q/developer/" }],
  ["aws.codeWhisperer", { aiTool: "amazon-q", link: "https://aws.amazon.com/q/developer/" }],
  ["windsurf.", { aiTool: "windsurf", link: "https://codeium.com/windsurf" }],
  // Gemini Code Assist (Google Cloud Code extension)
  ["cloudcode.", { aiTool: "gemini-code-assist", link: "https://cloud.google.com/gemini/docs/codeassist" }],
  ["google.gemini", { aiTool: "gemini-code-assist", link: "https://cloud.google.com/gemini/docs/codeassist" }],
  // Qodo (formerly CodiumAI)
  ["Codium.", { aiTool: "qodo", link: "https://qodo.ai" }],
  ["codium.", { aiTool: "qodo", link: "https://qodo.ai" }],
  ["qodo.", { aiTool: "qodo", link: "https://qodo.ai" }],
  // Amp (Sourcegraph Cody)
  ["sourcegraph.cody", { aiTool: "amp", link: "https://sourcegraph.com/amp" }],
  ["cody.", { aiTool: "amp", link: "https://sourcegraph.com/amp" }],
  // Pieces for Developers
  ["pieces.", { aiTool: "pieces", link: "https://pieces.app" }],
  ["MeshIntelligentTechnologiesInc.", { aiTool: "pieces", link: "https://pieces.app" }],
];

/** Resolve a VS Code command ID to an AI tool attribution, or undefined. */
export function resolveCommandAttribution(
  commandId: string,
): AiToolAttribution | undefined {
  for (const [prefix, attribution] of KNOWN_AI_COMMAND_PREFIXES) {
    if (commandId.startsWith(prefix)) {
      return attribution;
    }
  }
  return undefined;
}

type TrackedEntry = { attribution: AiToolAttribution; at: number; seq: number };

/**
 * `onDidExecuteCommand` is not yet reflected in @types/vscode (it's a VS Code
 * proposed API that was later stabilised). We access it via a safe runtime cast
 * so the code compiles without errors and degrades gracefully on older hosts.
 */
type CommandsWithOnExecute = {
  onDidExecuteCommand?: (
    listener: (e: { command: string }) => void,
  ) => { dispose(): void };
};

/**
 * Subscribes to `vscode.commands.onDidExecuteCommand` (when available) and
 * tracks the most recently seen AI tool per tool name. Cursor IDE is also
 * detected via the `CURSOR_TRACE_ID` / `CURSOR_SESSION_ID` environment
 * variables, which are set by the Cursor IDE process.
 */
export class AiToolTracker implements vscode.Disposable {
  private readonly _lastSeen = new Map<string, TrackedEntry>();
  private _commandSub?: { dispose(): void };
  private _seq = 0;

  constructor() {
    if (process.env["CURSOR_TRACE_ID"] || process.env["CURSOR_SESSION_ID"]) {
      this._lastSeen.set("cursor", {
        attribution: { aiTool: "cursor", link: "https://cursor.sh" },
        at: Date.now(),
        seq: ++this._seq,
      });
    }
  }

  /**
   * Start listening for AI tool commands.
   * Call once during extension activation.
   */
  start(): void {
    const cmds = vscode.commands as unknown as CommandsWithOnExecute;
    if (typeof cmds.onDidExecuteCommand === "function") {
      this._commandSub = cmds.onDidExecuteCommand((event) => {
        const attribution = resolveCommandAttribution(event.command);
        if (attribution) {
          this._lastSeen.set(attribution.aiTool, {
            attribution,
            at: Date.now(),
            seq: ++this._seq,
          });
        }
      });
    }
  }

  /**
   * Returns the attribution for the AI tool whose command was executed most
   * recently, provided that execution happened within `windowMs` milliseconds
   * of now (exclusive boundary). Returns `undefined` if nothing was seen
   * within the window.
   *
   * Ties in wall-clock time are broken by insertion sequence, so the last
   * command that actually fired always wins.
   */
  getMostRecentWithin(windowMs: number): AiToolAttribution | undefined {
    const cutoff = Date.now() - windowMs;
    let best: TrackedEntry | undefined;
    for (const entry of this._lastSeen.values()) {
      if (entry.at > cutoff) {
        if (!best || entry.seq > best.seq) {
          best = entry;
        }
      }
    }
    return best?.attribution;
  }

  dispose(): void {
    this._commandSub?.dispose();
  }
}
