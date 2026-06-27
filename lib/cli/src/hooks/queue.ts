// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 53 — Extraction Queue
 *
 * Bridges the Gap 52 hook processor and the Gap 53 reasoning extractor.
 *
 * When a PostToolUse event creates a new ContextEntry, `scheduleExtraction`
 * appends a job to `.kodela/extraction-queue.jsonl`. The queue is drained by
 * `drainExtractionQueue`, which processes up to `limit` entries per
 * invocation (default: 3) to avoid blocking the developer workflow during
 * a hook call.
 *
 * Stale queue entries (older than 24 hours) are processed during the next
 * `kodela heal` run instead of the hook call.
 *
 * Error handling: all failures are swallowed and written to
 * `.kodela/hook-errors.log`. The queue must never interrupt the developer.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ContextEntry } from "@kodela/core";
import { readContextEntry, writeContextEntry } from "@kodela/core";
import { readSession } from "@kodela/core/storage";
import type { AiLayerConfig } from "../commands/ai-layer.js";
import { extractReasoning } from "@kodela/core";

const KODELA_DIR = ".kodela";
const QUEUE_FILE = "extraction-queue.jsonl";
const ERRORS_FILE = "hook-errors.log";
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_DRAIN_LIMIT = 3;

export type ExtractionQueueEntry = {
  entryId: string;
  filePath: string;
  diff?: string;
  sessionId?: string;
  queuedAt: string;
};

function queueFilePath(repoRoot: string): string {
  return path.join(repoRoot, KODELA_DIR, QUEUE_FILE);
}

function errorsFilePath(repoRoot: string): string {
  return path.join(repoRoot, KODELA_DIR, ERRORS_FILE);
}

async function appendError(repoRoot: string, message: string): Promise<void> {
  try {
    const line = `${new Date().toISOString()} ERROR ${message}\n`;
    await fs.appendFile(errorsFilePath(repoRoot), line, "utf-8");
  } catch {
    // truly last resort — nothing we can do
  }
}

/**
 * Append an extraction job to `.kodela/extraction-queue.jsonl`.
 *
 * Creates the KODELA_DIR if it does not exist. Silently swallows errors so
 * that a missing `.kodela/` directory or I/O failure never interrupts the
 * hook handler.
 */
export async function scheduleExtraction(
  repoRoot: string,
  entry: Pick<ContextEntry, "id" | "filePath">,
  opts: { diff?: string; sessionId?: string } = {},
): Promise<void> {
  try {
    await fs.mkdir(path.join(repoRoot, KODELA_DIR), { recursive: true });
    const job: ExtractionQueueEntry = {
      entryId: entry.id,
      filePath: entry.filePath,
      diff: opts.diff,
      sessionId: opts.sessionId,
      queuedAt: new Date().toISOString(),
    };
    await fs.appendFile(queueFilePath(repoRoot), JSON.stringify(job) + "\n", "utf-8");
  } catch (err) {
    await appendError(
      repoRoot,
      `scheduleExtraction failed for entry ${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read all pending queue entries from `.kodela/extraction-queue.jsonl`.
 * Returns an empty array if the file does not exist.
 */
async function readQueue(repoRoot: string): Promise<ExtractionQueueEntry[]> {
  try {
    const raw = await fs.readFile(queueFilePath(repoRoot), "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as ExtractionQueueEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is ExtractionQueueEntry => e !== null);
  } catch {
    return [];
  }
}

/**
 * Rewrite the queue file with the given entries.
 * If `entries` is empty the file is deleted.
 */
async function writeQueue(
  repoRoot: string,
  entries: ExtractionQueueEntry[],
): Promise<void> {
  if (entries.length === 0) {
    try {
      await fs.unlink(queueFilePath(repoRoot));
    } catch {
      // file may not exist
    }
    return;
  }
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const tmpPath = queueFilePath(repoRoot) + ".tmp";
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, queueFilePath(repoRoot));
}

/**
 * Process up to `limit` entries from the extraction queue.
 *
 * - Entries older than 24 hours are deferred (left in the queue for `kodela heal`).
 * - Processed entries are removed from the queue on success.
 * - Failures are logged to hook-errors.log and the entry is removed (not retried
 *   indefinitely — a stale entry will be retried by `kodela heal`).
 *
 * @param repoRoot   Repository root directory.
 * @param aiConfig   AI provider config (optional — fallback runs without it).
 * @param limit      Max entries to process in this invocation. Default: 3.
 */
export async function drainExtractionQueue(
  repoRoot: string,
  aiConfig?: AiLayerConfig,
  limit = DEFAULT_DRAIN_LIMIT,
): Promise<void> {
  let queue: ExtractionQueueEntry[];
  try {
    queue = await readQueue(repoRoot);
  } catch {
    return;
  }

  if (queue.length === 0) return;

  const now = Date.now();
  const toProcess: ExtractionQueueEntry[] = [];
  const deferred: ExtractionQueueEntry[] = [];
  const remaining: ExtractionQueueEntry[] = [];

  for (const job of queue) {
    const age = now - new Date(job.queuedAt).getTime();
    if (age > STALE_THRESHOLD_MS) {
      // Stale — defer to next heal run
      deferred.push(job);
    } else if (toProcess.length < limit) {
      toProcess.push(job);
    } else {
      remaining.push(job);
    }
  }

  const processed: ExtractionQueueEntry[] = [];
  const failed: ExtractionQueueEntry[] = [];

  for (const job of toProcess) {
    try {
      let entry: ContextEntry;
      try {
        entry = await readContextEntry(repoRoot, job.entryId);
      } catch {
        // Entry may have been deleted — skip
        continue;
      }

      // Look up the session to retrieve the inferred provider hint and model.
      // Errors are silently swallowed — the hint is advisory only.
      let sessionProviderHint: string | undefined;
      let sessionModel: string | undefined;
      if (job.sessionId) {
        try {
          const session = await readSession(repoRoot, job.sessionId);
          sessionProviderHint = session?.providerHint;
          sessionModel = session?.model;
        } catch {
          // Advisory only — proceed without hint
        }
      }

      const reasoning = await extractReasoning(job.filePath, {
        diff: job.diff,
        note: entry.note,
        extractionMethod: "hook",
        aiConfig: aiConfig
          ? {
              provider: aiConfig.provider,
              model: aiConfig.model,
              apiKey: aiConfig.apiKey,
              baseUrl: aiConfig.baseUrl,
            }
          : undefined,
        sessionProviderHint,
        sessionModel,
        existingReasoning: entry.reasoning,
      });

      const updated: ContextEntry = {
        ...entry,
        reasoning,
        updatedAt: new Date().toISOString(),
      };
      await writeContextEntry(repoRoot, updated);
      processed.push(job);
    } catch (err) {
      await appendError(
        repoRoot,
        `drainExtractionQueue failed for entry ${job.entryId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      failed.push(job);
    }
  }

  // Rewrite queue: keep remaining + deferred + failed (for retry by heal)
  // Processed jobs are removed.
  void processed; // consumed — intentionally not kept
  const newQueue = [...remaining, ...deferred, ...failed];
  try {
    await writeQueue(repoRoot, newQueue);
  } catch (err) {
    await appendError(
      repoRoot,
      `Failed to rewrite extraction queue: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
