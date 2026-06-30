// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 21 — Telemetry storage: append-only JSONL writer + reader.
 *
 * File: `<repoRoot>/.kodela/telemetry.jsonl`
 *
 * Lines that fail Zod validation are silently skipped by `readTelemetryEvents`
 * so that old schema versions or corrupted lines never crash the reader.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  TelemetryEventSchema,
  TELEMETRY_SCHEMA_VERSION,
} from "./telemetry-schema.js";
import type { TelemetryEvent, TelemetryEventType } from "./telemetry-schema.js";

const TELEMETRY_FILE = "telemetry.jsonl";
const KODELA_DIR = ".kodela";

function telemetryPath(repoRoot: string): string {
  return path.join(repoRoot, KODELA_DIR, TELEMETRY_FILE);
}

/**
 * Appends one telemetry event to `.kodela/telemetry.jsonl`.
 * Silently does nothing when the `.kodela/` directory does not exist
 * (i.e. when called outside a Kodela repo — avoids spurious writes in tests).
 */
export async function appendTelemetryEvent(
  repoRoot: string,
  event: TelemetryEvent,
): Promise<void> {
  const dir = path.join(repoRoot, KODELA_DIR);
  try {
    await fs.access(dir);
  } catch {
    return; // no .kodela dir — not a Kodela repo, skip silently
  }

  const line = JSON.stringify({ ...event, schemaVersion: TELEMETRY_SCHEMA_VERSION });
  await fs.appendFile(telemetryPath(repoRoot), line + "\n", "utf-8");
}

export type ReadTelemetryOptions = {
  /** Only return events of these types. Omit to return all. */
  types?: TelemetryEventType[];
  /**
   * Only return events with `timestamp >= afterMs`.
   * Provide as a Unix timestamp in milliseconds.
   */
  afterMs?: number;
};

/**
 * Reads and parses `.kodela/telemetry.jsonl`.
 * Returns an empty array when the file does not exist.
 * Lines that fail Zod validation are silently skipped.
 */
export async function readTelemetryEvents(
  repoRoot: string,
  opts: ReadTelemetryOptions = {},
): Promise<TelemetryEvent[]> {
  const p = telemetryPath(repoRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf-8");
  } catch {
    return [];
  }

  const events: TelemetryEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const result = TelemetryEventSchema.safeParse(parsed);
    if (!result.success) continue;

    const event = result.data;

    if (opts.types && opts.types.length > 0 && !opts.types.includes(event.type)) {
      continue;
    }

    if (opts.afterMs !== undefined) {
      const ts = new Date(event.timestamp).getTime();
      if (ts < opts.afterMs) continue;
    }

    events.push(event);
  }

  return events;
}

/**
 * Returns the total number of raw lines in the telemetry file (including
 * blank lines and malformed lines).  Useful for estimating log file size.
 * Returns 0 when the file does not exist.
 */
export async function countTelemetryLines(repoRoot: string): Promise<number> {
  const p = telemetryPath(repoRoot);
  try {
    const raw = await fs.readFile(p, "utf-8");
    return raw.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}
