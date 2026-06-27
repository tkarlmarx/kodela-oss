// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Hooks-first onboarding (Task #1, Step 2).
 *
 * `kodela setup` is the new top-level command that orchestrates initialization
 * + capture-path selection driven by the confidence helper.
 *
 * Behaviour by detection level:
 *   high — auto-install hooks (always under --yes; default behaviour otherwise)
 *   low  — interactive prompt; under --yes (or --print-only) take the
 *          deterministic safe path: skip hooks and fall through to the
 *          watcher / manual fallback.  This is the CI-safety contract:
 *          --yes must NEVER block on stdin.
 *   none — skip hooks; offer the watcher fallback
 *
 * The command always exits cleanly within seconds.  In CI:
 *   `kodela setup --yes --no-watcher` is fully non-interactive and non-blocking.
 */

import path from "node:path";
import { runInit, type InitResult } from "./init.js";
import { runHookInstallClaude } from "./hook.js";
import {
  runHookInstallCursor,
  formatHookInstallCursorResult,
} from "./hook-cursor.js";
import {
  runWatchDetach,
  installSupervisor,
  type InstallSupervisorResult,
} from "./watch-daemon.js";
import {
  detectClaudeCode,
  type ClaudeDetectionResult,
} from "../utils/claude-detection.js";
import {
  CLI_VERSION,
  KODELA_METADATA_SCHEMA_VERSION,
  getKodelaSchemaVersion,
  refreshKodelaMetadata,
  setCaptureMode,
  writeGettingStartedMd,
} from "../config/loader.js";
import {
  renderCapturePathBlock,
  type CaptureMode,
} from "../output/messaging.js";
import { fileExists } from "../utils/repo.js";
import { createPrompt, type PromptInterface } from "../utils/prompt.js";

export type SetupOptions = {
  repoRoot: string;
  /** Non-interactive mode — never prompt; pick the safest default. */
  yes?: boolean;
  /** Skip the watcher fallback when hooks aren't applicable. */
  noWatcher?: boolean;
  /** Re-run safely; refresh `_kodela` block and overwrite GETTING_STARTED.md. */
  force?: boolean;
  /** Dry-run — print the planned actions without executing them. */
  printOnly?: boolean;
  /**
   * Install a per-platform supervisor (launchd / systemd / schtasks) for the
   * watcher fallback path so it auto-restarts after a crash or reboot.  Has no
   * effect when hooks are the chosen capture path or when `noWatcher` is set.
   */
  supervise?: boolean;
  /** Override the detection result (tests). */
  detectionOverride?: ClaudeDetectionResult;
  /** Override the prompt interface (tests). */
  prompt?: PromptInterface;
  /** Install Cursor IDE hooks (.cursor/hooks) instead of Claude Code hooks. */
  cursor?: boolean;
  /** Kodela monorepo path for Cursor hook templates (external repos). */
  kodelaHome?: string;
};

export type SetupAction =
  | "init"
  | "hooks-installed"
  | "hooks-skipped"
  | "watcher-started"
  | "watcher-skipped"
  | "watcher-supervised"
  | "manual"
  | "no-op";

export type SetupResult = {
  initResult: InitResult;
  detection: ClaudeDetectionResult;
  captureMode: CaptureMode;
  actions: SetupAction[];
  notes: string[];
  /** Supervisor install result, when `supervise` was requested. */
  supervisor?: InstallSupervisorResult;
  /** True when `--print-only` was set; no side effects performed. */
  printOnly: boolean;
};

// `runWatchDetach` already daemonizes — we only forward the runtime flags.
// Including `--detach` here would re-enter the detach path in the spawned
// child and exit immediately, leaving stale PID/meta files behind.
const DEFAULT_WATCHER_ARGS = ["--auto-annotate"];

