// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 46 — Bidirectional AI annotation loop.
 *
 * `kodela propose` drafts an AI-generated annotation note for a code range or
 * named function, presents it for human review, and — on acceptance — calls
 * runAdd() to persist a ContextEntry with source: "ai" and reviewRequired: true.
 *
 * Three modes:
 *
 *   kodela propose <file> [--lines <start>-<end>] [--fn <name>] [--accept] [--reject]
 *     Single-file proposal.  Extracts the code, calls the AI, prints the draft.
 *     --accept: non-interactively accept (CI / scripted use).
 *     --reject: non-interactively reject and log telemetry.
 *
 *   kodela propose --repo [--source ai]
 *     Batch mode.  Scans all entries whose note matches the auto-annotate stub
 *     pattern ("Auto-annotated:"), calls propose for each, and writes the
 *     results to .kodela/proposals.json for deferred review.
 *
 *   kodela propose --review
 *     Review mode.  Reads .kodela/proposals.json, prints each pending proposal,
 *     and records the decision (accepts write the entry; rejects discard).
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  readIndex,
  readContextEntry,
  writeContextEntry,
  appendTelemetryEvent,
  SCHEMA_VERSION,
} from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { callForProposal } from "./ai-layer.js";
import type { AiLayerConfig, ProposalConfidence } from "./ai-layer.js";
import { buildAstAnchor, hashTokenStream } from "@kodela/core";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A stub note produced by `kodela watch --auto-annotate`. */
const STUB_NOTE_PREFIX = "Auto-annotated:";

/** Maximum number of lines extracted around a --fn match. */
const FN_CONTEXT_LINES = 80;

/**
 * A single queued proposal written to `.kodela/proposals.json`.
 * Status moves from "pending" → "accepted" | "rejected" via `--review`.
 */
export type ProposalQueueRecord = {
  id: string;
  /** ID of the existing ContextEntry being upgraded (batch mode only). */
  entryId?: string;
  filePath: string;
  lineRange: { start: number; end: number };
  proposedNote: string;
  confidence: ProposalConfidence;
  proposedAt: string;
  status: "pending" | "accepted" | "rejected";
};

// ---------------------------------------------------------------------------
// Options and result types exposed to bin.ts
// ---------------------------------------------------------------------------

export type ProposeOptions = {
  repoRoot: string;
  /** File path for single-file mode. */
  filePath?: string;
  /** 1-indexed start line (single-file mode). */
  lineStart?: number;
  /** 1-indexed end line (single-file mode). */
  lineEnd?: number;
  /** Function / method name to locate in the file (single-file mode). */
  fn?: string;
  /** Non-interactive accept — skip the review prompt. */
  accept?: boolean;
  /** Non-interactive reject — skip the review prompt. */
  reject?: boolean;
  /** Batch mode: scan repo for stub notes. */
  repo?: boolean;
  /** Review mode: work through .kodela/proposals.json interactively. */
  review?: boolean;
  /** Source filter for batch mode. */
  source?: string;
  /** AI layer configuration. */
  aiConfig: AiLayerConfig;
};

export type SingleProposeResult = {
  mode: "single";
  filePath: string;
  lineRange: { start: number; end: number };
  note: string;
  confidence: ProposalConfidence;
  /** What the user (or --accept/--reject flag) decided. */
  decision: "accepted" | "rejected" | "pending";
  /** The persisted entry if accepted. */
  entry?: ContextEntry;
};

export type BatchProposeResult = {
  mode: "batch";
  queued: number;
  skipped: number;
};

export type ReviewResult = {
  mode: "review";
  accepted: number;
  rejected: number;
  remaining: number;
};

export type ProposeResult =
  | SingleProposeResult
  | BatchProposeResult
  | ReviewResult;

// ---------------------------------------------------------------------------
// Proposals file helpers
// ---------------------------------------------------------------------------

function proposalsFilePath(repoRoot: string): string {
  return path.join(repoRoot, ".kodela", "proposals.json");
}

async function readProposals(repoRoot: string): Promise<ProposalQueueRecord[]> {
  try {
    const raw = await fs.readFile(proposalsFilePath(repoRoot), "utf-8");
    return JSON.parse(raw) as ProposalQueueRecord[];
  } catch {
    return [];
  }
}

