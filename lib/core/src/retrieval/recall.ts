// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Recall formatting (Phase 1 — automatic recall injection).
 *
 * "Recall" is reranked retrieval packaged for *injection*: when a developer (or
 * an agent at task start) asks "what do we already know about X?", Kodela
 * returns the most relevant prior *why* as a ready-to-paste context block. The
 * ranking comes from the Phase-0 reranker; this module only turns ranked hits
 * into a clean, token-frugal markdown block — pure, no I/O — so the CLI and the
 * MCP tool render recall identically.
 */

export interface RecallItem {
  /** A human-readable reference, e.g. `src/auth/session.ts:5-7` or a decision id. */
  ref: string;
  /** The captured note / decision text. */
  note: string;
  /** Blended relevance in [0,1], if available. */
  score?: number;
  /** Optional tags for a compact trailer. */
  tags?: string[];
}

export interface RecallBlockOptions {
  /** Max characters of each note to show (keeps the block token-frugal). */
  noteMax?: number;
  /** Show the numeric relevance score. Default true. */
  showScore?: boolean;
  heading?: string;
}

/**
 * Render ranked recall items as an injectable markdown block. Returns a short
 * "nothing found" note (not an empty string) so an agent gets an explicit
 * signal rather than silence.
 */
export function formatRecallBlock(
  query: string,
  items: RecallItem[],
  opts: RecallBlockOptions = {},
): string {
  const noteMax = opts.noteMax ?? 240;
  const showScore = opts.showScore ?? true;
  const heading = opts.heading ?? `## Relevant prior context for "${query}"`;

  if (items.length === 0) {
    return `${heading}\n\n_No prior context captured for this yet._\n`;
  }

  const lines = items.map((it, i) => {
    const note = it.note.length > noteMax ? `${it.note.slice(0, noteMax).trimEnd()}…` : it.note;
    const score = showScore && typeof it.score === "number" ? `  _(relevance ${it.score.toFixed(2)})_` : "";
    const tags = it.tags && it.tags.length ? `  [${it.tags.join(", ")}]` : "";
    return `${i + 1}. **${it.ref}**${tags} — ${note}${score}`;
  });

  return (
    `${heading}\n\n` +
    `_Kodela recalled ${items.length} prior item${items.length === 1 ? "" : "s"} (most relevant first):_\n\n` +
    `${lines.join("\n")}\n`
  );
}
