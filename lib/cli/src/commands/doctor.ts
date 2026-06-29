// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela doctor` — diagnostic command (Task #1, Step 7).
 *
 * Runs a series of fast checks and prints a `✔/⚠/✖` table with one-line
 * remediation hints pointing at the right command.  This is the first-line
 * support tool — designed to take seconds and answer "what's wrong with my
 * Kodela installation?" without opening any logs.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileExists } from "../utils/repo.js";
import {
  CONFIG_FILE_NAME,
  KODELA_METADATA_SCHEMA_VERSION,
  loadConfig,
  ConfigLoadError,
  refreshKodelaMetadata,
} from "../config/loader.js";
import {
  runWatchStatus,
  supervisorStatus,
  type WatcherStatus,
  type SupervisorStatusResult,
} from "./watch-daemon.js";
import { detectClaudeCode } from "../utils/claude-detection.js";

export type DoctorCheckLevel = "ok" | "warn" | "fail";

export type DoctorCheck = {
  name: string;
  level: DoctorCheckLevel;
  detail: string;
  remediation?: string;
};

export type DoctorResult = {
  repoRoot: string;
  checks: DoctorCheck[];
  /** True when no fail-level checks were recorded. */
  healthy: boolean;
  /** Remediations performed when `--fix` was passed. */
  fixesApplied: DoctorFix[];
};

const KODELA_HOOK_MARKER = "kodela-hook-v1";
const RECENT_CAPTURE_DAYS = 7;
const RECENT_CAPTURE_MS = RECENT_CAPTURE_DAYS * 24 * 60 * 60 * 1000;

function ok(name: string, detail: string): DoctorCheck {
  return { name, level: "ok", detail };
}
function warn(name: string, detail: string, remediation?: string): DoctorCheck {
  return { name, level: "warn", detail, remediation };
}
function fail(name: string, detail: string, remediation?: string): DoctorCheck {
  return { name, level: "fail", detail, remediation };
}

export type DoctorOptions = {
  repoRoot: string;
  /** Override `Date.now()` (used by tests). */
  now?: () => number;
  /** Override `process.env` (used by tests). */
  env?: NodeJS.ProcessEnv;
  /**
   * When true, doctor will attempt safe automated remediations for the
   * findings it surfaces.  Currently scoped to refreshing the `_kodela`
   * metadata block when it is missing or its `schema_version` is older
   * than the current CLI's `KODELA_METADATA_SCHEMA_VERSION`.  Other
   * findings (broken JSON, missing baseline, missing watcher, missing
   * AI key) still require operator intervention because the right
   * remediation is not unambiguous.
   */
  fix?: boolean;
};