export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const {
    repoRoot,
    yes = false,
    noWatcher = false,
    force = false,
    printOnly = false,
    supervise = false,
  } = opts;

  const actions: SetupAction[] = [];
  const notes: string[] = [];
  let supervisorResult: InstallSupervisorResult | undefined;

  // ── 1. Initialize baseline (idempotent) ─────────────────────────────────
  let initResult: InitResult;
  if (printOnly) {
    initResult = {
      repoRoot,
      alreadyExisted: false,
      configWritten: false,
      kodelaignoreWritten: false,
      gettingStartedWritten: false,
      trackedFiles: 0,
      hooksInstalled: false,
      hooksSkipped: false,
    };
    actions.push("init");
    notes.push("[print-only] would run `kodela init`");
  } else {
    initResult = await runInit(repoRoot, { force });
    actions.push("init");
    if (force) {
      // Bump the `_kodela` schema/version metadata when the user explicitly
      // asked for a refresh.
      const refreshed = await refreshKodelaMetadata(repoRoot);
      if (refreshed) {
        notes.push("Refreshed `_kodela` metadata block to current schema_version");
      }
      // Force-rewrite GETTING_STARTED.md
      await writeGettingStartedMd(repoRoot, { force: true }).catch(() => undefined);
    } else if (initResult.alreadyExisted) {
      // Spec lines 98 & 109: when `kodela.config.json` exists with an older
      // `_kodela.schema_version` (or no `_kodela` block at all), prompt to
      // refresh just that block — auto-refresh under `--yes`.  Also
      // re-write `.kodela/GETTING_STARTED.md` because spec line 98 says
      // it must be regenerated whenever the schema_version advances.
      await maybeRefreshStaleSchema(
        repoRoot,
        { yes, prompt: opts.prompt },
        actions,
        notes,
      );
    }
  }

  // ── 2. Cursor hooks (--cursor) or Claude Code detection ─────────────────
  const detection =
    opts.detectionOverride ?? (await detectClaudeCode(repoRoot));

  // ── 3. Decide capture path ───────────────────────────────────────────────
  let captureMode: CaptureMode = "unset";

  if (opts.cursor) {
    notes.push("Cursor IDE hook install requested (--cursor)");
    if (printOnly) {
      actions.push("hooks-installed");
      notes.push("[print-only] would install Cursor hooks via kodela hook install --cursor");
      captureMode = "hooks";
    } else {
      const cursorResult = await runHookInstallCursor({
        repoRoot,
        kodelaHome: opts.kodelaHome,
        force,
      });
      if (cursorResult.alreadyInstalled || cursorResult.skipped) {
        actions.push("hooks-skipped");
        notes.push(formatHookInstallCursorResult(cursorResult));
      } else {
        actions.push("hooks-installed");
        notes.push(formatHookInstallCursorResult(cursorResult));
      }
      captureMode = "hooks";
    }
  } else if (detection.level === "high") {
    notes.push(`Claude Code detected (confidence: high)`);
    for (const s of detection.signals) notes.push(`  • ${s}`);
    captureMode = await maybeInstallHooks(
      repoRoot,
      { yes: true, force, printOnly },
      actions,
      notes,
    );
  } else if (detection.level === "low") {
    notes.push(`Claude Code signals are weak (confidence: low)`);
    for (const s of detection.signals) notes.push(`  • ${s}`);
    notes.push(
      "  Skipping auto-install — explicit confirmation required for low-confidence detections.",
    );
    // Spec: low-confidence detections must NEVER block CI / scripted onboarding.
    // When --yes is passed (or --print-only), pick the deterministic safe path:
    // do not install hooks, fall through to the watcher / manual fallback.
    // When the operator is interactive (no --yes, no --print-only), always
    // prompt explicitly — that's the safety this branch exists to provide.
    if (yes) {
      notes.push(
        "  --yes set → choosing the deterministic safe path: skipping hooks, falling through to the watcher / manual fallback.",
      );
    } else if (!printOnly) {
      const prompt = opts.prompt ?? createPrompt();
      const close = (): void => {
        try {
          prompt.close();
        } catch {
          // ignore
        }
      };
      try {
        const answer = (
          await prompt.question(
            "Install Claude Code hooks anyway? [y/N] ",
          )
        )
          .trim()
          .toLowerCase();
        if (answer === "y" || answer === "yes") {
          captureMode = await maybeInstallHooks(
            repoRoot,
            { yes: true, force, printOnly: false },
            actions,
            notes,
          );
        } else {
          notes.push("  Operator declined — falling back to watcher / manual.");
        }
      } finally {
        close();
      }
    }
  } else {
    notes.push("Claude Code not detected (confidence: none)");
  }

  // ── 4. Watcher fallback (when hooks aren't active) ───────────────────────
  if (captureMode === "unset" && !noWatcher) {
    if (printOnly) {
      if (supervise) {
        actions.push("watcher-supervised");
        notes.push(
          "[print-only] would install the watcher supervisor: kodela watch --supervise",
        );
      } else {
        actions.push("watcher-skipped");
        notes.push(
          "[print-only] would start the watcher daemon: kodela watch --auto-annotate --detach",
        );
      }
    } else if (supervise) {
      // Supervised path: install a per-platform service that starts and
      // auto-restarts the watcher.  Don't also spawn a --detach daemon —
      // the supervisor is responsible for the running process.
      supervisorResult = await installSupervisor({
        repoRoot,
        extraArgs: DEFAULT_WATCHER_ARGS,
        cliVersion: CLI_VERSION,
        force,
      });
      if (supervisorResult.installed || supervisorResult.alreadyInstalled) {
        actions.push("watcher-supervised");
        const where = supervisorResult.servicePath
          ? ` (${supervisorResult.servicePath})`
          : "";
        notes.push(
          `Watcher supervisor ${supervisorResult.installed ? "installed" : "already present"}${where}`,
        );
        for (const n of supervisorResult.notes) notes.push(`  ${n}`);
        captureMode = "watcher";
      } else {
        actions.push("watcher-skipped");
        notes.push(
          `Failed to install watcher supervisor: ${supervisorResult.reason}`,
        );
        for (const n of supervisorResult.notes) notes.push(`  ${n}`);
      }
    } else {
      const detachResult = await runWatchDetach({
        repoRoot,
        extraArgs: DEFAULT_WATCHER_ARGS,
        cliVersion: CLI_VERSION,
      });
      if (detachResult.alreadyRunning) {
        actions.push("watcher-skipped");
        notes.push(`Watcher already running — pid=${detachResult.pid}`);
        captureMode = "watcher";
      } else if (detachResult.started) {
        actions.push("watcher-started");
        notes.push(
          `Watcher started in background — pid=${detachResult.pid}, logs=${detachResult.logFile}`,
        );
        captureMode = "watcher";
      } else {
        actions.push("watcher-skipped");
        notes.push(`Failed to start watcher: ${detachResult.reason}`);
      }
    }
  } else if (captureMode === "unset" && noWatcher) {
    actions.push("manual");
    notes.push(
      "Watcher fallback skipped (--no-watcher).  Capture path stays unset; use `kodela add` for manual annotation.",
    );
    captureMode = "manual";
  }

  // ── 5. Persist capture_mode in config ────────────────────────────────────
  if (!printOnly && captureMode !== "unset") {
    await setCaptureMode(repoRoot, captureMode).catch(() => undefined);
  }

  return {
    initResult,
    detection,
    captureMode,
    actions,
    notes,
    supervisor: supervisorResult,
    printOnly,
  };
}

