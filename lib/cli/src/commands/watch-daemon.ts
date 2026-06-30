// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Daemonized watcher lifecycle (Task #1, Step 4).
 *
 * Provides three operations on top of the existing `kodela watch` command:
 *
 *   `runWatchDetach` — spawn a detached child running `kodela watch`,
 *                      write `.kodela/watcher.pid` and `.kodela/watcher.meta`,
 *                      then return so the parent can exit.
 *   `runWatchStop`   — read the PID file, send SIGTERM, fall back to SIGKILL
 *                      after 5 seconds, and clean up state files.
 *   `runWatchStatus` — interpret the four lifecycle states:
 *                        running / stopped / stopped-stale / degraded.
 *
 * The watcher process itself refreshes `.kodela/watcher.meta` every
 * `HEARTBEAT_INTERVAL_MS` from inside `runWatch` (see `watch.ts`).  A stale
 * heartbeat (>90 s) means the watcher is alive but blocked, and the daemon
 * is reported as `degraded`.
 *
 * NOTE: this is intentionally *not* a fully-supervised daemon — it does not
 * use systemd / launchd / a service manager.  It is sufficient for developer
 * machines and is explicitly disclaimed in the user-facing output.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { setCaptureMode } from "../config/loader.js";
import { renderCapturePathBlock } from "../output/messaging.js";

export const KODELA_DIR = ".kodela";
export const PID_FILE = "watcher.pid";
export const META_FILE = "watcher.meta";
export const LOG_FILE = "watcher.log";

/** Refresh the heartbeat every 30 s from inside the running watcher. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Heartbeat older than this means the watcher is stalled / degraded. */
export const HEARTBEAT_STALE_THRESHOLD_MS = 90_000;

/** SIGTERM grace period before escalating to SIGKILL. */
export const STOP_GRACE_PERIOD_MS = 5_000;

export type WatcherMeta = {
  pid: number;
  startedAt: string;
  lastHeartbeat: string;
  cliVersion: string;
};

export type WatcherStatus =
  | { state: "stopped"; reason?: string; logFile?: string }
  | {
      state: "stopped-stale";
      pid: number;
      reason: string;
      logFile?: string;
    }
  | {
      state: "degraded";
      pid: number;
      startedAt: string;
      lastHeartbeat: string;
      uptimeMs: number;
      heartbeatAgeMs: number;
      reason: string;
      logFile: string;
    }
  | {
      state: "running";
      pid: number;
      startedAt: string;
      lastHeartbeat: string;
      uptimeMs: number;
      heartbeatAgeMs: number;
      logFile: string;
    };

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function pidFilePath(repoRoot: string): string {
  return path.join(repoRoot, KODELA_DIR, PID_FILE);
}

export function metaFilePath(repoRoot: string): string {
  return path.join(repoRoot, KODELA_DIR, META_FILE);
}

export function logFilePath(repoRoot: string): string {
  return path.join(repoRoot, KODELA_DIR, LOG_FILE);
}

// ---------------------------------------------------------------------------
// Process liveness
// ---------------------------------------------------------------------------

/**
 * Returns true when a process with the given PID is alive (signal 0 succeeds).
 * Returns false on ESRCH.  On EPERM (process exists but we can't signal it)
 * we still consider it alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Meta / PID file IO
// ---------------------------------------------------------------------------

export async function readWatcherMeta(repoRoot: string): Promise<WatcherMeta | null> {
  try {
    const raw = await fs.readFile(metaFilePath(repoRoot), "utf-8");
    const parsed = JSON.parse(raw) as Partial<WatcherMeta>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.lastHeartbeat !== "string" ||
      typeof parsed.cliVersion !== "string"
    ) {
      return null;
    }
    return parsed as WatcherMeta;
  } catch {
    return null;
  }
}

export async function readWatcherPid(repoRoot: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(pidFilePath(repoRoot), "utf-8");
    const pid = parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function writeWatcherMeta(
  repoRoot: string,
  meta: WatcherMeta,
): Promise<void> {
  await fs.mkdir(path.dirname(metaFilePath(repoRoot)), { recursive: true });
  await fs.writeFile(
    metaFilePath(repoRoot),
    JSON.stringify(meta, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Refresh just the `lastHeartbeat` field — used by the watcher process every
 * `HEARTBEAT_INTERVAL_MS`.  Best-effort; failures are silently swallowed.
 */
