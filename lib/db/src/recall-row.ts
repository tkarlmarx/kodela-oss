// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { RecallEntryRow } from "./storage.js";

/** Columns both adapters SELECT for a recall row (before payload enrichment). */
export interface RecallRowBase {
  id: string;
  filePath: string;
  note: string;
  severity: string;
  status: string;
  source: string;
  confidence: number;
  sessionId: string | null;
  createdAt: string;
  /** Raw `payload` JSON (the full ContextEntry) — source of tags + lineRange. */
  payload: string;
}

/**
 * Reconstruct a RecallEntryRow from the stored columns + the `payload` JSON.
 * `tags` and `lineRange` only live in the payload, so we parse it; a malformed
 * payload degrades to safe defaults (empty tags, 0-0 range) rather than throwing
 * — one bad row must never break a whole recall query. Shared by both adapters
 * so the shape is identical regardless of backend.
 */
export function toRecallRow(base: RecallRowBase): RecallEntryRow {
  let tags: string[] = [];
  let lineRange = { start: 0, end: 0 };
  let note = base.note;
  try {
    const parsed = JSON.parse(base.payload) as {
      tags?: unknown;
      lineRange?: { start?: unknown; end?: unknown };
      note?: unknown;
    };
    if (Array.isArray(parsed.tags)) {
      tags = parsed.tags.filter((t): t is string => typeof t === "string");
    }
    if (parsed.lineRange && typeof parsed.lineRange === "object") {
      const s = Number(parsed.lineRange.start);
      const e = Number(parsed.lineRange.end);
      lineRange = {
        start: Number.isFinite(s) ? s : 0,
        end: Number.isFinite(e) ? e : 0,
      };
    }
    // Prefer the payload note if the column was somehow empty.
    if (!note && typeof parsed.note === "string") note = parsed.note;
  } catch {
    /* malformed payload — keep defaults */
  }

  return {
    id: base.id,
    filePath: base.filePath,
    note,
    tags,
    severity: base.severity,
    status: base.status,
    source: base.source,
    confidence: base.confidence,
    sessionId: base.sessionId,
    lineRange,
    createdAt: base.createdAt,
  };
}
