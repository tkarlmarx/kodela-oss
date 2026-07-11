// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela check` — flag changes (or proposed decisions) that contradict an
 * active recorded decision. The human/CI-facing surface of the contradiction
 * engine (the agent-facing surface is the `kodela_check_contradiction` MCP tool).
 *
 *   kodela check "reintroduce mongodb for caching"   # check a described change
 *   kodela check                                      # scan proposed decisions
 *   kodela check --ci                                 # exit 1 if any violation
 *
 * Reads `.kodela/index.db` read-only; offline, no LLM. High-precision — only
 * active decisions are enforced.
 */
import fs from "node:fs";
import path from "node:path";
import {
  detectContradictionsAsync,
  type ContradictionDecision,
  type ContradictionFlag,
  type EmbedFn,
} from "@kodela/core";

const safeArr = (s: unknown): string[] => {
  if (Array.isArray(s)) return s as string[];
  if (typeof s !== "string") return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
};

/** Load all decisions from the local store as engine inputs. Empty if no store. */
export async function loadLocalDecisions(repoRoot: string): Promise<ContradictionDecision[]> {
  const dbPath = path.join(repoRoot, ".kodela", "index.db");
  if (!fs.existsSync(dbPath)) return [];
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return []; // node:sqlite unavailable (older Node)
  }
  let db: import("node:sqlite").DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const has = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decisions'")
      .get();
    if (!has) return [];
    const rows = db
      .prepare("SELECT id, title, status, problem, decision, reason, supersedes FROM decisions")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title ?? ""),
      status: String(r.status ?? ""),
      problem: (r.problem as string | null) ?? null,
      decision: (r.decision as string | null) ?? null,
      reason: (r.reason as string | null) ?? null,
      supersedes: safeArr(r.supersedes),
    }));
  } finally {
    db.close();
  }
}

export interface CheckOptions {
  repoRoot: string;
  /** A described change to check. When omitted, proposed decisions are scanned. */
  change?: string;
  minConfidence?: number;
  /**
   * Turn on the recall dial: an on-device embedding topic-match catches
   * reversals phrased differently from the keyword lexicon (surfaced as
   * lower-confidence "review" flags). Offline, no API key.
   */
  semantic?: boolean;
}

/** Resolve the offline embedder for --semantic; null if unavailable. */
async function resolveEmbedFn(): Promise<EmbedFn | undefined> {
  try {
    const { resolveEmbedder } = await import("@kodela/embed");
    const resolved = await resolveEmbedder({});
    return (t: string) => resolved.embedder.embed(t);
  } catch {
    return undefined; // embedder unavailable → fall back to regex-only
  }
}

export interface ScanEntry {
  decision: ContradictionDecision;
  flags: ContradictionFlag[];
}

export interface CheckResult {
  mode: "change" | "scan";
  decisionsChecked: number;
  /** mode "change": flags for the described change. */
  flags?: ContradictionFlag[];
  change?: string;
  /** mode "scan": each proposed decision that conflicts with an active one. */
  scanned?: ScanEntry[];
  /** Total flags across the result — non-zero means a violation was found. */
  violationCount: number;
}

const NON_ENFORCED = new Set(["active", "superseded", "archived"]);

export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const decisions = await loadLocalDecisions(options.repoRoot);
  const minConfidence = options.minConfidence ?? 0;
  const embed = options.semantic ? await resolveEmbedFn() : undefined;
  const opts = { minConfidence, embed, semanticReview: Boolean(embed) };

  if (options.change && options.change.trim().length > 0) {
    const flags = await detectContradictionsAsync({ text: options.change }, decisions, opts);
    return {
      mode: "change",
      change: options.change,
      flags,
      decisionsChecked: decisions.length,
      violationCount: flags.length,
    };
  }

  // No change given → scan every proposed/rejected decision against the active set.
  const scanned: ScanEntry[] = [];
  for (const d of decisions.filter((x) => !NON_ENFORCED.has(x.status))) {
    const flags = await detectContradictionsAsync(
      { title: d.title, problem: d.problem, decision: d.decision, reason: d.reason },
      decisions,
      opts,
    );
    if (flags.length > 0) scanned.push({ decision: d, flags });
  }
  return {
    mode: "scan",
    scanned,
    decisionsChecked: decisions.length,
    violationCount: scanned.reduce((n, s) => n + s.flags.length, 0),
  };
}

function formatFlag(f: ContradictionFlag): string {
  const pct = Math.round(f.confidence * 100);
  return `  ⚠ [${pct}% · ${f.kind}] ${f.reason}`;
}

export function formatCheckResult(result: CheckResult): string {
  if (result.decisionsChecked === 0) {
    return "No decisions recorded yet — nothing to check. Record decisions with kodela_record_decision.";
  }
  if (result.mode === "change") {
    if (!result.flags || result.flags.length === 0) {
      return `✓ No contradiction with any active decision (${result.decisionsChecked} decisions checked).`;
    }
    return (
      `⚠ ${result.flags.length} potential decision violation(s) for this change:\n` +
      result.flags.map(formatFlag).join("\n") +
      `\n\nReview these before proceeding — the change appears to reverse an active decision.`
    );
  }
  // scan
  if (!result.scanned || result.scanned.length === 0) {
    return `✓ No proposed decision conflicts with an active one (${result.decisionsChecked} decisions checked).`;
  }
  const blocks = result.scanned.map(
    (s) => `Proposed "${s.decision.title}" (${s.decision.id}) may conflict:\n` + s.flags.map(formatFlag).join("\n"),
  );
  return `⚠ ${result.scanned.length} proposed decision(s) conflict with active decisions:\n\n` + blocks.join("\n\n");
}
