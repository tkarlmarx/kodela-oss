// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  writeContextEntry,
  hashTokenStream,
  readIndex,
  readContextEntry,
  loadLicense,
  licenseHasFeature,
  SCHEMA_VERSION,
} from "@kodela/core";
import type { ContextEntry, Origin } from "@kodela/core";
import { detectAiCommits } from "../ai-detection/detect.js";
import { tryRunGit } from "../utils/exec.js";
import type { KodelaConfig } from "../config/schema.js";
import { recordCliEvent } from "../audit/recordCliEvent.js";
import { buildMatchers } from "../utils/pattern-matcher.js";
import { scheduleExtraction } from "../hooks/queue.js";

/**
 * Gap 80 — Retrieve the diff for a specific file in a commit as a string.
 *
 * Used to populate the extraction queue so retroactive stubs receive the same
 * AI intent inference as live-captured entries (Gap 79).  Returns an empty
 * string when git is unavailable or the file was not changed in that commit.
 */
async function getCommitDiff(
  repoRoot: string,
  sha: string,
  filePath: string,
): Promise<string> {
  const result = await tryRunGit(
    ["show", "--unified=3", "--format=", sha, "--", filePath],
    repoRoot,
  );
  return result?.stdout?.trim() ?? "";
}

export type RetroactiveOptions = {
  repoRoot: string;
  since?: string;
  limit?: number;
  dryRun?: boolean;
  force?: boolean;
  /**
   * Maximum number of files to process per flagged commit.  Keeps the total
   * stub count predictable for large AI-heavy repos.  Default: 5.
   */
  maxFilesPerCommit?: number;
  /**
   * When true, skip the "N stubs — re-run with --yes" confirmation gate and
   * write all stubs immediately.  Has no effect when `dryRun` is true.
   */
  yes?: boolean;
  config: KodelaConfig;
};

export type RetroactiveStub = {
  filePath: string;
  commitSha: string;
  entryId: string;
};

export type RetroactiveResult = {
  scanned: number;
  flagged: number;
  skipped: number;
  created: number;
  stubs: RetroactiveStub[];
  dryRun: boolean;
  licenseWarning?: string;
  /**
   * Set to true when the total candidate count exceeded 20 and neither
   * `--yes` nor `--dry-run` was given.  No stubs are written in this case.
   * `pendingCount` holds the number of stubs that would have been created.
   */
  needsConfirmation?: boolean;
  pendingCount?: number;
};

/**
 * Pure helper — exported for unit testing.
 *
 * Given the raw changed-file list from one commit, returns the subset that
 * should be queued as candidates, applying in order:
 *   1. Alphabetical sort  → deterministic per-commit cap.
 *   2. Per-commit cap     → at most `maxFilesPerCommit` paths returned.
 *   3. Cross-commit dedup → skips paths already in `seenPaths` (mutated).
 *   4. Existing-file skip → when `force` is false, skips already-annotated.
 *
 * `.kodela/` filtering and ignore-pattern filtering must be applied by the
 * caller before passing `changedFiles`.
 */
export function pickFilesFromCommit(
  changedFiles: string[],
  opts: {
    maxFilesPerCommit: number;
    seenPaths: Set<string>;
    existingFiles: Set<string>;
    force: boolean;
  },
): string[] {
  const sorted = [...changedFiles].sort();
  const picked: string[] = [];
  for (const raw of sorted) {
    if (picked.length >= opts.maxFilesPerCommit) break;
    const p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!opts.force && opts.existingFiles.has(p)) continue;
    if (!opts.force && opts.seenPaths.has(p)) continue;
    opts.seenPaths.add(p);
    picked.push(p);
  }
  return picked;
}

async function getFilesChangedInCommit(
  sha: string,
  repoRoot: string,
): Promise<string[]> {
  const result = await tryRunGit(
    ["show", "--name-only", "--format=", sha],
    repoRoot,
  );
  if (!result) return [];
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

async function getLineCount(
  repoRoot: string,
  filePath: string,
): Promise<number> {
  try {
    const content = await fs.readFile(
      path.join(repoRoot, filePath),
      "utf-8",
    );
    return Math.max(1, content.split("\n").length);
  } catch {
    return 1;
  }
}

async function computeContentHash(
  repoRoot: string,
  filePath: string,
  lineEnd: number,
): Promise<string> {
  try {
    const content = await fs.readFile(
      path.join(repoRoot, filePath),
      "utf-8",
    );
    const lines = content.split("\n");
    const slice = lines.slice(0, lineEnd).join("\n");
    return hashTokenStream(slice);
  } catch {
    return crypto
      .createHash("sha256")
      .update(filePath)
      .digest("hex");
  }
}

/**
 * Attempt to extract an AI tool name from commit signals.
 * Returns the first pattern that looks like a known AI tool.
 */
function extractToolFromReasons(reasons: string[]): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/copilot/i, "copilot"],
    [/chatgpt|gpt/i, "chatgpt"],
    [/claude/i, "claude"],
    [/gemini/i, "gemini"],
    [/codeium/i, "codeium"],
    [/tabnine/i, "tabnine"],
  ];
  for (const reason of reasons) {
    for (const [re, name] of patterns) {
      if (re.test(reason)) return name;
    }
  }
  return undefined;
}