export type DoctorFix = {
  name: string;
  detail: string;
};

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const { repoRoot } = opts;
  const now = (opts.now ?? Date.now)();
  const env = opts.env ?? process.env;
  const fix = opts.fix ?? false;

  const checks: DoctorCheck[] = [];
  const fixesApplied: DoctorFix[] = [];

  // ── 1. Repo initialized ──────────────────────────────────────────────────
  const baselineExists = await fileExists(path.join(repoRoot, ".kodela", "baseline.json"));
  if (baselineExists) {
    checks.push(ok("Repository", `.kodela/ baseline present at ${repoRoot}`));
  } else {
    checks.push(
      fail(
        "Repository",
        ".kodela/ baseline not found",
        "→ run `kodela init` (or `kodela setup` for guided onboarding)",
      ),
    );
  }

  // ── 2. Config valid + schema_version current ─────────────────────────────
  const configPath = path.join(repoRoot, CONFIG_FILE_NAME);
  if (!(await fileExists(configPath))) {
    checks.push(
      warn(
        "Config",
        `${CONFIG_FILE_NAME} not found — built-in defaults will be used`,
        "→ run `kodela init` to write a starter config",
      ),
    );
  } else {
    try {
      const config = await loadConfig(repoRoot);
      const meta = (config as unknown as { _kodela?: { schema_version?: number } })._kodela;
      const needsRefresh =
        !meta || meta.schema_version !== KODELA_METADATA_SCHEMA_VERSION;
      if (needsRefresh && fix) {
        // Auto-remediate via `--fix`: rewrite the `_kodela` block in-place.
        // refreshKodelaMetadata returns true when it actually rewrote the file.
        let changed = false;
        try {
          changed = await refreshKodelaMetadata(repoRoot);
        } catch (err) {
          checks.push(
            fail(
              "Config",
              `Failed to refresh _kodela metadata: ${
                err instanceof Error ? err.message : String(err)
              }`,
              "→ inspect kodela.config.json manually or restore from a backup",
            ),
          );
        }
        if (changed) {
          fixesApplied.push({
            name: "Config",
            detail: !meta
              ? "Added _kodela block (was missing)"
              : `Refreshed _kodela.schema_version (${meta.schema_version} → ${KODELA_METADATA_SCHEMA_VERSION})`,
          });
          checks.push(
            ok(
              "Config",
              `${CONFIG_FILE_NAME} _kodela block refreshed by --fix (now schema_version=${KODELA_METADATA_SCHEMA_VERSION})`,
            ),
          );
        }
      } else if (!meta) {
        checks.push(
          warn(
            "Config",
            `${CONFIG_FILE_NAME} has no _kodela block (older format)`,
            "→ run `kodela doctor --fix` to refresh the guidance block",
          ),
        );
      } else if (meta.schema_version !== KODELA_METADATA_SCHEMA_VERSION) {
        checks.push(
          warn(
            "Config",
            `_kodela.schema_version=${meta.schema_version} (current: ${KODELA_METADATA_SCHEMA_VERSION})`,
            "→ run `kodela doctor --fix` to refresh the guidance block",
          ),
        );
      } else {
        checks.push(ok("Config", `${CONFIG_FILE_NAME} valid (schema_version=${meta.schema_version})`));
      }
    } catch (err) {
      checks.push(
        fail(
          "Config",
          err instanceof ConfigLoadError ? err.message : String(err),
          "→ fix the JSON syntax or run `kodela init --force`",
        ),
      );
    }
  }

  // ── 3. Claude Code hooks installed ───────────────────────────────────────
  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  if (!(await fileExists(settingsPath))) {
    const det = await detectClaudeCode(repoRoot);
    if (det.level === "high") {
      checks.push(
        warn(
          "Claude Code hooks",
          "Claude Code detected but hooks are not installed",
          "→ run `kodela hook install --claude`",
        ),
      );
    } else {
      checks.push(
        ok(
          "Claude Code hooks",
          "Not installed (Claude Code not detected — this is expected)",
        ),
      );
    }
  } else {
    try {
      const raw = await fs.readFile(settingsPath, "utf-8");
      const settings = JSON.parse(raw) as { hooks?: Record<string, unknown[]> };
      const hooks = settings.hooks ?? {};
      let kodelaPresent = false;
      for (const entries of Object.values(hooks)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (typeof entry === "object" && entry !== null) {
            if ((entry as Record<string, unknown>)["_kodela"] === KODELA_HOOK_MARKER) {
              kodelaPresent = true;
              break;
            }
          }
        }
        if (kodelaPresent) break;
      }
      if (kodelaPresent) {
        checks.push(ok("Claude Code hooks", `Installed in ${settingsPath}`));
      } else {
        checks.push(
          warn(
            "Claude Code hooks",
            ".claude/settings.json exists but no Kodela hook marker found",
            "→ run `kodela hook install --claude`",
          ),
        );
      }
    } catch {
      checks.push(
        fail(
          "Claude Code hooks",
          `${settingsPath} exists but is not valid JSON`,
          "→ fix or remove the file, then re-run `kodela hook install --claude`",
        ),
      );
    }
  }

  // ── 4. Watcher daemon health ─────────────────────────────────────────────
  const status = await runWatchStatus(repoRoot, now);
  checks.push(watcherStatusToCheck(status));

  // ── 4b. Watcher supervisor (opt-in, per Task #2) ─────────────────────────
  const supStatus = await supervisorStatus({ repoRoot });
  checks.push(supervisorStatusToCheck(supStatus, status));

  // ── 4c. Encryption-at-rest status (internal design note) ──────────────────────────
  checks.push(await encryptionStatusCheck(repoRoot, env));

  // ── 5. AI provider key present ───────────────────────────────────────────
  const hasEnvKey = Boolean(env["KODELA_AI_API_KEY"]);
  let hasConfigKey = false;
  try {
    const config = await loadConfig(repoRoot);
    hasConfigKey = Boolean(config.ai_provider?.api_key);
  } catch {
    // Already reported above.
  }
  if (hasEnvKey || hasConfigKey) {
    const sources: string[] = [];
    if (hasEnvKey) sources.push("env");
    if (hasConfigKey) sources.push("config");
    checks.push(
      ok("AI provider key", `Present (${sources.join(" + ")})`),
    );
  } else {
    checks.push(
      warn(
        "AI provider key",
        "No KODELA_AI_API_KEY env var or ai_provider.api_key in config",
        "→ set KODELA_AI_API_KEY or add `ai_provider.api_key` to kodela.config.json (only required for AI features)",
      ),
    );
  }

  // ── 6. Recent capture activity ───────────────────────────────────────────
  const entriesDir = path.join(repoRoot, ".kodela", "entries");
  let recentEntryCount = 0;
  try {
    const dirents = await fs.readdir(entriesDir);
    for (const name of dirents) {
      try {
        const stat = await fs.stat(path.join(entriesDir, name));
        if (now - stat.mtimeMs <= RECENT_CAPTURE_MS) recentEntryCount++;
      } catch {
        // Ignore.
      }
    }
  } catch {
    // No entries dir — first-time install.
  }
  if (recentEntryCount > 0) {
    checks.push(
      ok(
        "Recent activity",
        `${recentEntryCount} entr${recentEntryCount === 1 ? "y" : "ies"} created in the last ${RECENT_CAPTURE_DAYS} days`,
      ),
    );
  } else {
    checks.push(
      warn(
        "Recent activity",
        `No new context entries in the last ${RECENT_CAPTURE_DAYS} days`,
        "→ if you've been running AI workflows, verify your capture path with `kodela watch status`",
      ),
    );
  }

  // Sprint 2 / [E.6] heal-engine — surface tree-sitter migration status.
  // When the marker is missing, mapping-engine falls back to the regex
  // extractor for AST-level matching; running `kodela heal --re-anchor`
  // aligns persisted bodyHashes with tree-sitter's body slicing and writes
  // the marker so the heal-engine uses tree-sitter by default afterwards.
  try {
    const fs = await import("node:fs/promises");
    const markerPath = (await import("node:path")).join(repoRoot, ".kodela", ".tree-sitter-anchored");
    let markerExists = false;
    try {
      await fs.access(markerPath);
      markerExists = true;
    } catch {
      // marker absent
    }
    if (markerExists) {
      checks.push(
        ok(
          "Heal-engine extractor",
          "Tree-sitter is the active extractor (re-anchor migration completed)",
        ),
      );
    } else {
      checks.push(
        warn(
          "Heal-engine extractor",
          "Regex extractor in use — tree-sitter swap not yet enabled for this repo",
          "→ run `kodela heal --re-anchor` once to align persisted anchors with tree-sitter and enable Tier-3 rename resilience for the 7 supported languages",
        ),
      );
    }
  } catch {
    // Best-effort check — never block doctor on a stat failure.
  }

  return {
    repoRoot,
    checks,
    healthy: !checks.some((c) => c.level === "fail"),
    fixesApplied,
  };
}