async function maybeInstallHooks(
  repoRoot: string,
  opts: { yes: boolean; force: boolean; printOnly: boolean },
  actions: SetupAction[],
  notes: string[],
): Promise<CaptureMode> {
  if (opts.printOnly) {
    actions.push("hooks-installed");
    notes.push("[print-only] would install Claude Code hooks");
    return "hooks";
  }

  const result = await runHookInstallClaude({ repoRoot, force: opts.force });
  if (result.alreadyInstalled || result.skipped) {
    actions.push("hooks-skipped");
    notes.push(`Claude Code hooks already installed (${result.settingsPath})`);
  } else if (result.created) {
    actions.push("hooks-installed");
    notes.push(`Created ${result.settingsPath} with Claude Code hooks`);
  } else if (result.updated) {
    actions.push("hooks-installed");
    notes.push(`Updated ${result.settingsPath} with Claude Code hooks`);
  }
  return "hooks";
}

export function formatSetupResult(result: SetupResult): string {
  const lines: string[] = [];

  if (result.printOnly) {
    lines.push("Dry-run preview (no changes made):");
    lines.push("");
  } else {
    lines.push(`✔ kodela setup complete — capture_mode=${result.captureMode}`);
    lines.push("");
  }

  if (result.notes.length > 0) {
    lines.push("Summary:");
    for (const note of result.notes) {
      lines.push(`  ${note}`);
    }
    lines.push("");
  }

  // The current capture mode is the source of truth for "is the watcher
  // running" — not whether *this* invocation freshly started it.  When
  // setup is re-run idempotently against an already-running watcher, the
  // action is `watcher-skipped` but the mode is still `watcher`, so the
  // shared block must render watcher as running.
  lines.push(
    renderCapturePathBlock({
      active: result.captureMode,
      hooksInstalled:
        result.captureMode === "hooks" ||
        result.actions.includes("hooks-installed") ||
        result.actions.includes("hooks-skipped"),
      watcherRunning:
        result.captureMode === "watcher" ||
        result.actions.includes("watcher-started"),
    }),
  );

  return lines.join("\n");
}

