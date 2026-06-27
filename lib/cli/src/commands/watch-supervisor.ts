// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Per-platform watcher supervision (Task #2).
 *
 * The default `kodela watch --detach` daemon is unsupervised: if it crashes or
 * the developer reboots, it stays stopped until the user re-runs the command.
 * `installSupervisor` registers a per-platform service that:
 *
 *   - macOS  → writes a launchd LaunchAgent plist in
 *              `~/Library/LaunchAgents/dev.kodela.watcher.<repo-hash>.plist`
 *              and (best-effort) `launchctl bootstrap`s it.
 *   - Linux  → writes a systemd user unit in
 *              `~/.config/systemd/user/dev.kodela.watcher.<repo-hash>.service`
 *              and (best-effort) `systemctl --user enable --now`s it.
 *   - Windows→ writes a Scheduled Task XML to
 *              `.kodela/supervisor-<label>.xml` and (best-effort)
 *              `schtasks /create /xml ...`s it.
 *
 * The actual platform commands are best-effort: if `launchctl` / `systemctl` /
 * `schtasks` aren't on `PATH`, we still write the file and surface the missing
 * activation step in the result `notes` so the operator can finish manually.
 *
 * Supervision is opt-in (`kodela watch --supervise` / `kodela setup
 * --supervise`).  Removal is symmetric: `removeSupervisor` deactivates the
 * service and deletes the unit file.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { logFilePath } from "./watch-daemon.js";

export const SUPERVISOR_LABEL_PREFIX = "dev.kodela.watcher";

export type SupervisorPlatform = "launchd" | "systemd" | "schtasks";

export type SupervisorEnv = {
  platform?: NodeJS.Platform;
  home?: string;
  /** Skip the activation command (used by tests + --print-only). */
  skipActivate?: boolean;
};

// ---------------------------------------------------------------------------
// Platform / path helpers
// ---------------------------------------------------------------------------

export function detectSupervisorPlatform(
  plat: NodeJS.Platform = process.platform,
): SupervisorPlatform | null {
  switch (plat) {
    case "darwin":
      return "launchd";
    case "linux":
      return "systemd";
    case "win32":
      return "schtasks";
    default:
      return null;
  }
}

/** Stable short hash of the absolute repo path — used to scope the service. */
export function repoHash(repoRoot: string): string {
  return crypto
    .createHash("sha256")
    .update(path.resolve(repoRoot))
    .digest("hex")
    .slice(0, 12);
}

export function supervisorLabel(repoRoot: string): string {
  return `${SUPERVISOR_LABEL_PREFIX}.${repoHash(repoRoot)}`;
}

function resolveHome(env: SupervisorEnv): string {
  return env.home ?? os.homedir();
}

export function supervisorServicePath(
  repoRoot: string,
  platform: SupervisorPlatform,
  env: SupervisorEnv = {},
): string {
  const label = supervisorLabel(repoRoot);
  const home = resolveHome(env);
  switch (platform) {
    case "launchd":
      return path.join(home, "Library", "LaunchAgents", `${label}.plist`);
    case "systemd":
      return path.join(
        home,
        ".config",
        "systemd",
        "user",
        `${label}.service`,
      );
    case "schtasks":
      return path.join(repoRoot, ".kodela", `supervisor-${label}.xml`);
  }
}

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type RenderTemplateOptions = {
  platform: SupervisorPlatform;
  label: string;
  binPath: string;
  args: string[];
  repoRoot: string;
  logFile: string;
  envOverrides?: Record<string, string>;
};

export function renderSupervisorFile(opts: RenderTemplateOptions): string {
  switch (opts.platform) {
    case "launchd":
      return renderLaunchdPlist(opts);
    case "systemd":
      return renderSystemdUnit(opts);
    case "schtasks":
      return renderSchtasksXml(opts);
  }
}

function supervisorEnvVars(opts: RenderTemplateOptions): Array<[string, string]> {
  const merged: Record<string, string> = {
    ...(opts.envOverrides ?? {}),
    KODELA_WATCHER_SUPERVISED: "1",
    KODELA_WATCHER_REPO_ROOT: opts.repoRoot,
  };

  return Object.entries(merged).filter(
    ([key, value]) => key.trim().length > 0 && value.trim().length > 0,
  );
}

