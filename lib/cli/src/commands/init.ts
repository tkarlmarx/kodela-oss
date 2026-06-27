// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { initBaseline, isBaselineInitialized, KodelaError } from "@kodela/core";
import {
  writeDefaultConfig,
  writeDefaultKodelaignore,
  writeGettingStartedMd,
} from "../config/loader.js";
import { fileExists } from "../utils/repo.js";
import { renderCapturePathBlock } from "../output/messaging.js";
import { runInstallHooks } from "./install-hooks.js";
import { runWatchDetach } from "./watch-daemon.js";
import { installSupervisor } from "./watch-supervisor.js";
import { randomBytes } from "node:crypto";
import {
  appendFile,
  chmod,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export type InitOptions = {
  force?: boolean;
  /**
   * Gap 78 — When true, skip automatic git hook installation.
   * Useful for CI environments, containerized setups, or repos that manage
   * .git/hooks through a separate tool (Husky, Lefthook, simple-git-hooks).
   */
  noHooks?: boolean;
  /**
   * doc 21 R4 — When true, do NOT start the background auto-annotate watcher.
   * By default init starts it so capture is silent and tool-agnostic.
   */
  noDaemon?: boolean;
  /**
   * doc 21 R4 — When true, also install a launchd/systemd supervisor so the
   * watcher survives reboots/crashes. Opt-in (registering a system service on
   * every init is too invasive a default; the watcher itself starts regardless).
   */
  supervise?: boolean;
  /**
   * doc 27 §E.7 — When true, do NOT generate a per-repo master key file.
   * Default (false) writes `<repoRoot>/.kodela.master-key` (32 random bytes,
   * base64-encoded, mode 0600) and adds it to .gitignore — this turns
   * field-level encryption-at-rest on by default for any repo onboarded with
   * `kodela init`.  Opt-out is honoured for SaaS-mode deployments (the env
   * var path is used instead) and for customers who explicitly choose
   * plaintext local storage.
   */
  noEncryption?: boolean;
  /** CLI version recorded in the watcher meta file. */
  cliVersion?: string;
};

export type InitResult = {
  repoRoot: string;
  alreadyExisted: boolean;
  configWritten: boolean;
  kodelaignoreWritten: boolean;
  gettingStartedWritten: boolean;
  trackedFiles: number;
  /** Gap 78 — whether git hooks were installed during this init run. */
  hooksInstalled: boolean;
  /** Gap 78 — set when hook installation was skipped via --no-hooks. */
  hooksSkipped: boolean;
  /**
   * doc 21 R4 — the always-on auto-annotate watcher (silent capture).
   * Optional so synthetic InitResults (e.g. from `kodela setup`) need not set them.
   */
  watcherStarted?: boolean;
  watcherAlreadyRunning?: boolean;
  watcherSkipped?: boolean;
  watcherSupervised?: boolean;
  watcherReason?: string;
  /** doc 27 §E.7 — encryption-key-file outcome. */
  masterKeyWritten?: boolean;
  /** True if the key file already existed (idempotent re-run of init). */
  masterKeyAlreadyExisted?: boolean;
  /** True when --no-encryption was passed (no key file written). */
  encryptionSkipped?: boolean;
};

const MASTER_KEY_FILE = ".kodela.master-key";
const MASTER_KEY_HISTORICAL_GLOB = ".kodela.master-key-*";

/**
 * doc 27 §E.7 — generate the per-repo master key file used by
 * `lib/core/src/audit/encryption.ts` for AES-256-GCM field encryption.
 *
 * - Idempotent: if `<repoRoot>/.kodela.master-key` already exists, returns
 *   `alreadyExisted: true` and does NOT overwrite it (overwriting would
 *   silently corrupt every encrypted entry on disk).
 * - Writes mode 0600 so the key isn't world-readable on shared dev boxes.
 * - Adds the key file (current + historical) to .gitignore so it never
 *   leaks into the repo.
 */
async function ensureMasterKey(repoRoot: string): Promise<{
  written: boolean;
  alreadyExisted: boolean;
}> {
  const keyPath = path.join(repoRoot, MASTER_KEY_FILE);
  if (await fileExists(keyPath)) {
    return { written: false, alreadyExisted: true };
  }
  const key = randomBytes(32).toString("base64");
  await writeFile(keyPath, `${key}\n`, { mode: 0o600 });
  // Belt-and-braces — writeFile mode is honoured on POSIX but some umask
  // setups can still make the file group-readable; chmod is idempotent.
  try {
    await chmod(keyPath, 0o600);
  } catch {
    // Non-fatal on platforms that don't fully honour POSIX modes (Windows).
  }
  await ensureGitignoreEntry(repoRoot, MASTER_KEY_FILE);
  await ensureGitignoreEntry(repoRoot, MASTER_KEY_HISTORICAL_GLOB);
  return { written: true, alreadyExisted: false };
}

async function ensureGitignoreEntry(repoRoot: string, entry: string): Promise<void> {
  const ignorePath = path.join(repoRoot, ".gitignore");
  let existing = "";
  try {
    const s = await stat(ignorePath);
    if (s.isFile()) existing = await readFile(ignorePath, "utf8");
  } catch {
    // No .gitignore — fall through and create.
  }
  const lines = existing.split(/\r?\n/);
  if (lines.some((line) => line.trim() === entry)) return;
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  await appendFile(
    ignorePath,
    `${needsLeadingNewline ? "\n" : ""}${entry}\n`,
  );
}

export async function runInit(
  repoRoot: string,
  opts: InitOptions = {},
): Promise<InitResult> {
  const {
    force = false,
    noHooks = false,
    noDaemon = false,
    supervise = false,
    noEncryption = false,
    cliVersion,
  } = opts;

  const event = await initBaseline(repoRoot, { force });

  const configPath = path.join(repoRoot, "kodela.config.json");
  const ignorePath = path.join(repoRoot, ".kodelaignore");

  const [alreadyHasConfig, alreadyHasIgnore] = await Promise.all([
    fileExists(configPath),
    fileExists(ignorePath),
  ]);

  const [configWritten, kodelaignoreWritten, gettingStartedWritten] =
    await Promise.all([
      alreadyHasConfig
        ? Promise.resolve(false)
        : writeDefaultConfig(repoRoot).then(() => true),
      alreadyHasIgnore
        ? Promise.resolve(false)
        : writeDefaultKodelaignore(repoRoot).then(() => true),
      writeGettingStartedMd(repoRoot, { force }),
    ]);

  // doc 27 §E.7 — encryption-at-rest is on by default. Generate the master
  // key file before anything else writes to disk so encrypted entries from
  // this init run land in a recoverable state.
  let masterKeyWritten = false;
  let masterKeyAlreadyExisted = false;
  let encryptionSkipped = false;
  if (noEncryption) {
    encryptionSkipped = true;
  } else {
    try {
      const k = await ensureMasterKey(repoRoot);
      masterKeyWritten = k.written;
      masterKeyAlreadyExisted = k.alreadyExisted;
    } catch {
      // Non-fatal: the rest of init can proceed in plaintext mode if key
      // generation fails (e.g. read-only filesystem in a sandboxed CI).
      // The operator can still set KODELA_MASTER_KEY by hand.
    }
  }

  // Gap 78 — auto-install git hooks unless --no-hooks was passed.
  // Errors are swallowed (e.g. no .git directory in a monorepo subpackage);
  // the caller can always run `kodela install-hooks` manually.
  let hooksInstalled = false;
  let hooksSkipped = false;
  if (noHooks) {
    hooksSkipped = true;
  } else {
    try {
      const hookResult = await runInstallHooks({ repoRoot, force: false });
      hooksInstalled = hookResult.preCommitInstalled || hookResult.postCommitInstalled;
    } catch {
      // No .git dir, CI environment, or similar — non-fatal
    }
  }

  // doc 21 R4 — start the always-on auto-annotate watcher so capture is silent
  // and tool-agnostic by default. Idempotent (runWatchDetach no-ops if already
  // running) and best-effort (capture still works via hooks if the spawn fails).
  let watcherStarted = false;
  let watcherAlreadyRunning = false;
  let watcherSkipped = false;
  let watcherSupervised = false;
  let watcherReason: string | undefined;
  if (noDaemon) {
    watcherSkipped = true;
  } else {
    try {
      const w = await runWatchDetach({
        repoRoot,
        extraArgs: ["--auto-annotate"],
        cliVersion: cliVersion ?? "0.0.0",
      });
      watcherStarted = w.started;
      watcherAlreadyRunning = w.alreadyRunning;
      watcherReason = w.reason;
      if ((w.started || w.alreadyRunning) && supervise) {
        try {
          const s = await installSupervisor({
            repoRoot,
            cliVersion: cliVersion ?? "0.0.0",
            extraArgs: ["--auto-annotate"],
          });
          watcherSupervised = s.installed || s.alreadyInstalled;
        } catch {
          // non-fatal: the watcher runs, it just won't survive a reboot.
        }
      }
    } catch {
      watcherReason =
        "watcher could not start; run `kodela watch --auto-annotate --detach` manually.";
    }
  }

  return {
    repoRoot,
    alreadyExisted: event.alreadyExisted,
    configWritten,
    kodelaignoreWritten,
    gettingStartedWritten,
    trackedFiles: event.trackedFileCount,
    hooksInstalled,
    hooksSkipped,
    watcherStarted,
    watcherAlreadyRunning,
    watcherSkipped,
    watcherSupervised,
    watcherReason,
    masterKeyWritten,
    masterKeyAlreadyExisted,
    encryptionSkipped,
  };
}

export function formatInitResult(result: InitResult): string {
  if (result.alreadyExisted) {
    const lines = [
      `✓ Kodela baseline already exists at ${result.repoRoot}/.kodela/`,
      `  Use --force to reinitialize.`,
      ``,
    ];
    lines.push(
      renderCapturePathBlock({
        active: "unset",
        hooksInstalled: result.hooksInstalled,
        watcherRunning: false,
      }),
    );
    lines.push("");
    lines.push(
      "Tip: run `kodela setup` for guided capture-path selection (auto-detects Claude Code).",
    );
    return lines.join("\n");
  }

  const lines = [
    `✓ Kodela initialized at ${result.repoRoot}/.kodela/`,
    `  Tracked ${result.trackedFiles} file${result.trackedFiles !== 1 ? "s" : ""} in baseline snapshot.`,
  ];
  if (result.configWritten) {
    lines.push(`  Created kodela.config.json with default settings.`);
  }
  if (result.kodelaignoreWritten) {
    lines.push(`  Created .kodelaignore with default patterns.`);
  }
  if (result.gettingStartedWritten) {
    lines.push(`  Created .kodela/GETTING_STARTED.md with onboarding instructions.`);
  }
  // Gap 78 — report hook installation outcome.
  if (result.hooksInstalled) {
    lines.push(`  Installed .git/hooks/pre-commit and .git/hooks/post-commit.`);
  } else if (result.hooksSkipped) {
    lines.push(`  ℹ  Skipped git hooks (--no-hooks). Run \`kodela install-hooks\` to add them later.`);
  }
  // doc 21 R4 — report the silent-capture watcher.
  if (result.watcherStarted) {
    lines.push(
      `  Started the auto-annotate watcher (silent capture, any tool)${result.watcherSupervised ? " + supervisor (survives reboots)" : ""}.`,
    );
  } else if (result.watcherAlreadyRunning) {
    lines.push(`  ℹ  Auto-annotate watcher already running.`);
  } else if (result.watcherSkipped) {
    lines.push(`  ℹ  Skipped the watcher (--no-daemon). Start it with \`kodela watch --auto-annotate --detach\`.`);
  } else if (result.watcherReason) {
    lines.push(`  ⚠  ${result.watcherReason}`);
  }
  // doc 27 §E.7 — report encryption-at-rest setup.
  if (result.masterKeyWritten) {
    lines.push(
      `  Generated .kodela.master-key (AES-256-GCM field encryption, mode 0600; added to .gitignore).`,
    );
  } else if (result.masterKeyAlreadyExisted) {
    lines.push(`  ℹ  .kodela.master-key already exists; encryption-at-rest preserved.`);
  } else if (result.encryptionSkipped) {
    lines.push(
      `  ⚠  Skipped encryption-at-rest (--no-encryption). Set KODELA_MASTER_KEY or re-run \`kodela init\` to enable.`,
    );
  }
  // Gap 80 — prompt for retrospective coverage.
  lines.push(`  ℹ  Run \`kodela annotate-history\` to populate the index for existing AI-generated code.`);
  lines.push("");
  lines.push(
    renderCapturePathBlock({
      active: "unset",
      hooksInstalled: result.hooksInstalled,
      watcherRunning: Boolean(result.watcherStarted || result.watcherAlreadyRunning),
    }),
  );
  lines.push("");
  lines.push(
    "Tip: run `kodela setup` for guided capture-path selection (auto-detects Claude Code).",
  );
  return lines.join("\n");
}

export function handleInitError(err: unknown): never {
  if (err instanceof KodelaError) {
    process.stderr.write(`Kodela error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
