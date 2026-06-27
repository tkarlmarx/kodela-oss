// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * One-shot actor backfill for historical Kodela sessions.
 *
 * Hundreds of pre-existing sessions on disk show `actor.tool: "unknown"` in
 * the dashboard because they were created before the actor resolver landed.
 * This script walks `.kodela/sessions/*.json`, infers the actor on a
 * best-effort basis from each session's per-file annotations + heuristics,
 * and rewrites the session JSON.
 *
 * Idempotent: a session that already has a known actor is left alone unless
 * the --force flag is passed.
 *
 * Usage:
 *   pnpm --filter @workspace/mcp-server tsx scripts/backfill-actor.ts            # dry run
 *   pnpm --filter @workspace/mcp-server tsx scripts/backfill-actor.ts --write    # write changes
 *   pnpm --filter @workspace/mcp-server tsx scripts/backfill-actor.ts --write --force
 *
 * Heuristics (in priority order — first match wins):
 *   1. Dominant `modifiedBy.tool` across filesChangedDetail entries.
 *   2. If goal text contains agent markers (e.g. "cursor", "copilot"), use that.
 *   3. If captureSources includes "mcp", default to claude-code (current
 *      conservative assumption; refine when other MCP agents land).
 *   4. Otherwise leave unknown but mark `actorBackfillAttempted: true` so we
 *      don't waste cycles on the next run.
 *
 * See docs/Business/execution-plan/13-universal-capture-governance.md §4
 * Pillar B — long-term the watcher will pin actor identity at capture time
 * and this script can be retired.
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.env["KODELA_REPO_ROOT"] ?? process.cwd();
const SESSIONS_DIR = path.join(REPO_ROOT, ".kodela", "sessions");
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const FORCE = args.includes("--force");

interface BackfillStats {
  scanned: number;
  alreadyKnown: number;
  backfilledFromAnnotations: number;
  backfilledFromGoalHint: number;
  backfilledFromCaptureSource: number;
  stillUnknown: number;
  written: number;
  errors: number;
}

const stats: BackfillStats = {
  scanned: 0,
  alreadyKnown: 0,
  backfilledFromAnnotations: 0,
  backfilledFromGoalHint: 0,
  backfilledFromCaptureSource: 0,
  stillUnknown: 0,
  written: 0,
  errors: 0,
};

interface SessionLike {
  id?: string;
  goal?: string;
  actor?: { tool?: string; model?: string | null; author?: string };
  captureSources?: string[];
  filesChangedDetail?: Array<{
    modifiedBy?: { tool?: string | null; model?: string | null; source?: string };
  }>;
  actorBackfillAttempted?: boolean;
}

const AGENT_GOAL_HINTS: Array<{ pattern: RegExp; tool: string }> = [
  { pattern: /\bcursor\b/i, tool: "cursor" },
  { pattern: /\bcopilot\b/i, tool: "copilot" },
  { pattern: /\bcontinue\.dev|continue ide\b/i, tool: "continue" },
  { pattern: /\baider\b/i, tool: "aider" },
  { pattern: /\bcodex\b/i, tool: "codex-cli" },
  { pattern: /\bclaude(-| )code\b/i, tool: "claude-code" },
  { pattern: /\bantigravity\b/i, tool: "antigravity" },
  { pattern: /\bwindsurf\b/i, tool: "windsurf" },
];