function supervisorStatusToCheck(
  status: SupervisorStatusResult,
  watcher: WatcherStatus,
): DoctorCheck {
  switch (status.state) {
    case "unsupported":
      return ok(
        "Watcher supervisor",
        `Not applicable on ${status.platform} (${status.reason})`,
      );
    case "not-installed":
      // Opt-in feature — absence is fine; just point at the activation command.
      return ok(
        "Watcher supervisor",
        "Not installed (opt-in — auto-restart after crash/reboot)",
      );
    case "installed-inactive": {
      // The supervisor unit file is on disk but the platform supervisor
      // doesn't show it as active.  This is a real degradation only when no
      // process is running either — otherwise the operator probably stopped it
      // intentionally.
      const remediation =
        watcher.state === "running"
          ? "→ run `kodela watch unsupervise` to remove, or re-enable with `kodela watch --supervise`"
          : "→ re-enable with `kodela watch --supervise`, or remove with `kodela watch unsupervise`";
      return warn(
        "Watcher supervisor",
        `Installed but inactive (${status.platform}: ${status.reason})`,
        remediation,
      );
    }
    case "installed-active":
      return ok(
        "Watcher supervisor",
        `Active (${status.platform}: ${status.detail})`,
      );
  }
}

/**
 * doc 27 §E.7 follow-up — report encryption-at-rest status.
 *
 * Three cases:
 *   - env var `KODELA_MASTER_KEY` set      → encryption enabled (SaaS / KMS path)
 *   - file `<repoRoot>/.kodela.master-key` → encryption enabled (kodela-init default)
 *   - neither                              → encryption OFF (warn — IS-2 risk)
 *
 * Note: the historical-key glob (`.kodela.master-key-*`) is NOT checked here.
 * Its absence is fine (no rotation has happened); its presence is irrelevant
 * to the current-key status the operator cares about.
 */
