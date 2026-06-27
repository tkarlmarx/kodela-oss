// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Confidence-graded Claude Code detection.
 *
 * Returns one of three confidence levels (rather than a boolean) so the
 * `kodela setup` and `kodela doctor` commands can choose behaviour based on
 * how strong the evidence is that this user actually uses Claude Code in
 * this repository.
 *
 *   `high`  — auto-install hooks even under --yes
 *   `low`   — prompt even under --yes; warn that the signal is weak
 *   `none`  — do not offer hooks; fall back to watcher
 *
 * Signals consulted:
 *   1. `.claude/settings.json` exists with non-Kodela hooks already configured
 *   2. `CLAUDECODE` environment variable is set in the current shell
 *   3. `~/.claude/projects/<repo-hash>/` has activity in the last 30 days
 *   4. `.claude/` directory exists but is empty (low signal)
 *   5. `~/.claude.json` exists with no recent project activity (low signal)
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export type ClaudeDetectionLevel = "high" | "low" | "none";

export type ClaudeDetectionResult = {
  level: ClaudeDetectionLevel;
  signals: string[];
};

const KODELA_HOOK_MARKER = "kodela-hook-v1";
const RECENT_ACTIVITY_DAYS = 30;
const RECENT_ACTIVITY_MS = RECENT_ACTIVITY_DAYS * 24 * 60 * 60 * 1000;

export type DetectionEnv = {
  /** Override `process.env` (used by tests). */
  env?: NodeJS.ProcessEnv;
  /** Override `os.homedir()` (used by tests). */
  homeDir?: string;
  /** Override `Date.now()` (used by tests). */
  now?: () => number;
};

/**
 * Hash the repo root to the same path Claude Code uses when storing project
 * state under `~/.claude/projects/`.  Claude Code uses a hash of the absolute
 * repository path; we approximate the same convention with sha256.
 */
function repoProjectHash(repoRoot: string): string {
  return crypto.createHash("sha256").update(repoRoot).digest("hex");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe<T>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Returns true when `.claude/settings.json` contains at least one non-Kodela
 * hook entry (i.e. the user has configured Claude Code hooks for some other
 * tool, which is strong evidence Claude Code is in active use).
 */
function hasNonKodelaHooks(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  const hooksField = (settings as Record<string, unknown>)["hooks"];
  if (!hooksField || typeof hooksField !== "object") return false;

  for (const entries of Object.values(hooksField as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const marker = (entry as Record<string, unknown>)["_kodela"];
      if (marker !== KODELA_HOOK_MARKER) {
        return true;
      }
    }
  }
  return false;
}

async function hasRecentProjectActivity(
  homeDir: string,
  repoRoot: string,
  now: number,
): Promise<boolean> {
  const projectDir = path.join(
    homeDir,
    ".claude",
    "projects",
    repoProjectHash(repoRoot),
  );
  try {
    const entries = await fs.readdir(projectDir);
    if (entries.length === 0) return false;
    for (const name of entries) {
      try {
        const stat = await fs.stat(path.join(projectDir, name));
        if (now - stat.mtimeMs <= RECENT_ACTIVITY_MS) {
          return true;
        }
      } catch {
        // Ignore individual stat failures.
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function detectClaudeCode(
  repoRoot: string,
  opts: DetectionEnv = {},
): Promise<ClaudeDetectionResult> {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? os.homedir();
  const now = (opts.now ?? Date.now)();

  const signals: string[] = [];
  let highConfidence = false;
  let lowConfidence = false;

  // ── High-confidence signal #1: non-Kodela hooks already configured ───────
  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  const settings = await readJsonSafe<unknown>(settingsPath);
  if (settings && hasNonKodelaHooks(settings)) {
    highConfidence = true;
    signals.push(".claude/settings.json has non-Kodela hooks");
  }

  // ── High-confidence signal #2: CLAUDECODE env var set ────────────────────
  if (env["CLAUDECODE"]) {
    highConfidence = true;
    signals.push("CLAUDECODE environment variable set");
  }

  // ── High-confidence signal #3: recent project activity in ~/.claude ──────
  if (await hasRecentProjectActivity(homeDir, repoRoot, now)) {
    highConfidence = true;
    signals.push(
      `~/.claude/projects/<hash>/ has activity in the last ${RECENT_ACTIVITY_DAYS} days`,
    );
  }

  if (highConfidence) {
    return { level: "high", signals };
  }

  // ── Low-confidence signal #1: empty .claude/ directory ───────────────────
  const claudeDir = path.join(repoRoot, ".claude");
  if (await fileExists(claudeDir)) {
    try {
      const entries = await fs.readdir(claudeDir);
      if (entries.length === 0) {
        lowConfidence = true;
        signals.push(".claude/ directory exists but is empty");
      } else if (settings && !hasNonKodelaHooks(settings)) {
        // Settings exist but no hooks (or only Kodela hooks): still a weak signal.
        lowConfidence = true;
        signals.push(".claude/ exists but no active hooks configured");
      }
    } catch {
      // Permission error — ignore.
    }
  }

  // ── Low-confidence signal #2: ~/.claude.json without recent project ──────
  const homeClaudeJson = path.join(homeDir, ".claude.json");
  if (await fileExists(homeClaudeJson)) {
    lowConfidence = true;
    signals.push("~/.claude.json exists with no recent project activity");
  }

  if (lowConfidence) {
    return { level: "low", signals };
  }

  return { level: "none", signals: ["no Claude Code signals detected"] };
}