function dominantTool(details: SessionLike["filesChangedDetail"]): string | undefined {
  if (!details || details.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const d of details) {
    const tool = d.modifiedBy?.tool;
    if (tool && tool !== "unknown" && tool.trim().length > 0) {
      counts.set(tool, (counts.get(tool) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return undefined;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

function inferAgentFromGoal(goal: string | undefined): string | undefined {
  if (!goal) return undefined;
  for (const { pattern, tool } of AGENT_GOAL_HINTS) {
    if (pattern.test(goal)) return tool;
  }
  return undefined;
}

function shouldBackfill(session: SessionLike): boolean {
  const tool = session.actor?.tool;
  if (FORCE) return true;
  if (!tool || tool === "unknown" || tool.trim().length === 0) return true;
  return false;
}

function backfillOne(session: SessionLike): {
  changed: boolean;
  reason?: keyof BackfillStats;
  next: SessionLike;
} {
  if (!shouldBackfill(session)) {
    return { changed: false, next: session };
  }

  // 1. Dominant tool from annotations.
  const fromAnnotations = dominantTool(session.filesChangedDetail);
  if (fromAnnotations) {
    return {
      changed: true,
      reason: "backfilledFromAnnotations",
      next: {
        ...session,
        actor: { ...(session.actor ?? {}), tool: fromAnnotations },
        actorBackfillAttempted: true,
      },
    };
  }

  // 2. Goal-text hint.
  const fromGoal = inferAgentFromGoal(session.goal);
  if (fromGoal) {
    return {
      changed: true,
      reason: "backfilledFromGoalHint",
      next: {
        ...session,
        actor: { ...(session.actor ?? {}), tool: fromGoal },
        actorBackfillAttempted: true,
      },
    };
  }

  // 3. Capture-source default.
  if ((session.captureSources ?? []).includes("mcp")) {
    return {
      changed: true,
      reason: "backfilledFromCaptureSource",
      next: {
        ...session,
        actor: { ...(session.actor ?? {}), tool: "claude-code" },
        actorBackfillAttempted: true,
      },
    };
  }

  // 4. Give up — mark attempted so future runs skip cheaply.
  return {
    changed: !session.actorBackfillAttempted,
    reason: "stillUnknown",
    next: { ...session, actorBackfillAttempted: true },
  };
}

function main(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    process.stderr.write(`No sessions dir at ${SESSIONS_DIR} — nothing to backfill.\n`);
    process.exit(0);
  }

  const files = fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json") && !f.includes(".mcp."));

  for (const file of files) {
    stats.scanned++;
    const full = path.join(SESSIONS_DIR, file);
    let raw: string;
    try {
      raw = fs.readFileSync(full, "utf8");
    } catch (err) {
      process.stderr.write(`[backfill] read failed ${file}: ${String(err)}\n`);
      stats.errors++;
      continue;
    }

    let session: SessionLike;
    try {
      session = JSON.parse(raw) as SessionLike;
    } catch (err) {
      process.stderr.write(`[backfill] JSON parse failed ${file}: ${String(err)}\n`);
      stats.errors++;
      continue;
    }

    if (!shouldBackfill(session)) {
      stats.alreadyKnown++;
      continue;
    }

    const { changed, reason, next } = backfillOne(session);
    if (reason) stats[reason]++;
    if (!changed) continue;

    if (WRITE) {
      try {
        fs.writeFileSync(full, JSON.stringify(next, null, 2) + "\n", "utf8");
        stats.written++;
      } catch (err) {
        process.stderr.write(`[backfill] write failed ${file}: ${String(err)}\n`);
        stats.errors++;
      }
    }
  }

  const mode = WRITE ? "WRITE" : "DRY RUN";
  process.stdout.write(
    `\n[backfill ${mode}] ${stats.scanned} sessions scanned\n` +
    `  already known:               ${stats.alreadyKnown}\n` +
    `  backfilled from annotations: ${stats.backfilledFromAnnotations}\n` +
    `  backfilled from goal hint:   ${stats.backfilledFromGoalHint}\n` +
    `  backfilled from capture src: ${stats.backfilledFromCaptureSource}\n` +
    `  still unknown (marked):      ${stats.stillUnknown}\n` +
    `  written to disk:             ${stats.written}\n` +
    `  errors:                      ${stats.errors}\n` +
    (WRITE
      ? ""
      : "\nRe-run with --write to persist changes. Add --force to overwrite already-known actors.\n"),
  );
}

main();