export async function runRetroactive(
  opts: RetroactiveOptions,
): Promise<RetroactiveResult> {
  const {
    repoRoot,
    since,
    limit = 50,
    dryRun = false,
    force = false,
    maxFilesPerCommit = 5,
    yes = false,
    config,
  } = opts;

  let licenseWarning: string | undefined;
  const license = await loadLicense(repoRoot);
  if (!licenseHasFeature(license, "retroactive_scan")) {
    // Gap 80 — reframe as informational, not a blocking error.
    // Stubs are written locally on all license tiers; Enterprise adds remote sync.
    licenseWarning =
      "Remote sync requires an Enterprise license and is disabled on this tier. " +
      "Stubs are being written to .kodela/objects/ and will be visible locally. " +
      "Upgrade at https://kodela.dev/pricing#enterprise";
  }

  const detection = await detectAiCommits(
    repoRoot,
    config,
    since ?? (limit ? undefined : undefined),
  );

  const limitedSignals = detection.signals.slice(0, limit);

  if (limitedSignals.length === 0) {
    return {
      scanned: detection.scanned,
      flagged: detection.flagged,
      skipped: 0,
      created: 0,
      stubs: [],
      dryRun,
      licenseWarning,
    };
  }

  const index = await readIndex(repoRoot).catch(() => ({ entries: [] as string[] }));
  const existingEntries = await Promise.all(
    index.entries.map((id) => readContextEntry(repoRoot, id).catch(() => null)),
  );
  const existingFiles = new Set(
    existingEntries.filter(Boolean).map((e) => e!.filePath),
  );

  // Build ignore matchers from baseline.ignore_patterns so that generated
  // files, lock files, and other non-source paths are skipped the same way
  // the watcher skips them.
  const ignorePatterns: string[] = config.baseline?.ignore_patterns ?? [];
  const ignoreMatchers = buildMatchers(repoRoot, ignorePatterns);

  const now = new Date().toISOString();
  const actor =
    process.env["KODELA_AUTHOR"] ??
    process.env["GIT_AUTHOR_NAME"] ??
    "kodela-retroactive";

  const captureReasoning = config.origin.capture_reasoning;

  // ---------------------------------------------------------------------------
  // Phase 1: collect candidates (with per-commit cap and ignore filtering).
  // We do this before writing so we can apply the confirmation gate.
  // ---------------------------------------------------------------------------
  type Candidate = {
    normalizedPath: string;
    signal: (typeof limitedSignals)[number];
  };

  const candidates: Candidate[] = [];
  let skipped = 0;
  // Track every file path already queued in this run so the same file is not
  // queued from multiple flagged commits (when --force is false).
  const seenPaths = new Set<string>();

  for (const signal of limitedSignals) {
    const fullShaResult = await tryRunGit(
      ["rev-parse", signal.commit],
      repoRoot,
    );
    const fullSha = fullShaResult?.stdout?.trim() ?? signal.commit;

    const changedFiles = await getFilesChangedInCommit(fullSha, repoRoot);

    // Pre-filter: strip .kodela/ paths and ignore-pattern matches before
    // handing the list to the pure helper (which handles sort, cap, dedupe).
    const preFiltered: string[] = [];
    for (const filePath of changedFiles) {
      const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
      if (normalized.startsWith(".kodela/")) continue;
      const absPath = path.join(repoRoot, normalized);
      if (ignoreMatchers.some((fn) => fn(absPath))) continue;
      // Count skips for already-annotated files before handing off.
      if (!force && existingFiles.has(normalized)) {
        skipped++;
        continue;
      }
      preFiltered.push(normalized);
    }

    // pickFilesFromCommit sorts alphabetically, applies the per-commit cap,
    // and dedupes across commits via the shared seenPaths set.
    const picked = pickFilesFromCommit(preFiltered, {
      maxFilesPerCommit,
      seenPaths,
      existingFiles,
      force,
    });

    for (const normalizedPath of picked) {
      candidates.push({ normalizedPath, signal });
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 2: confirmation gate.
  // If there are more than 20 candidates and the user hasn't confirmed with
  // --yes (and it's not a dry-run), stop here and ask for confirmation.
  // ---------------------------------------------------------------------------
  const CONFIRM_THRESHOLD = 20;
  if (!dryRun && !yes && candidates.length > CONFIRM_THRESHOLD) {
    return {
      scanned: detection.scanned,
      flagged: limitedSignals.length,
      skipped,
      created: 0,
      stubs: [],
      dryRun,
      licenseWarning,
      needsConfirmation: true,
      pendingCount: candidates.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 3: write stubs for all confirmed candidates.
  // ---------------------------------------------------------------------------
  const stubs: RetroactiveStub[] = [];

  for (const { normalizedPath, signal } of candidates) {
    const lineEnd = await getLineCount(repoRoot, normalizedPath);
    const contentHash = await computeContentHash(
      repoRoot,
      normalizedPath,
      lineEnd,
    );

    const reasonSummary = signal.reasons.slice(0, 2).join("; ");
    const note =
      `Retroactive AI annotation stub — commit ${signal.commit} ` +
      `by ${signal.author}: "${signal.subject}". ` +
      `Signals: ${reasonSummary}. Review and update this annotation.`;

    // Gap 13 — populate origin block from commit detection signals.
    // summary: why this commit was flagged as AI-generated.
    // reasoning: the individual signal reasons from the detector.
    // tool: extracted from the signal reasons where recognisable.
    const detectedTool = extractToolFromReasons(signal.reasons);
    const origin: Origin = {
      type: "ai",
      summary:
        `Flagged as likely AI-generated. Commit by ${signal.author}: ` +
        `"${signal.subject}". ` +
        `Detection signals: ${reasonSummary}.`,
      ...(captureReasoning && signal.reasons.length > 0
        ? { reasoning: signal.reasons }
        : {}),
      tool: detectedTool ?? "retroactive-scan",
    };

    const entry: ContextEntry = {
      schemaVersion: SCHEMA_VERSION,
      id: crypto.randomUUID(),
      filePath: normalizedPath,
      astAnchor: null,
      contentHash,
      lineRange: { start: 1, end: lineEnd },
      note,
      author: actor,
      createdAt: now,
      updatedAt: now,
      severity: "low",
      tags: ["ai", "retroactive-stub"],
      source: "ai",
      aiTool: detectedTool ?? "retroactive-scan",
      confidence: 0.5,
      status: "uncertain",
      reviewRequired: true,
      origin,
    };

    if (!dryRun) {
      await writeContextEntry(repoRoot, entry);
      existingFiles.add(normalizedPath);

      // Gap 80 — enqueue this stub for AI intent inference so the next
      // `kodela heal` run (Gap 79, Step 4) can replace the generic stub note
      // with a meaningful description of what the commit was doing.
      // The commit diff is fetched now while we have the SHA at hand; by the
      // time the queue is drained the file may have changed again.
      const commitDiff = await getCommitDiff(repoRoot, signal.commit, normalizedPath)
        .catch(() => "");
      void scheduleExtraction(repoRoot, entry, { diff: commitDiff });
    }

    stubs.push({
      filePath: normalizedPath,
      commitSha: signal.commit,
      entryId: entry.id,
    });
  }

  if (!dryRun && license?.orgId) {
    for (const stub of stubs) {
      void recordCliEvent(
        {
          eventType: "context_added",
          actor,
          orgId: license.orgId,
          filePath: stub.filePath,
          entryId: stub.entryId,
          metadata: {
            source: "ai",
            severity: "low",
            retroactive: true,
            commitSha: stub.commitSha,
          },
        },
        repoRoot,
      );
    }
  }

  return {
    scanned: detection.scanned,
    flagged: limitedSignals.length,
    skipped,
    created: stubs.length,
    stubs,
    dryRun,
    licenseWarning,
  };
}

export function formatRetroactiveResult(
  result: RetroactiveResult,
): string {
  const lines: string[] = [];
  const prefix = result.dryRun ? "[DRY RUN] " : "";

  if (result.licenseWarning) {
    // Gap 80 — use ℹ (informational) instead of ⚠ so the message does not
    // look like a blocking error that stops the developer from proceeding.
    lines.push(`ℹ  ${result.licenseWarning}`);
    lines.push("");
  }

  if (result.needsConfirmation) {
    lines.push(
      `Will create ${result.pendingCount} stubs. Re-run with --yes to confirm.`,
    );
    return lines.join("\n");
  }

  if (result.flagged === 0) {
    lines.push(
      `${prefix}No likely-AI commits found in ${result.scanned} scanned. No stubs created.`,
    );
    return lines.join("\n");
  }

  lines.push(
    `${prefix}Scanned ${result.scanned} commit(s), flagged ${result.flagged} as likely AI-generated.`,
  );
  lines.push(
    `${prefix}Created ${result.created} stub annotation(s), skipped ${result.skipped} already-annotated file(s).`,
  );

  if (result.stubs.length > 0) {
    lines.push("");
    lines.push("Stubs created:");
    for (const stub of result.stubs) {
      lines.push(`  ${stub.filePath}  (commit ${stub.commitSha})`);
    }
  }

  if (result.dryRun) {
    lines.push("");
    lines.push("Run without --dry-run to write stubs.");
  }

  return lines.join("\n");
}