export async function refreshWatcherHeartbeat(repoRoot: string): Promise<void> {
  try {
    const existing = await readWatcherMeta(repoRoot);
    if (!existing) return;
    const updated: WatcherMeta = {
      ...existing,
      lastHeartbeat: new Date().toISOString(),
    };
    await writeWatcherMeta(repoRoot, updated);
  } catch {
    // Heartbeat refresh failure must never crash the watcher.
  }
}

async function removeFileIfExists(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    // Already gone — ignore.
  }
}

export async function cleanWatcherState(repoRoot: string): Promise<void> {
  await Promise.all([
    removeFileIfExists(pidFilePath(repoRoot)),
    removeFileIfExists(metaFilePath(repoRoot)),
  ]);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function runWatchStatus(
  repoRoot: string,
  now: number = Date.now(),
): Promise<WatcherStatus> {
  const pid = await readWatcherPid(repoRoot);

  // Spec: "PID file missing → stopped".  Any orphan meta file is also
  // cleaned up here so a subsequent `watch --detach` is unambiguous.
  if (pid === null) {
    const orphanMeta = await readWatcherMeta(repoRoot);
    if (orphanMeta !== null) {
      await cleanWatcherState(repoRoot);
    }
    return { state: "stopped" };
  }

  const meta = await readWatcherMeta(repoRoot);
  const effectivePid = pid;

  if (!isProcessAlive(effectivePid)) {
    // PID file exists but process is gone — auto-clean and report stale.
    await cleanWatcherState(repoRoot);
    return {
      state: "stopped-stale",
      pid: effectivePid,
      reason: "PID file pointed at a dead process — cleaned up",
    };
  }

  const logFile = logFilePath(repoRoot);

  // Process is alive.  Inspect heartbeat freshness.
  if (meta === null) {
    // PID alive but no meta — treat as degraded so the user runs stop+start.
    return {
      state: "degraded",
      pid: effectivePid,
      startedAt: new Date(0).toISOString(),
      lastHeartbeat: new Date(0).toISOString(),
      uptimeMs: 0,
      heartbeatAgeMs: Number.POSITIVE_INFINITY,
      reason: "Process alive but no heartbeat metadata found",
      logFile,
    };
  }

  const startedAtMs = Date.parse(meta.startedAt);
  const heartbeatMs = Date.parse(meta.lastHeartbeat);
  const heartbeatAgeMs = Number.isFinite(heartbeatMs)
    ? now - heartbeatMs
    : Number.POSITIVE_INFINITY;
  const uptimeMs = Number.isFinite(startedAtMs) ? Math.max(0, now - startedAtMs) : 0;

  if (heartbeatAgeMs > HEARTBEAT_STALE_THRESHOLD_MS) {
    return {
      state: "degraded",
      pid: effectivePid,
      startedAt: meta.startedAt,
      lastHeartbeat: meta.lastHeartbeat,
      uptimeMs,
      heartbeatAgeMs,
      reason: `Heartbeat ${Math.round(heartbeatAgeMs / 1000)} s old — process alive but not heartbeating; recommend kodela watch stop && kodela watch --auto-annotate --detach`,
      logFile,
    };
  }

  return {
    state: "running",
    pid: effectivePid,
    startedAt: meta.startedAt,
    lastHeartbeat: meta.lastHeartbeat,
    uptimeMs,
    heartbeatAgeMs,
    logFile,
  };
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

export type WatchStopResult = {
  stopped: boolean;
  signaledPid: number | null;
  forceKilled: boolean;
  alreadyStopped: boolean;
  reason: string;
  /** Notes from supervisor handling (deactivation / removal). */
  supervisorNotes?: string[];
};

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWatchStop(
  repoRoot: string,
  opts: {
    graceMs?: number;
    /** When true, also delete the supervisor unit file (full uninstall). */
    removeSupervisor?: boolean;
    /** Test override forwarded to supervisor helpers. */
    supervisorEnv?: import("./watch-supervisor.js").SupervisorEnv;
  } = {},
): Promise<WatchStopResult> {
  const graceMs = opts.graceMs ?? STOP_GRACE_PERIOD_MS;
  const supervisorNotes: string[] = [];

  // ── 1. If a supervisor is installed, take it out of the way first. ───────
  // Otherwise launchd / systemd / schtasks would immediately restart the
  // watcher we are about to kill.  By default we only deactivate (so the
  // operator can re-enable later); when `removeSupervisor: true` we also
  // delete the unit file.
  const { deactivateSupervisorOnly, removeSupervisor } = await import(
    "./watch-supervisor.js"
  );
  if (opts.removeSupervisor) {
    const removeResult = await removeSupervisor({
      repoRoot,
      env: opts.supervisorEnv,
    });
    if (!removeResult.alreadyRemoved) {
      supervisorNotes.push(...removeResult.notes);
    }
  } else {
    const deact = await deactivateSupervisorOnly({
      repoRoot,
      env: opts.supervisorEnv,
    });
    if (!deact.alreadyInactive) {
      supervisorNotes.push(deact.detail);
      supervisorNotes.push(
        "Supervisor unit kept on disk — re-enable with `kodela watch --supervise` (or remove it with `kodela watch stop --remove-supervisor`).",
      );
    }
  }

  const pid = (await readWatcherPid(repoRoot)) ?? (await readWatcherMeta(repoRoot))?.pid ?? null;

  const supervisorNotesField =
    supervisorNotes.length > 0 ? { supervisorNotes } : {};

  if (pid === null) {
    await cleanWatcherState(repoRoot);
    return {
      stopped: true,
      signaledPid: null,
      forceKilled: false,
      alreadyStopped: true,
      reason: "No watcher PID file — nothing to stop",
      ...supervisorNotesField,
    };
  }

  if (!isProcessAlive(pid)) {
    await cleanWatcherState(repoRoot);
    return {
      stopped: true,
      signaledPid: pid,
      forceKilled: false,
      alreadyStopped: true,
      reason: "PID file pointed at a dead process — cleaned up",
      ...supervisorNotesField,
    };
  }

  // SIGTERM + grace period.
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process disappeared between liveness check and kill — fall through.
  }

  const start = Date.now();
  while (Date.now() - start < graceMs) {
    if (!isProcessAlive(pid)) {
      await cleanWatcherState(repoRoot);
      return {
        stopped: true,
        signaledPid: pid,
        forceKilled: false,
        alreadyStopped: false,
        reason: "Watcher exited cleanly after SIGTERM",
        ...supervisorNotesField,
      };
    }
    await sleep(100);
  }

  // Escalate to SIGKILL.
  let forceKilled = false;
  try {
    process.kill(pid, "SIGKILL");
    forceKilled = true;
  } catch {
    // Process gone — treat as success.
  }

  // Final check.
  await sleep(100);
  const stillAlive = isProcessAlive(pid);
  await cleanWatcherState(repoRoot);
  return {
    stopped: !stillAlive,
    signaledPid: pid,
    forceKilled,
    alreadyStopped: false,
    reason: stillAlive
      ? "SIGKILL sent but process still alive — manual intervention may be required"
      : "Watcher killed after SIGTERM grace period",
    ...supervisorNotesField,
  };
}

// ---------------------------------------------------------------------------
// Detach (start the daemon)
// ---------------------------------------------------------------------------

export type WatchDetachOptions = {
  repoRoot: string;
  /** Path to the kodela executable (defaults to argv[0] / argv[1] resolution). */
  binPath?: string;
  /** Additional args to pass to `kodela watch` (e.g. ["--auto-annotate"]). */
  extraArgs?: string[];
  /** Optional environment overrides forwarded to the detached watcher process. */
  envOverrides?: Record<string, string>;
  /** If true, skip the running-instance check (used by --force). */
  force?: boolean;
  /** CLI version to record in the meta file. */
  cliVersion: string;
};

export type WatchDetachResult = {
  started: boolean;
  alreadyRunning: boolean;
  pid?: number;
  pidFile: string;
  metaFile: string;
  logFile: string;
  reason: string;
};

/**
 * Spawn a detached watcher process.  The parent returns once the child has
 * been spawned and a PID + meta file have been written.  The child writes
 * to `.kodela/watcher.log` and refreshes the heartbeat from inside `runWatch`.
 */
export async function runWatchDetach(
  opts: WatchDetachOptions,
): Promise<WatchDetachResult> {
  const {
    repoRoot,
    extraArgs = [],
    envOverrides,
    force = false,
    cliVersion,
  } = opts;

  // Idempotency: bail out if a watcher is already alive (running OR degraded).
  // A `degraded` state means the PID is alive but the heartbeat is stale —
  // spawning a second watcher in that case would orphan the old process,
  // overwrite the PID file, and break `kodela watch stop` (it would only
  // signal the new PID).  Force the operator to explicitly stop+restart.
  if (!force) {
    const status = await runWatchStatus(repoRoot);
    if (status.state === "running") {
      return {
        started: false,
        alreadyRunning: true,
        pid: status.pid,
        pidFile: pidFilePath(repoRoot),
        metaFile: metaFilePath(repoRoot),
        logFile: logFilePath(repoRoot),
        reason: `Watcher already running (pid=${status.pid}, uptime=${Math.round(status.uptimeMs / 1000)}s)`,
      };
    }
    if (status.state === "degraded") {
      const ageS = Number.isFinite(status.heartbeatAgeMs)
        ? `${Math.round(status.heartbeatAgeMs / 1000)}s`
        : "unknown";
      return {
        started: false,
        alreadyRunning: true,
        pid: status.pid,
        pidFile: pidFilePath(repoRoot),
        metaFile: metaFilePath(repoRoot),
        logFile: logFilePath(repoRoot),
        reason:
          `Watcher process pid=${status.pid} is alive but degraded ` +
          `(heartbeat ${ageS} old).  Refusing to spawn a duplicate.  ` +
          `Run: kodela watch stop && kodela watch --auto-annotate --detach ` +
          `(or pass --force to override).`,
      };
    }
    if (status.state === "stopped-stale") {
      // cleanWatcherState was already called inside runWatchStatus.
    }
  } else {
    await cleanWatcherState(repoRoot);
  }

  // Resolve the kodela binary.  In production this is the bundled cjs binary;
  // in tests we point at a stub via opts.binPath.
  const binPath = opts.binPath ?? resolveKodelaBin();

  // Bail when the resolved binary clearly is not a runnable kodela CLI —
  // happens when tests run via `node --test`, where `process.argv[1]` ends up
  // pointing at the .test.ts file itself.  Spawning that would EACCES because
  // the file isn't executable, and even if it were, it would re-execute the
  // test runner rather than the kodela watcher.  Returning a "skipped" result
  // honours the function's "best-effort" contract — capture still works via
  // hooks and the test simply continues without a real daemon.
  if (!isExecutableKodelaBin(binPath)) {
    return {
      started: false,
      alreadyRunning: false,
      pidFile: pidFilePath(repoRoot),
      metaFile: metaFilePath(repoRoot),
      logFile: logFilePath(repoRoot),
      reason:
        `Skipped watcher spawn — resolved binary "${binPath}" is not a kodela executable. ` +
        `Set KODELA_BIN to the bundled CLI bin, or pass opts.binPath explicitly.`,
    };
  }

  // Open the log file for stdout/stderr redirection.
  await fs.mkdir(path.join(repoRoot, KODELA_DIR), { recursive: true });
  const logFd = await fs.open(logFilePath(repoRoot), "a");

  const child = spawn(binPath, ["watch", ...extraArgs], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", logFd.fd, logFd.fd],
    env: {
      ...process.env,
      KODELA_WATCHER_DETACHED: "1",
      KODELA_WATCHER_REPO_ROOT: repoRoot,
      ...(envOverrides ?? {}),
    },
  });

  // The fd is duplicated by spawn; we can close ours.
  await logFd.close().catch(() => undefined);

  if (typeof child.pid !== "number") {
    return {
      started: false,
      alreadyRunning: false,
      pidFile: pidFilePath(repoRoot),
      metaFile: metaFilePath(repoRoot),
      logFile: logFilePath(repoRoot),
      reason: "Failed to spawn watcher process",
    };
  }

  const startedAt = new Date().toISOString();
  const meta: WatcherMeta = {
    pid: child.pid,
    startedAt,
    lastHeartbeat: startedAt,
    cliVersion,
  };

  await fs.writeFile(pidFilePath(repoRoot), `${child.pid}\n`, "utf-8");
  await writeWatcherMeta(repoRoot, meta);

  // Detach from the child so the parent can exit cleanly.
  child.unref();

  // Best-effort: update the config's capture_mode to "watcher".
  await setCaptureMode(repoRoot, "watcher").catch(() => undefined);

  return {
    started: true,
    alreadyRunning: false,
    pid: child.pid,
    pidFile: pidFilePath(repoRoot),
    metaFile: metaFilePath(repoRoot),
    logFile: logFilePath(repoRoot),
    reason: "Watcher started in background",
  };
}