async function writeProposals(
  repoRoot: string,
  records: ProposalQueueRecord[],
): Promise<void> {
  const filePath = proposalsFilePath(repoRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(records, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Function-range extraction
// ---------------------------------------------------------------------------

/**
 * Search `lines` for a function/method named `fnName` and return its
 * 1-indexed line range.  Uses brace counting for C-style languages.
 * Returns null when the function cannot be found.
 */
function findFunctionRange(
  lines: string[],
  fnName: string,
): { start: number; end: number } | null {
  const escaped = fnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`),
    new RegExp(`\\basync\\s+function\\s+${escaped}\\s*\\(`),
    new RegExp(`\\bconst\\s+${escaped}\\s*=\\s*(?:async\\s+)?(?:function|\\()`),
    new RegExp(`\\b${escaped}\\s*\\([^)]*\\)\\s*(?::\\s*\\w[\\w<>\\[\\]|, ]*)?\\s*\\{`),
    new RegExp(`\\bdef\\s+${escaped}\\s*\\(`),
  ];

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((p) => p.test(lines[i]))) {
      startIdx = i;
      break;
    }
  }

  if (startIdx === -1) return null;

  let braceCount = 0;
  let started = false;
  const maxLines = Math.min(lines.length, startIdx + FN_CONTEXT_LINES);

  for (let i = startIdx; i < maxLines; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        braceCount++;
        started = true;
      }
      if (ch === "}") {
        braceCount--;
      }
    }
    if (started && braceCount === 0) {
      return { start: startIdx + 1, end: i + 1 };
    }
  }

  return { start: startIdx + 1, end: maxLines };
}

// ---------------------------------------------------------------------------
// Core propose logic
// ---------------------------------------------------------------------------

/**
 * Persist an accepted proposal as a new ContextEntry (source: "ai",
 * reviewRequired: true).
 */
async function acceptProposal(
  repoRoot: string,
  filePath: string,
  lineRange: { start: number; end: number },
  note: string,
  confidence: ProposalConfidence,
): Promise<ContextEntry> {
  const absolutePath = path.resolve(repoRoot, filePath);
  let contentHash = "0".repeat(64);
  let astAnchor: ContextEntry["astAnchor"] = null;

  try {
    const content = await fs.readFile(absolutePath, "utf-8");
    const lines = content.split("\n");
    const slice = lines.slice(lineRange.start - 1, lineRange.end).join("\n");
    contentHash = hashTokenStream(slice);
    astAnchor = buildAstAnchor(
      filePath.replace(/\\/g, "/").replace(/^\.\//, ""),
      lineRange,
      content,
    );
  } catch {
    // best-effort
  }

  const author =
    process.env["KODELA_AUTHOR"] ??
    process.env["GIT_AUTHOR_NAME"] ??
    "kodela-propose";
  const now = new Date().toISOString();

  const entry: ContextEntry = {
    schemaVersion: SCHEMA_VERSION,
    id: crypto.randomUUID(),
    filePath: filePath.replace(/\\/g, "/").replace(/^\.\//, ""),
    astAnchor,
    contentHash,
    lineRange,
    note,
    author,
    createdAt: now,
    updatedAt: now,
    severity: "low",
    tags: ["ai-proposed"],
    source: "ai",
    confidence: confidence === "high" ? 0.9 : confidence === "medium" ? 0.7 : 0.5,
    status: "mapped",
    reviewRequired: true,
    origin: { type: "ai", summary: "AI-proposed annotation via kodela propose" },
  };

  await writeContextEntry(repoRoot, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Public runPropose
// ---------------------------------------------------------------------------

export async function runPropose(opts: ProposeOptions): Promise<ProposeResult> {
  const { repoRoot } = opts;

  // ── Review mode ──────────────────────────────────────────────────────────
  if (opts.review) {
    const records = await readProposals(repoRoot);
    const pending = records.filter((r) => r.status === "pending");
    let accepted = 0;
    let rejected = 0;

    for (const rec of pending) {
      // In non-interactive / scripted use we auto-accept pending with
      // high confidence, otherwise we leave them as-is (the caller in
      // bin.ts can pipe stdin).  For now, return the counts so the
      // CLI formatter can guide the user.
      void rec; // will be handled by interactive loop in bin.ts
    }

    const remaining = pending.length - accepted - rejected;
    return { mode: "review", accepted, rejected, remaining: remaining + pending.length };
  }

  // ── Batch mode ────────────────────────────────────────────────────────────
  if (opts.repo) {
    const index = await readIndex(repoRoot);
    const allEntries = await Promise.all(
      index.entries.map((id) => readContextEntry(repoRoot, id)),
    );

    const stubs = allEntries.filter((e) => {
      if (!e.note.startsWith(STUB_NOTE_PREFIX)) return false;
      if (opts.source && e.source !== opts.source) return false;
      return true;
    });

    const existing = await readProposals(repoRoot);
    const existingEntryIds = new Set(existing.map((r) => r.entryId));

    let queued = 0;
    let skipped = 0;

    for (const entry of stubs) {
      if (existingEntryIds.has(entry.id)) {
        skipped++;
        continue;
      }

      const absolutePath = path.resolve(repoRoot, entry.filePath);
      let codeText: string;
      try {
        const content = await fs.readFile(absolutePath, "utf-8");
        const lines = content.split("\n");
        codeText = lines.slice(entry.lineRange.start - 1, entry.lineRange.end).join("\n");
      } catch {
        skipped++;
        continue;
      }

      let proposal: { note: string; confidence: ProposalConfidence };
      try {
        proposal = await callForProposal(codeText, {
          config: opts.aiConfig,
          filePath: entry.filePath,
        });
      } catch {
        skipped++;
        continue;
      }

      const record: ProposalQueueRecord = {
        id: crypto.randomUUID(),
        entryId: entry.id,
        filePath: entry.filePath,
        lineRange: entry.lineRange,
        proposedNote: proposal.note,
        confidence: proposal.confidence,
        proposedAt: new Date().toISOString(),
        status: "pending",
      };
      existing.push(record);
      queued++;
    }

    await writeProposals(repoRoot, existing);
    return { mode: "batch", queued, skipped };
  }

  // ── Single-file mode ──────────────────────────────────────────────────────
  if (!opts.filePath) {
    throw new Error(
      "A file path is required (or use --repo for batch mode, --review for review mode).",
    );
  }

  const normalizedPath = opts.filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const absolutePath = path.resolve(repoRoot, normalizedPath);

  let fileContent: string;
  try {
    fileContent = await fs.readFile(absolutePath, "utf-8");
  } catch {
    throw new Error(`Cannot read file: ${normalizedPath}`);
  }

  const lines = fileContent.split("\n");

  let lineRange: { start: number; end: number };

  if (opts.fn) {
    const range = findFunctionRange(lines, opts.fn);
    if (!range) {
      throw new Error(
        `Could not locate function "${opts.fn}" in ${normalizedPath}. ` +
          `Try --lines <start>-<end> to specify the range manually.`,
      );
    }
    lineRange = range;
  } else if (opts.lineStart !== undefined) {
    lineRange = {
      start: opts.lineStart,
      end: opts.lineEnd ?? opts.lineStart,
    };
  } else {
    lineRange = { start: 1, end: Math.min(lines.length, 60) };
  }

  const codeText = lines.slice(lineRange.start - 1, lineRange.end).join("\n");

  const proposal = await callForProposal(codeText, {
    config: opts.aiConfig,
    fnName: opts.fn,
    filePath: normalizedPath,
  });

  let decision: SingleProposeResult["decision"] = "pending";
  let entry: ContextEntry | undefined;

  if (opts.accept) {
    entry = await acceptProposal(
      repoRoot,
      normalizedPath,
      lineRange,
      proposal.note,
      proposal.confidence,
    );
    decision = "accepted";

    await appendTelemetryEvent(repoRoot, {
      type: "proposal_accepted",
      schemaVersion: "1.0.0",
      timestamp: new Date().toISOString(),
      confidence: proposal.confidence,
      wasEdited: false,
      noteLength: proposal.note.length,
    });
  } else if (opts.reject) {
    decision = "rejected";
    await appendTelemetryEvent(repoRoot, {
      type: "proposal_rejected",
      schemaVersion: "1.0.0",
      timestamp: new Date().toISOString(),
      confidence: proposal.confidence,
    });
  }

  return {
    mode: "single",
    filePath: normalizedPath,
    lineRange,
    note: proposal.note,
    confidence: proposal.confidence,
    decision,
    entry,
  };
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

const CONFIDENCE_LABEL: Record<ProposalConfidence, string> = {
  high: "High",
  medium: "Medium",
  low: "Low (mandatory review required)",
};

export function formatProposeResult(result: ProposeResult): string {
  if (result.mode === "batch") {
    if (result.queued === 0 && result.skipped === 0) {
      return "No stub annotations found. Nothing to propose.";
    }
    return (
      `Batch proposal complete:\n` +
      `  Queued: ${result.queued} proposals written to .kodela/proposals.json\n` +
      `  Skipped: ${result.skipped} (already queued or file unreadable)\n` +
      `\nRun kodela propose --review to accept or reject each proposal.`
    );
  }

  if (result.mode === "review") {
    if (result.remaining === 0) {
      return "No pending proposals to review.";
    }
    return (
      `${result.remaining} proposal(s) pending review.\n` +
      `Run with an interactive terminal to accept or reject each one.`
    );
  }

  const sep = "─".repeat(64);
  const lines = [
    `Proposed annotation for ${result.filePath} (lines ${result.lineRange.start}–${result.lineRange.end}):`,
    sep,
    result.note,
    sep,
    `Confidence: ${CONFIDENCE_LABEL[result.confidence]}`,
  ];

  if (result.decision === "accepted") {
    lines.push(
      `\nAccepted. Entry ${result.entry?.id ?? ""} created with reviewRequired: true.`,
    );
  } else if (result.decision === "rejected") {
    lines.push(`\nRejected. No entry created.`);
  } else {
    lines.push(
      `\nTo save this annotation run with --accept, or discard with --reject.`,
    );
  }

  return lines.join("\n");
}