function renderLaunchdPlist(opts: RenderTemplateOptions): string {
  const args = ["watch", ...opts.args];
  const argsXml = [opts.binPath, ...args]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");
  const envXml = supervisorEnvVars(opts)
    .flatMap(([key, value]) => [
      `    <key>${xmlEscape(key)}</key>`,
      `    <string>${xmlEscape(value)}</string>`,
    ])
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${xmlEscape(opts.label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    argsXml,
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xmlEscape(opts.repoRoot)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>5</integer>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xmlEscape(opts.logFile)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xmlEscape(opts.logFile)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    envXml,
    `  </dict>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

function shellEscape(s: string): string {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * Quote a value for a systemd unit field per systemd.unit(5)'s double-quoted
 * string syntax: wrap in `"…"` and escape `\`, `"`, and any newline chars.
 * Returns the bare value unchanged when it's already safe (no whitespace or
 * special chars), so generated units stay readable in the common case.
 */
function systemdQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./:=]+$/.test(s)) return s;
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

function renderSystemdUnit(opts: RenderTemplateOptions): string {
  const args = ["watch", ...opts.args].map(shellEscape).join(" ");
  const envLines = supervisorEnvVars(opts).map(
    ([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`,
  );
  return [
    `[Unit]`,
    `Description=Kodela watcher (${opts.repoRoot})`,
    `After=default.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `WorkingDirectory=${systemdQuote(opts.repoRoot)}`,
    `ExecStart=${shellEscape(opts.binPath)} ${args}`,
    `Restart=always`,
    `RestartSec=5`,
    ...envLines,
    `StandardOutput=append:${systemdQuote(opts.logFile)}`,
    `StandardError=append:${systemdQuote(opts.logFile)}`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n");
}

/**
 * Quote a value for inclusion in a Windows `cmd.exe /c "..."` command line.
 * Returns the bare value when it's already safe (alphanumerics + a few path
 * chars).  Otherwise wraps in `"…"`, which cmd treats as literal as long as
 * the value itself contains no embedded `"`.  Windows file paths cannot
 * contain a literal `"`, so this is sufficient for repoRoot and binPath.
 */
function cmdQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./:\\]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function renderSchtasksXml(opts: RenderTemplateOptions): string {
  // Task Scheduler XML has no Environment field, so wrap the launch in
  // `cmd.exe /c ...` and `set "K=V"` the supervised-mode env vars before
  // exec'ing kodela.  This mirrors the `KODELA_WATCHER_SUPERVISED=1` /
  // `KODELA_WATCHER_REPO_ROOT=<root>` markers that launchd and systemd set
  // on the other platforms — without them, the child watcher does not
  // self-register PID/meta and `kodela watch status`/`stop` cannot see it.
  const watchArgs = ["watch", ...opts.args].map(cmdQuote).join(" ");
  const envCmd = supervisorEnvVars(opts).map(
    ([key, value]) => `set "${key}=${value.replace(/"/g, '""')}"`,
  );
  const cmdLine = [
    ...envCmd,
    `${cmdQuote(opts.binPath)} ${watchArgs}`,
  ].join(" && ");
  const argLine = `/c ${cmdLine}`;
  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo>`,
    `    <Description>Kodela watcher (${xmlEscape(opts.repoRoot)})</Description>`,
    `  </RegistrationInfo>`,
    `  <Triggers>`,
    `    <LogonTrigger>`,
    `      <Enabled>true</Enabled>`,
    `    </LogonTrigger>`,
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author">`,
    `      <LogonType>InteractiveToken</LogonType>`,
    `      <RunLevel>LeastPrivilege</RunLevel>`,
    `    </Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <AllowHardTerminate>true</AllowHardTerminate>`,
    `    <StartWhenAvailable>true</StartWhenAvailable>`,
    `    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>`,
    `    <IdleSettings>`,
    `      <StopOnIdleEnd>false</StopOnIdleEnd>`,
    `      <RestartOnIdle>false</RestartOnIdle>`,
    `    </IdleSettings>`,
    `    <AllowStartOnDemand>true</AllowStartOnDemand>`,
    `    <Enabled>true</Enabled>`,
    `    <Hidden>false</Hidden>`,
    `    <RunOnlyIfIdle>false</RunOnlyIfIdle>`,
    `    <WakeToRun>false</WakeToRun>`,
    `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
    `    <Priority>7</Priority>`,
    `    <RestartOnFailure>`,
    `      <Interval>PT1M</Interval>`,
    `      <Count>3</Count>`,
    `    </RestartOnFailure>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>cmd.exe</Command>`,
    `      <Arguments>${xmlEscape(argLine)}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(opts.repoRoot)}</WorkingDirectory>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Subprocess helper
// ---------------------------------------------------------------------------

type RunResult = { ok: boolean; stdout: string; stderr: string; code: number | null };

async function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (err) {
      resolve({
        ok: false,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        code: null,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      resolve({ ok: false, stdout, stderr: stderr + err.message, code: null });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export type InstallSupervisorOptions = {
  repoRoot: string;
  cliVersion: string;
  /** Path to the kodela executable to invoke. Defaults to argv resolution. */
  binPath?: string;
  /** Extra args forwarded to `kodela watch` (e.g. ["--auto-annotate"]). */
  extraArgs?: string[];
  /** Optional environment overrides forwarded to the supervised watcher. */
  envOverrides?: Record<string, string>;
  /** Overwrite an existing supervisor file if present. */
  force?: boolean;
  /** Test / dry-run hooks. */
  env?: SupervisorEnv;
};

export type InstallSupervisorResult = {
  installed: boolean;
  alreadyInstalled: boolean;
  activated: boolean;
  servicePath: string;
  label: string;
  platform: SupervisorPlatform | null;
  notes: string[];
  reason: string;
};

export async function installSupervisor(
  opts: InstallSupervisorOptions,
): Promise<InstallSupervisorResult> {
  const env = opts.env ?? {};
  const platform = detectSupervisorPlatform(env.platform);
  const label = supervisorLabel(opts.repoRoot);

  if (platform === null) {
    return {
      installed: false,
      alreadyInstalled: false,
      activated: false,
      servicePath: "",
      label,
      platform: null,
      notes: [],
      reason: `Supervision is not supported on platform "${env.platform ?? process.platform}".`,
    };
  }

  const servicePath = supervisorServicePath(opts.repoRoot, platform, env);
  const binPath = opts.binPath ?? resolveSupervisedBin();
  const extraArgs = opts.extraArgs ?? ["--auto-annotate"];
  const logFile = logFilePath(opts.repoRoot);
  const inheritedEnvOverrides: Record<string, string> = {
    ...(process.env["KODELA_AGENT"]?.trim()
      ? { KODELA_AGENT: process.env["KODELA_AGENT"].trim() }
      : {}),
    ...(process.env["KODELA_GOAL"]?.trim()
      ? { KODELA_GOAL: process.env["KODELA_GOAL"].trim() }
      : {}),
    ...(process.env["KODELA_AUTHOR"]?.trim()
      ? { KODELA_AUTHOR: process.env["KODELA_AUTHOR"].trim() }
      : {}),
    ...(opts.envOverrides ?? {}),
  };

  const content = renderSupervisorFile({
    platform,
    label,
    binPath,
    args: extraArgs,
    repoRoot: opts.repoRoot,
    logFile,
    envOverrides: inheritedEnvOverrides,
  });

  const exists = await fileExists(servicePath);
  if (exists && !opts.force) {
    // File on disk but possibly inactive (e.g. after `kodela watch stop`,
    // which deactivates without removing).  Honour the documented UX
    // "re-enable with `kodela watch --supervise`" by attempting activation
    // here — but never rewriting the file (use --force for that).
    const status = await supervisorStatus({ repoRoot: opts.repoRoot, env });
    const wasActive = status.state === "installed-active";
    const notes: string[] = [
      `Supervisor file already exists at ${servicePath} (use --force to overwrite).`,
    ];
    let activated = wasActive;
    let reason = "Supervisor already installed and active";

    if (wasActive) {
      notes.push("Supervisor already active.");
    } else if (env.skipActivate) {
      notes.push("Skipped activation (--print-only or test override).");
      reason = "Supervisor already installed (activation skipped)";
    } else {
      const activation = await activateSupervisor({
        platform,
        label,
        servicePath,
      });
      activated = activation.ok;
      notes.push(activation.detail);
      if (activated) {
        reason = `Re-activated existing supervisor (${platform}).`;
      } else {
        notes.push(manualActivationHint(platform, { servicePath, label }));
        reason = "Supervisor already installed but activation failed — see notes";
      }
    }

    return {
      installed: false,
      alreadyInstalled: true,
      activated,
      servicePath,
      label,
      platform,
      notes,
      reason,
    };
  }

  await fs.mkdir(path.dirname(servicePath), { recursive: true });
  if (platform === "schtasks") {
    // `schtasks /Create /XML` expects UTF-16 LE with a BOM, matching the
    // `<?xml ... encoding="UTF-16"?>` declaration in the rendered template.
    // Writing UTF-8 here would mismatch the declaration and break import
    // on real Windows hosts, so we encode to UTF-16 LE with a BOM explicitly.
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.from(content, "utf16le");
    await fs.writeFile(servicePath, Buffer.concat([bom, body]));
  } else {
    await fs.writeFile(servicePath, content, "utf-8");
  }
  // Best-effort: also ensure .kodela/ exists so the log file path is writable.
  await fs.mkdir(path.join(opts.repoRoot, ".kodela"), { recursive: true });

  const notes: string[] = [`Wrote ${servicePath}`];
  let activated = false;

  if (env.skipActivate) {
    notes.push("Skipped activation (--print-only or test override).");
    notes.push(
      manualActivationHint(platform, { servicePath, label }),
    );
  } else {
    const activation = await activateSupervisor({
      platform,
      label,
      servicePath,
    });
    activated = activation.ok;
    if (activated) {
      notes.push(activation.detail);
    } else {
      notes.push(activation.detail);
      notes.push(manualActivationHint(platform, { servicePath, label }));
    }
  }

  return {
    installed: true,
    alreadyInstalled: false,
    activated,
    servicePath,
    label,
    platform,
    notes,
    reason: activated
      ? `Supervisor installed and activated (${platform}).`
      : `Supervisor file written (${platform}); activation deferred — see notes.`,
  };
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export type RemoveSupervisorOptions = {
  repoRoot: string;
  env?: SupervisorEnv;
};

export type RemoveSupervisorResult = {
  removed: boolean;
  alreadyRemoved: boolean;
  deactivated: boolean;
  servicePath: string;
  label: string;
  platform: SupervisorPlatform | null;
  notes: string[];
  reason: string;
};

export async function removeSupervisor(
  opts: RemoveSupervisorOptions,
): Promise<RemoveSupervisorResult> {
  const env = opts.env ?? {};
  const platform = detectSupervisorPlatform(env.platform);
  const label = supervisorLabel(opts.repoRoot);

  if (platform === null) {
    return {
      removed: false,
      alreadyRemoved: true,
      deactivated: false,
      servicePath: "",
      label,
      platform: null,
      notes: [],
      reason: `Supervision is not supported on platform "${env.platform ?? process.platform}".`,
    };
  }

  const servicePath = supervisorServicePath(opts.repoRoot, platform, env);
  const exists = await fileExists(servicePath);

  if (!exists) {
    return {
      removed: false,
      alreadyRemoved: true,
      deactivated: false,
      servicePath,
      label,
      platform,
      notes: [`No supervisor file at ${servicePath}`],
      reason: "Supervisor was not installed",
    };
  }

  const notes: string[] = [];
  let deactivated = false;

  if (!env.skipActivate) {
    const result = await deactivateSupervisor({ platform, label, servicePath });
    deactivated = result.ok;
    notes.push(result.detail);
    // schtasks deactivate uses /Change /DISABLE which keeps the task
    // registration in Task Scheduler — for a full uninstall (this code
    // path), we additionally /Delete the task so nothing is left behind.
    const uninstall = await uninstallSupervisorService({ platform, label });
    if (uninstall) notes.push(uninstall.detail);
  } else {
    notes.push("Skipped deactivation (--print-only or test override).");
  }

  await fs.unlink(servicePath).catch(() => undefined);
  notes.push(`Deleted ${servicePath}`);

  return {
    removed: true,
    alreadyRemoved: false,
    deactivated,
    servicePath,
    label,
    platform,
    notes,
    reason: `Supervisor removed (${platform}).`,
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type SupervisorStatusOptions = {
  repoRoot: string;
  env?: SupervisorEnv;
};

export type SupervisorStatusResult =
  | {
      state: "unsupported";
      platform: NodeJS.Platform;
      reason: string;
    }
  | {
      state: "not-installed";
      platform: SupervisorPlatform;
      servicePath: string;
      label: string;
    }
  | {
      state: "installed-inactive";
      platform: SupervisorPlatform;
      servicePath: string;
      label: string;
      reason: string;
    }
  | {
      state: "installed-active";
      platform: SupervisorPlatform;
      servicePath: string;
      label: string;
      detail: string;
    };

export async function supervisorStatus(
  opts: SupervisorStatusOptions,
): Promise<SupervisorStatusResult> {
  const env = opts.env ?? {};
  const platform = detectSupervisorPlatform(env.platform);
  const label = supervisorLabel(opts.repoRoot);

  if (platform === null) {
    return {
      state: "unsupported",
      platform: env.platform ?? process.platform,
      reason: `Watcher supervision is not supported on this platform.`,
    };
  }

  const servicePath = supervisorServicePath(opts.repoRoot, platform, env);
  if (!(await fileExists(servicePath))) {
    return { state: "not-installed", platform, servicePath, label };
  }

  if (env.skipActivate) {
    // Tests / dry-run: don't shell out — assume inactive without a probe.
    return {
      state: "installed-inactive",
      platform,
      servicePath,
      label,
      reason: "Probe skipped (test override)",
    };
  }

  const probe = await probeActiveSupervisor({ platform, label, servicePath });
  if (probe.active === true) {
    return {
      state: "installed-active",
      platform,
      servicePath,
      label,
      detail: probe.detail,
    };
  }
  return {
    state: "installed-inactive",
    platform,
    servicePath,
    label,
    reason: probe.detail,
  };
}

// ---------------------------------------------------------------------------
// Platform-specific activation / deactivation / probing
// ---------------------------------------------------------------------------

async function activateSupervisor(opts: {
  platform: SupervisorPlatform;
  label: string;
  servicePath: string;
}): Promise<{ ok: boolean; detail: string }> {
  switch (opts.platform) {
    case "launchd": {
      const uid = process.getuid?.() ?? 0;
      const r = await runCommand("launchctl", [
        "bootstrap",
        `gui/${uid}`,
        opts.servicePath,
      ]);
      if (r.ok) return { ok: true, detail: `launchctl bootstrap succeeded for ${opts.label}` };
      // bootstrap may fail with "Bootstrap failed: 17 (File exists)" when
      // already loaded — fall back to plain `load` for older macOS.
      const fallback = await runCommand("launchctl", [
        "load",
        "-w",
        opts.servicePath,
      ]);
      if (fallback.ok) return { ok: true, detail: `launchctl load succeeded for ${opts.label}` };
      return {
        ok: false,
        detail: `launchctl bootstrap/load failed: ${(r.stderr || fallback.stderr).trim() || `exit ${r.code}`}`,
      };
    }
    case "systemd": {
      const reload = await runCommand("systemctl", ["--user", "daemon-reload"]);
      if (!reload.ok) {
        return {
          ok: false,
          detail: `systemctl --user daemon-reload failed: ${reload.stderr.trim() || `exit ${reload.code}`}`,
        };
      }
      const enable = await runCommand("systemctl", [
        "--user",
        "enable",
        "--now",
        `${opts.label}.service`,
      ]);
      if (enable.ok) {
        return { ok: true, detail: `systemctl --user enable --now succeeded for ${opts.label}.service` };
      }
      return {
        ok: false,
        detail: `systemctl --user enable --now failed: ${enable.stderr.trim() || `exit ${enable.code}`}`,
      };
    }
    case "schtasks": {
      const r = await runCommand("schtasks", [
        "/Create",
        "/TN",
        opts.label,
        "/XML",
        opts.servicePath,
        "/F",
      ]);
      if (r.ok) return { ok: true, detail: `schtasks /Create succeeded for ${opts.label}` };
      return {
        ok: false,
        detail: `schtasks /Create failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      };
    }
  }
}

/**
 * Deactivate a supervisor without deleting the unit file.  Used by
 * `kodela watch stop` so the operator can re-enable later without re-running
 * `kodela watch --supervise`.  Resolves to `{state: "not-installed"}` if no
 * supervisor file exists, so callers can treat it as a safe no-op.
 */
export async function deactivateSupervisorOnly(opts: {
  repoRoot: string;
  env?: SupervisorEnv;
}): Promise<{
  deactivated: boolean;
  alreadyInactive: boolean;
  servicePath: string;
  label: string;
  platform: SupervisorPlatform | null;
  detail: string;
}> {
  const env = opts.env ?? {};
  const platform = detectSupervisorPlatform(env.platform);
  const label = supervisorLabel(opts.repoRoot);
  if (platform === null) {
    return {
      deactivated: false,
      alreadyInactive: true,
      servicePath: "",
      label,
      platform: null,
      detail: "Supervision not supported on this platform",
    };
  }
  const servicePath = supervisorServicePath(opts.repoRoot, platform, env);
  if (!(await fileExists(servicePath))) {
    return {
      deactivated: false,
      alreadyInactive: true,
      servicePath,
      label,
      platform,
      detail: "No supervisor unit file installed",
    };
  }
  if (env.skipActivate) {
    return {
      deactivated: false,
      alreadyInactive: false,
      servicePath,
      label,
      platform,
      detail: "Skipped deactivation (--print-only or test override)",
    };
  }
  const result = await deactivateSupervisor({ platform, label, servicePath });
  return {
    deactivated: result.ok,
    alreadyInactive: false,
    servicePath,
    label,
    platform,
    detail: result.detail,
  };
}

async function deactivateSupervisor(opts: {
  platform: SupervisorPlatform;
  label: string;
  servicePath: string;
}): Promise<{ ok: boolean; detail: string }> {
  switch (opts.platform) {
    case "launchd": {
      const uid = process.getuid?.() ?? 0;
      const r = await runCommand("launchctl", [
        "bootout",
        `gui/${uid}`,
        opts.servicePath,
      ]);
      if (r.ok) return { ok: true, detail: `launchctl bootout succeeded for ${opts.label}` };
      const fallback = await runCommand("launchctl", [
        "unload",
        "-w",
        opts.servicePath,
      ]);
      if (fallback.ok) return { ok: true, detail: `launchctl unload succeeded for ${opts.label}` };
      return {
        ok: false,
        detail: `launchctl bootout/unload failed: ${(r.stderr || fallback.stderr).trim() || `exit ${r.code}`}`,
      };
    }
    case "systemd": {
      const r = await runCommand("systemctl", [
        "--user",
        "disable",
        "--now",
        `${opts.label}.service`,
      ]);
      if (r.ok) return { ok: true, detail: `systemctl --user disable --now succeeded for ${opts.label}.service` };
      return {
        ok: false,
        detail: `systemctl --user disable --now failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      };
    }
    case "schtasks": {
      // `kodela watch stop` calls deactivate and expects to be reversible by
      // re-running `kodela watch --supervise`.  `/Delete` would unregister
      // the task entirely, breaking that round-trip — use `/Change /DISABLE`
      // so the registration stays and re-activation can simply re-enable.
      const r = await runCommand("schtasks", [
        "/Change",
        "/TN",
        opts.label,
        "/DISABLE",
      ]);
      if (r.ok) {
        return {
          ok: true,
          detail: `schtasks /Change /DISABLE succeeded for ${opts.label}`,
        };
      }
      return {
        ok: false,
        detail: `schtasks /Change /DISABLE failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      };
    }
  }
}

/**
 * Fully unregister the supervisor service from the host's user-level service
 * manager.  Called only by `removeSupervisor` (i.e. from `--remove-supervisor`
 * or `unsupervise`), never by `watch stop`.  On launchd/systemd the previous
 * deactivate step (`bootout` / `disable --now`) already unregistered the
 * service, so we only need an extra step on Windows where the equivalent
 * deactivate path is `/Change /DISABLE` (which keeps the registration).
 */
async function uninstallSupervisorService(opts: {
  platform: SupervisorPlatform;
  label: string;
}): Promise<{ ok: boolean; detail: string } | null> {
  if (opts.platform !== "schtasks") return null;
  const r = await runCommand("schtasks", ["/Delete", "/TN", opts.label, "/F"]);
  if (r.ok) {
    return { ok: true, detail: `schtasks /Delete succeeded for ${opts.label}` };
  }
  return {
    ok: false,
    detail: `schtasks /Delete failed: ${r.stderr.trim() || `exit ${r.code}`}`,
  };
}

async function probeActiveSupervisor(opts: {
  platform: SupervisorPlatform;
  label: string;
  servicePath: string;
}): Promise<{ active: boolean | null; detail: string }> {
  switch (opts.platform) {
    case "launchd": {
      const r = await runCommand("launchctl", ["list", opts.label]);
      if (r.ok) {
        return { active: true, detail: "launchctl list reports the agent loaded" };
      }
      return {
        active: false,
        detail: `launchctl list ${opts.label} → exit ${r.code}: ${r.stderr.trim() || "not loaded"}`,
      };
    }
    case "systemd": {
      const r = await runCommand("systemctl", [
        "--user",
        "is-active",
        `${opts.label}.service`,
      ]);
      const out = (r.stdout || "").trim();
      if (out === "active") {
        return { active: true, detail: "systemctl --user is-active reports active" };
      }
      return { active: false, detail: `systemctl --user is-active → ${out || `exit ${r.code}`}` };
    }
    case "schtasks": {
      const r = await runCommand("schtasks", ["/Query", "/TN", opts.label]);
      if (r.ok) {
        const text = r.stdout.toLowerCase();
        // After `kodela watch stop` the task remains registered but its
        // Status is "Disabled" (we used /Change /DISABLE).  Treat that as
        // inactive so `watch status` and `doctor` reflect reality.
        if (text.includes("disabled")) {
          return {
            active: false,
            detail: "schtasks /Query: task is registered but Disabled",
          };
        }
        if (text.includes("running")) {
          return { active: true, detail: "schtasks /Query reports task running" };
        }
        return { active: true, detail: "schtasks /Query: task is registered" };
      }
      return { active: false, detail: `schtasks /Query → exit ${r.code}: ${r.stderr.trim() || "task not found"}` };
    }
  }
}

function manualActivationHint(
  platform: SupervisorPlatform,
  args: { servicePath: string; label: string },
): string {
  switch (platform) {
    case "launchd":
      return `Manual activation: launchctl bootstrap gui/$(id -u) ${args.servicePath}`;
    case "systemd":
      return `Manual activation: systemctl --user daemon-reload && systemctl --user enable --now ${args.label}.service`;
    case "schtasks":
      return `Manual activation: schtasks /Create /TN ${args.label} /XML ${args.servicePath} /F`;
  }
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

export function formatSupervisorStatus(status: SupervisorStatusResult): string {
  switch (status.state) {
    case "unsupported":
      return `● Supervisor: unsupported on ${status.platform} — ${status.reason}`;
    case "not-installed":
      return [
        `● Supervisor: not installed (${status.platform})`,
        `  Install with: kodela watch --supervise`,
      ].join("\n");
    case "installed-inactive":
      return [
        `● Supervisor: installed but inactive (${status.platform})`,
        `  File: ${status.servicePath}`,
        `  ${status.reason}`,
      ].join("\n");
    case "installed-active":
      return [
        `● Supervisor: active (${status.platform})`,
        `  File: ${status.servicePath}`,
        `  ${status.detail}`,
      ].join("\n");
  }
}

export function formatInstallSupervisorResult(
  result: InstallSupervisorResult,
): string {
  const lines: string[] = [];
  if (result.platform === null) {
    lines.push(`✖ ${result.reason}`);
    return lines.join("\n");
  }
  if (result.alreadyInstalled) {
    lines.push(`● ${result.reason} (${result.servicePath})`);
  } else if (result.installed) {
    const glyph = result.activated ? "✔" : "⚠";
    lines.push(`${glyph} ${result.reason}`);
  } else {
    lines.push(`✖ ${result.reason}`);
  }
  for (const note of result.notes) {
    lines.push(`  ${note}`);
  }
  return lines.join("\n");
}

export function formatRemoveSupervisorResult(
  result: RemoveSupervisorResult,
): string {
  const lines: string[] = [];
  if (result.platform === null) {
    lines.push(`✖ ${result.reason}`);
    return lines.join("\n");
  }
  if (result.alreadyRemoved) {
    lines.push(`● ${result.reason}`);
  } else if (result.removed) {
    lines.push(`✔ ${result.reason}`);
  }
  for (const note of result.notes) {
    lines.push(`  ${note}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function resolveSupervisedBin(): string {
  const override = process.env["KODELA_BIN"];
  if (override) return override;
  return process.argv[1] ?? "kodela";
}