/**
 * Resolve the kodela binary that should be invoked when spawning the daemon.
 *
 * When the CLI is run via the bundled cjs binary (the production path), we
 * use `process.argv[1]` directly.  When run via tsx (development / tests),
 * we fall back to invoking node with the same argv[1].
 */
function resolveKodelaBin(): string {
  // Honour explicit override.
  const override = process.env["KODELA_BIN"];
  if (override) return override;

  // In production, argv[1] is the bundled binary path.
  return process.argv[1] ?? "kodela";
}

/**
 * Returns false for paths that obviously cannot be a runnable kodela CLI:
 * TypeScript sources (`.ts`/`.tsx`), test files (`.test.*`), and the npm
 * placeholder string `"kodela"` when no real bin exists in PATH.  Used by
 * `runWatchDetach` to skip a spawn that would EACCES or recurse into the
 * test runner.
 */
function isExecutableKodelaBin(binPath: string | undefined): boolean {
  if (!binPath) return false;
  // `.test.ts`, `.test.tsx`, `.test.js`, `.test.mts`, `.test.cts` etc.
  if (/\.test\.[a-z]+$/i.test(binPath)) return false;
  // Raw TypeScript source — would need a loader to run.
  if (/\.(ts|tsx|mts|cts)$/i.test(binPath)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

export function formatWatchStatus(status: WatcherStatus): string {
  switch (status.state) {
    case "stopped":
      return [
        "● Watcher: stopped",
        "  Start with: kodela watch --auto-annotate --detach",
      ].join("\n");
    case "stopped-stale":
      return [
        `● Watcher: stopped (stale PID ${status.pid})`,
        `  ${status.reason}`,
        "  Start with: kodela watch --auto-annotate --detach",
      ].join("\n");
    case "degraded":
      return [
        `● Watcher: degraded (pid=${status.pid})`,
        `  Started: ${status.startedAt}`,
        `  Last heartbeat: ${status.lastHeartbeat}`,
        `  Log file: ${status.logFile}`,
        `  ${status.reason}`,
      ].join("\n");
    case "running":
      return [
        `● Watcher: running (pid=${status.pid}, uptime=${formatUptime(status.uptimeMs)})`,
        `  Started: ${status.startedAt}`,
        `  Last heartbeat: ${status.lastHeartbeat}`,
        `  Log file: ${status.logFile}`,
      ].join("\n");
  }
}

export function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

export function formatWatchDetachResult(result: WatchDetachResult): string {
  const lines: string[] = [];
  if (result.alreadyRunning) {
    lines.push(`⚠ ${result.reason}`);
    lines.push("  Use `kodela watch stop` to stop the existing instance first.");
    // The watcher IS running, so route through the shared capture-path
    // block so onboarding guidance stays consistent across surfaces.
    lines.push("");
    lines.push(
      renderCapturePathBlock({
        active: "watcher",
        hooksInstalled: false,
        watcherRunning: true,
      }),
    );
    return lines.join("\n");
  }
  if (!result.started) {
    lines.push(`✖ ${result.reason}`);
    return lines.join("\n");
  }
  lines.push(`✔ Watcher started in background (pid=${result.pid})`);
  lines.push(`  Logs: ${result.logFile}`);
  lines.push(
    "  Note: this process will stop if manually killed or the system restarts.",
  );
  lines.push("  Use `kodela watch status` to verify.");
  lines.push("");
  lines.push(
    renderCapturePathBlock({
      active: "watcher",
      hooksInstalled: false,
      watcherRunning: true,
    }),
  );
  return lines.join("\n");
}

export function formatWatchStopResult(result: WatchStopResult): string {
  const lines: string[] = [];
  if (result.alreadyStopped) {
    lines.push(`● ${result.reason}`);
  } else if (result.stopped) {
    lines.push(`✔ ${result.reason} (pid=${result.signaledPid ?? "?"})`);
  } else {
    lines.push(`✖ ${result.reason} (pid=${result.signaledPid ?? "?"})`);
  }
  if (result.supervisorNotes && result.supervisorNotes.length > 0) {
    lines.push("Supervisor:");
    for (const note of result.supervisorNotes) {
      lines.push(`  ${note}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Supervised-watcher self-registration
// ---------------------------------------------------------------------------

/**
 * Called by `runWatch` when started under a supervisor (KODELA_WATCHER_SUPERVISED=1).
 * Writes the PID + meta files so `kodela watch status` works the same way it does
 * for the unsupervised `--detach` daemon.  The supervisor itself owns restart
 * policy; we only own the on-disk lifecycle markers.
 */
export async function registerSupervisedWatcher(
  repoRoot: string,
  cliVersion: string,
): Promise<void> {
  const startedAt = new Date().toISOString();
  await fs.mkdir(path.join(repoRoot, KODELA_DIR), { recursive: true });
  await fs.writeFile(pidFilePath(repoRoot), `${process.pid}\n`, "utf-8");
  await writeWatcherMeta(repoRoot, {
    pid: process.pid,
    startedAt,
    lastHeartbeat: startedAt,
    cliVersion,
  });
}

// ---------------------------------------------------------------------------
// Supervisor module re-exports — kept here so callers depend on a single
// `watch-daemon` entrypoint for all watcher-lifecycle helpers.
// ---------------------------------------------------------------------------

export {
  installSupervisor,
  removeSupervisor,
  supervisorStatus,
  formatSupervisorStatus,
  formatInstallSupervisorResult,
  formatRemoveSupervisorResult,
  detectSupervisorPlatform,
  supervisorLabel,
  supervisorServicePath,
  type InstallSupervisorOptions,
  type InstallSupervisorResult,
  type RemoveSupervisorOptions,
  type RemoveSupervisorResult,
  type SupervisorStatusOptions,
  type SupervisorStatusResult,
  type SupervisorPlatform,
  type SupervisorEnv,
} from "./watch-supervisor.js";
