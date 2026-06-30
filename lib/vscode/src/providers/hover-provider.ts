// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import * as vscode from "vscode";
import { createHash } from "node:crypto";
import type { KodelaWorkspace } from "../workspace/kodela-workspace.js";
export { buildHoverMarkdown } from "./hover-utils.js";
import { buildHoverMarkdown } from "./hover-utils.js";
import { LinkStatusCache } from "./link-status-cache.js";
import type { LinkStatus } from "./link-status-cache.js";
import type { TelemetryService } from "../telemetry/telemetry-service.js";
import type { ContextEntry } from "@kodela/core";

/**
 * Gap 16 — Line-number drift detection.
 *
 * Computes the SHA-256 hash of the normalised content at `entry.lineRange`
 * in the current document and compares it to the stored `entry.contentHash`.
 *
 * Uses the same normalisation as `@kodela/core hashTokenStream`:
 *   - collapse runs of whitespace to a single space
 *   - strip leading/trailing whitespace from the whole slice
 *
 * Returns `true` when the content has changed (i.e. lines have drifted).
 */
function hasLineDrifted(entry: ContextEntry, documentLines: string[]): boolean {
  const { start, end } = entry.lineRange;
  const totalLines = documentLines.length;

  if (start > totalLines) {
    return true;
  }

  const slice = documentLines.slice(start - 1, end).join("\n");
  const normalized = slice.replace(/\s+/g, " ").trim();
  const currentHash = createHash("sha256").update(normalized, "utf-8").digest("hex");
  return currentHash !== entry.contentHash;
}

export class KodelaHoverProvider implements vscode.HoverProvider, vscode.Disposable {
  private readonly _disposables: vscode.Disposable[] = [];
  /** Gap 18 — background URL liveness cache shared across all hover calls. */
  private readonly _linkCache: LinkStatusCache;

  constructor(
    private readonly _workspace: KodelaWorkspace,
    private readonly _telemetry?: TelemetryService,
  ) {
    this._linkCache = new LinkStatusCache();
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | null {
    const cfg = vscode.workspace.getConfiguration("kodela");
    if (!cfg.get<boolean>("enable", true)) return null;

    const entries = this._workspace.getEntriesForFile(document.uri.fsPath);
    const lineNum = position.line + 1;
    const isAIChanged = this._workspace.isFileLikelyAIChanged(document.uri.fsPath);

    // Gap 18 — fire non-blocking background HEAD checks for all entry links
    // and collect whatever cached status is already available.  On the first
    // hover the status is "unknown" (optimistic ✅); on subsequent hovers
    // after the check completes the correct badge is shown.
    const linkStatusMap = new Map<string, LinkStatus>();
    for (const e of entries) {
      if (e.link) {
        this._linkCache.startCheck(e.link);
        linkStatusMap.set(e.link, this._linkCache.get(e.link));
      }
    }

    // Gap 16 — compute drift detection: compare stored contentHash against
    // the current document content at each entry's lineRange.
    const documentLines = document.getText().split("\n");
    const driftedEntryIds = new Set<string>();
    for (const e of entries) {
      if (hasLineDrifted(e, documentLines)) {
        driftedEntryIds.add(e.id);
      }
    }

    const markdown = buildHoverMarkdown(entries, lineNum, isAIChanged, linkStatusMap, driftedEntryIds);
    if (!markdown) return null;

    // Gap 21 — hover_viewed telemetry: emit once per matched entry (no PII).
    const now = Date.now();
    const matchedEntries = entries.filter(
      (e) => e.lineRange.start <= lineNum && lineNum <= e.lineRange.end,
    );
    for (const e of matchedEntries) {
      const ageMs = now - new Date(e.createdAt).getTime();
      void this._telemetry?.emitHoverViewed(ageMs, !!e.link);
    }

    const md = new vscode.MarkdownString(markdown);
    return new vscode.Hover(md);
  }

  dispose(): void {
    this._linkCache.dispose();
    for (const d of this._disposables) d.dispose();
  }
}