async function encryptionStatusCheck(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<DoctorCheck> {
  const envKeyPresent = Boolean(env["KODELA_MASTER_KEY"]?.trim());
  const keyFilePath = path.join(repoRoot, ".kodela.master-key");
  const keyFilePresent = await fileExists(keyFilePath);

  if (envKeyPresent) {
    return ok(
      "Encryption-at-rest",
      `Enabled (KODELA_MASTER_KEY env var; SaaS-mode / KMS path)`,
    );
  }
  if (keyFilePresent) {
    return ok(
      "Encryption-at-rest",
      `Enabled (per-repo key at .kodela.master-key)`,
    );
  }
  return warn(
    "Encryption-at-rest",
    "Disabled — no KODELA_MASTER_KEY env var and no .kodela.master-key file present",
    "→ run `kodela init` to generate a per-repo key, or set KODELA_MASTER_KEY (SaaS / KMS deployments)",
  );
}

function watcherStatusToCheck(status: WatcherStatus): DoctorCheck {
  switch (status.state) {
    case "running":
      return ok(
        "Watcher daemon",
        `Running (pid=${status.pid}, last heartbeat ${Math.round(status.heartbeatAgeMs / 1000)}s ago)`,
      );
    case "degraded":
      return fail(
        "Watcher daemon",
        `Degraded — ${status.reason}`,
        "→ run `kodela watch stop && kodela watch --auto-annotate --detach`",
      );
    case "stopped-stale":
      return warn(
        "Watcher daemon",
        `Stopped (stale PID ${status.pid}) — ${status.reason}`,
        "→ run `kodela watch --auto-annotate --detach` to restart",
      );
    case "stopped":
      return warn(
        "Watcher daemon",
        "Not running (this is OK if you use Claude Code hooks instead)",
        "→ run `kodela watch --auto-annotate --detach` to start the fallback capture path",
      );
  }
}

export function formatDoctorResult(result: DoctorResult): string {
  const lines: string[] = [];
  lines.push(`Kodela doctor — ${result.repoRoot}`);
  lines.push("");

  const namePadding = Math.max(...result.checks.map((c) => c.name.length));
  for (const check of result.checks) {
    const glyph = check.level === "ok" ? "✔" : check.level === "warn" ? "⚠" : "✖";
    const paddedName = check.name.padEnd(namePadding, " ");
    lines.push(`${glyph}  ${paddedName}  ${check.detail}`);
    if (check.remediation) {
      lines.push(`   ${" ".repeat(namePadding)}  ${check.remediation}`);
    }
  }

  if (result.fixesApplied.length > 0) {
    lines.push("");
    lines.push("Fixes applied:");
    for (const f of result.fixesApplied) {
      lines.push(`✔  ${f.name}: ${f.detail}`);
    }
  }

  lines.push("");
  if (result.healthy) {
    lines.push("● Overall: healthy (no failures)");
  } else {
    lines.push("● Overall: action required (see ✖ items above)");
  }
  return lines.join("\n");
}
