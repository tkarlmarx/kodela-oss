// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Streaming diff API for incremental / progressive processing.
 *
 * `streamDiff` is an async generator that computes the full diff once (the
 * Myers O(ND) algorithm requires both sides to be present) and then yields
 * each hunk in sorted line-order, releasing the event loop between chunks via
 * `setImmediate`.  This lets callers begin processing and displaying results
 * before the full hunk list has been consumed, and keeps the event loop
 * responsive when handling large files.
 *
 * Usage:
 *
 *   for await (const event of streamDiff({ oldContent, newContent })) {
 *     if (event.type === "hunk") renderHunk(event.hunk);
 *     else               updateStats(event.stats);
 *   }
 */

import { computeRawChanges } from "./diff.js";
import { postprocess } from "./postprocess.js";
import type { DiffHunk, DiffInput, DiffOptions, DiffStats } from "./types.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Options for `streamDiff`.  All `DiffOptions` fields are inherited plus the
 * two streaming-specific controls below.
 */
export type StreamDiffOptions = DiffOptions & {
  /**
   * Number of hunks to yield per event-loop tick.
   * Default: `1` (maximally fine-grained yielding).
   * Increase to reduce scheduling overhead for large diffs.
   */
  chunkSize?: number;

  /**
   * When `true`, a final `{ type: "stats" }` event is emitted after all hunks.
   * Default: `true`.
   */
  yieldStats?: boolean;
};

/** A single hunk emitted during the stream. */
export type StreamHunkEvent = {
  type: "hunk";
  hunk: DiffHunk;
};

/** Final summary emitted after all hunks when `yieldStats` is enabled. */
export type StreamStatsEvent = {
  type: "stats";
  stats: DiffStats;
};

export type StreamDiffEvent = StreamHunkEvent | StreamStatsEvent;

// ─── Implementation ───────────────────────────────────────────────────────────

const DEFAULT_LARGE_FILE_THRESHOLD = 10_000;

/**
 * Async generator that streams diff hunks in sorted line order.
 *
 * The underlying diff computation is synchronous (Myers requires the full
 * input), but results are yielded incrementally so callers can pipeline
 * processing without waiting for the entire hunk list.
 *
 * Between each chunk of `chunkSize` hunks, the generator awaits a
 * `setImmediate` tick so other pending microtasks and I/O callbacks can run.
 *
 * @param input   - `{ oldContent, newContent }` raw strings
 * @param options - optional tuning for diff behaviour and streaming batch size
 */
export async function* streamDiff(
  input: DiffInput,
  options?: StreamDiffOptions,
): AsyncGenerator<StreamDiffEvent> {
  const ignoreWhitespace = options?.ignoreWhitespace ?? false;
  const largeFileThreshold =
    options?.largeFileThreshold ?? DEFAULT_LARGE_FILE_THRESHOLD;
  const fuzzyMoveThreshold = options?.fuzzyMoveThreshold ?? 1.0;
  const chunkSize = Math.max(1, options?.chunkSize ?? 1);
  const yieldStats = options?.yieldStats ?? true;

  const splitLines = (content: string): string[] =>
    content.length === 0 ? [] : content.split("\n");

  const oldLines = splitLines(input.oldContent);
  const newLines = splitLines(input.newContent);

  const compareOld = ignoreWhitespace
    ? oldLines.map((l) => l.trim())
    : oldLines;
  const compareNew = ignoreWhitespace
    ? newLines.map((l) => l.trim())
    : newLines;

  const rawChanges = computeRawChanges(
    compareOld,
    compareNew,
    largeFileThreshold,
  );
  const result = postprocess(
    rawChanges,
    oldLines,
    newLines,
    ignoreWhitespace,
    fuzzyMoveThreshold,
  );

  const allHunks: DiffHunk[] = [
    ...result.added,
    ...result.removed,
    ...result.modified,
    ...result.moved,
  ].sort((a, b) => {
    const aLine = a.newRange?.[0] ?? a.oldRange?.[0] ?? 0;
    const bLine = b.newRange?.[0] ?? b.oldRange?.[0] ?? 0;
    return aLine - bLine;
  });

  for (let i = 0; i < allHunks.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, allHunks.length);
    for (let j = i; j < end; j++) {
      yield { type: "hunk", hunk: allHunks[j]! };
    }

    if (end < allHunks.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  if (yieldStats) {
    yield { type: "stats", stats: result.stats };
  }
}

// ─── Convenience collector ────────────────────────────────────────────────────

/**
 * Collect all events from a `streamDiff` call into a plain array.
 * Useful for tests and one-shot callers that want the streaming shape
 * without managing the generator manually.
 */
export async function collectStreamDiff(
  input: DiffInput,
  options?: StreamDiffOptions,
): Promise<StreamDiffEvent[]> {
  const events: StreamDiffEvent[] = [];
  for await (const event of streamDiff(input, options)) {
    events.push(event);
  }
  return events;
}
