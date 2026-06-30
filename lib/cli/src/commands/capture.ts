// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 104 — `kodela capture` command.
 *
 * Shell-level wrapper around `ingestAIContext()` for tools that cannot
 * call the Node.js SDK directly.  Accepts file path, line range, AI tool
 * name, and optional metadata via CLI flags, then writes a trusted
 * deterministic ContextEntry to `.kodela/objects/`.
 *
 * Examples:
 *   kodela capture --file src/auth/session.ts --start 1 --end 72 \
 *                  --tool replit-agent \
 *                  --intent "Add Replit context helpers for AI attribution"
 *
 *   kodela capture --file lib/core/src/env/replit-context.ts \
 *                  --start 1 --end 72 \
 *                  --tool replit-agent \
 *                  --session a0507424 \
 *                  --diff "$(git diff HEAD -- lib/core/src/env/replit-context.ts)"
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ingestAIContext } from "@kodela/core";
import type { AIContextInput } from "@kodela/core";
import { findRepoRoot } from "../utils/repo.js";

export interface CaptureOptions {
  file: string;
  start: number;
  end: number;
  tool: string;
  model?: string;
  session?: string;
  intent?: string;
  diff?: string;
  diffFile?: string;
  linesAdded?: number;
  linesRemoved?: number;
  author?: string;
  json?: boolean;
}

export interface CaptureResult {
  entryId: string;
  filePath: string;
  lineRange: { start: number; end: number };
  trustLevel: string;
  ingestion: string;
}

export async function runCapture(
  opts: CaptureOptions,
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<CaptureResult> {
  const repoRoot = await findRepoRoot(process.cwd());
  const normalizedPath = opts.file.replace(/\\/g, "/").replace(/^\.\//, "");
  const absolutePath = path.resolve(repoRoot, normalizedPath);

  // Resolve diff string: prefer --diff flag, fall back to --diff-file.
  let diff: string | undefined = opts.diff;
  if (!diff && opts.diffFile) {
    try {
      diff = await fs.readFile(opts.diffFile, "utf-8");
    } catch {
      // non-fatal — skip diff
    }
  }

  // Read full file content for fingerprinting (best-effort).
  let fileContent: string | undefined;
  try {
    fileContent = await fs.readFile(absolutePath, "utf-8");
  } catch {
    // non-fatal — fingerprint will be skipped
  }

  const input: AIContextInput = {
    filePath: normalizedPath,
    lineRange: { start: opts.start, end: opts.end },
    aiTool: opts.tool,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.session ? { sessionId: opts.session } : {}),
    ...(opts.intent ? { intent: opts.intent } : {}),
    ...(diff ? { diff } : {}),
    ...(fileContent ? { fileContent } : {}),
    ...(opts.linesAdded !== undefined ? { linesAdded: opts.linesAdded } : {}),
    ...(opts.linesRemoved !== undefined ? { linesRemoved: opts.linesRemoved } : {}),
    ...(opts.author ? { author: opts.author } : {}),
  };

  const entry = await ingestAIContext(repoRoot, input);

  const result: CaptureResult = {
    entryId: entry.id,
    filePath: entry.filePath,
    lineRange: entry.lineRange,
    trustLevel: entry.trustLevel ?? "high",
    ingestion: entry.ingestion ?? "deterministic",
  };

  if (opts.json) {
    stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    stdout.write(
      `[capture] Created entry ${entry.id.slice(0, 8)}… ` +
      `(${normalizedPath} L${opts.start}–${opts.end}, ` +
      `tool=${opts.tool}, trust=${result.trustLevel}, ` +
      `ingestion=${result.ingestion})\n`,
    );
  }

  return result;
}