/**
 * Stale-schema upgrade path for `kodela setup` (no `--force`).
 *
 * Per spec lines 98 & 109: when an existing `kodela.config.json` has an older
 * `_kodela.schema_version` (or no `_kodela` block at all), prompt the operator
 * to refresh that block — under `--yes` (CI / scripted onboarding) auto-refresh
 * without prompting.  When a refresh runs, also re-write
 * `.kodela/GETTING_STARTED.md`, because that file is regenerated whenever the
 * schema_version advances.
 */
async function maybeRefreshStaleSchema(
  repoRoot: string,
  opts: { yes: boolean; prompt?: PromptInterface },
  actions: SetupAction[],
  notes: string[],
): Promise<void> {
  const existingVer = await getKodelaSchemaVersion(repoRoot);
  const currentVer = KODELA_METADATA_SCHEMA_VERSION;
  const stale =
    existingVer === null || existingVer < currentVer;
  if (!stale) return;

  const fromLabel =
    existingVer === null ? "missing" : `v${existingVer}`;

  const performRefresh = async (): Promise<void> => {
    const refreshed = await refreshKodelaMetadata(repoRoot);
    if (refreshed) {
      notes.push(
        `Refreshed _kodela metadata block (${fromLabel} → v${currentVer})`,
      );
      // Spec line 98: GETTING_STARTED.md is regenerated whenever the
      // schema_version advances.
      await writeGettingStartedMd(repoRoot, { force: true }).catch(
        () => undefined,
      );
      notes.push("Regenerated .kodela/GETTING_STARTED.md");
    }
  };

  if (opts.yes) {
    notes.push(
      `Stale _kodela.schema_version detected (${fromLabel}, current=v${currentVer}); --yes set → auto-refreshing.`,
    );
    await performRefresh();
    return;
  }

  // Interactive prompt — defaults to YES (the safe upgrade path).
  const prompt = opts.prompt ?? createPrompt();
  const close = (): void => {
    try {
      prompt.close();
    } catch {
      // ignore
    }
  };
  try {
    notes.push(
      `Existing _kodela.schema_version is ${fromLabel}; current is v${currentVer}.`,
    );
    const answer = (
      await prompt.question(
        "Refresh the _kodela metadata block (and regenerate GETTING_STARTED.md)? [Y/n] ",
      )
    )
      .trim()
      .toLowerCase();
    // Default-yes: empty input or any "y"/"yes" accepts.
    const accepted =
      answer === "" || answer === "y" || answer === "yes";
    if (accepted) {
      await performRefresh();
    } else {
      notes.push(
        "Operator declined the metadata refresh; keeping existing _kodela block. Run `kodela doctor --fix` later to apply.",
      );
    }
  } finally {
    close();
  }
}

/**
 * Quick existence check — used by tests and `kodela doctor` to confirm a
 * baseline is initialized.
 */
export async function isRepoInitialized(repoRoot: string): Promise<boolean> {
  return fileExists(path.join(repoRoot, ".kodela", "baseline.json"));
}
