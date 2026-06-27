// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Cursor IDE hook installation — copies `.cursor/hooks` from the Kodela install
 * into the target repository and records KODELA_HOME for hook subprocesses.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileExists } from "../utils/repo.js";
import { setCaptureMode } from "../config/loader.js";

export type HookInstallCursorOptions = {
  /** Repository receiving hooks (e.g. java-calculator). */
  repoRoot: string;
  /** Kodela monorepo containing artifacts/mcp-server (source of hook templates). */
  kodelaHome?: string;
  force?: boolean;
};

export type HookInstallCursorResult = {
  hooksJsonPath: string;
  hooksDir: string;
  kodelaHome: string;
  created: boolean;
  updated: boolean;
  skipped: boolean;
  alreadyInstalled: boolean;
};

const CURSOR_HOOK_MARKER = "kodela-cursor-hooks-v1";

const HOOK_SCRIPT_NAMES = [
  "kodela-common.sh",
  "kodela-session-start.sh",
  "kodela-queue-annotation.sh",
  "kodela-dequeue-annotation.sh",
  "kodela-stop.sh",
  "kodela-session-end-cleanup.sh",
  "kodela-hook-session-end.sh",
  "README.md",
];

async function resolveKodelaHome(
  repoRoot: string,
  explicit?: string,
): Promise<string> {
  if (explicit?.trim()) {
    return path.resolve(explicit.trim());
  }
  if (process.env["KODELA_HOME"]?.trim()) {
    return path.resolve(process.env["KODELA_HOME"].trim());
  }
  const local = path.join(repoRoot, "artifacts", "mcp-server", "src", "tools", "session-start.ts");
  if (await fileExists(local)) {
    return repoRoot;
  }
  throw new Error(
    "KODELA_HOME is not set and this repo is not the Kodela monorepo. " +
      "Pass --kodela-home /path/to/Kodela or export KODELA_HOME.",
  );
}

async function readHooksJson(hooksJsonPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(hooksJsonPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { version: 1, hooks: {} };
  }
}

function hasKodelaCursorHooks(existing: Record<string, unknown>): boolean {
  return existing["_kodela"] === CURSOR_HOOK_MARKER;
}

export async function runHookInstallCursor(
  opts: HookInstallCursorOptions,
): Promise<HookInstallCursorResult> {
  const { repoRoot, force = false } = opts;
  const kodelaHome = await resolveKodelaHome(repoRoot, opts.kodelaHome);

  const srcHooksJson = path.join(kodelaHome, ".cursor", "hooks.json");
  const srcHooksDir = path.join(kodelaHome, ".cursor", "hooks");
  if (!(await fileExists(srcHooksJson))) {
    throw new Error(
      `Cursor hooks template not found at ${srcHooksJson}. ` +
        "Run from a Kodela checkout with .cursor/hooks.json present.",
    );
  }

  const destCursorDir = path.join(repoRoot, ".cursor");
  const destHooksDir = path.join(destCursorDir, "hooks");
  const destHooksJson = path.join(destCursorDir, "hooks.json");
  const kodelaHomeFile = path.join(repoRoot, ".kodela", "kodela-home");

  await fs.mkdir(path.join(repoRoot, ".kodela"), { recursive: true });
  await fs.mkdir(destHooksDir, { recursive: true });

  const destExists = await fileExists(destHooksJson);
  if (destExists && !force) {
    const existing = await readHooksJson(destHooksJson);
    if (hasKodelaCursorHooks(existing)) {
      await fs.writeFile(kodelaHomeFile, `${kodelaHome}\n`, "utf-8");
      return {
        hooksJsonPath: destHooksJson,
        hooksDir: destHooksDir,
        kodelaHome,
        created: false,
        updated: false,
        skipped: true,
        alreadyInstalled: true,
      };
    }
  }

  const templateHooks = await readHooksJson(srcHooksJson);
  const merged: Record<string, unknown> = destExists
    ? await readHooksJson(destHooksJson)
    : { version: templateHooks["version"] ?? 1, hooks: {} };

  merged["hooks"] = templateHooks["hooks"];
  merged["_kodela"] = CURSOR_HOOK_MARKER;

  await fs.writeFile(destHooksJson, JSON.stringify(merged, null, 2) + "\n", "utf-8");

  for (const name of HOOK_SCRIPT_NAMES) {
    const src = path.join(srcHooksDir, name);
    if (!(await fileExists(src))) continue;
    const dest = path.join(destHooksDir, name);
    await fs.copyFile(src, dest);
    await fs.chmod(dest, 0o755).catch(() => undefined);
  }

  await fs.writeFile(kodelaHomeFile, `${kodelaHome}\n`, "utf-8");
  await setCaptureMode(repoRoot, "hooks").catch(() => undefined);

  return {
    hooksJsonPath: destHooksJson,
    hooksDir: destHooksDir,
    kodelaHome,
    created: !destExists,
    updated: destExists,
    skipped: false,
    alreadyInstalled: false,
  };
}

export function formatHookInstallCursorResult(result: HookInstallCursorResult): string {
  const lines: string[] = [];
  if (result.alreadyInstalled || result.skipped) {
    lines.push(`Cursor hooks already installed (${result.hooksJsonPath})`);
  } else if (result.created) {
    lines.push(`Installed Cursor hooks → ${result.hooksJsonPath}`);
  } else {
    lines.push(`Updated Cursor hooks → ${result.hooksJsonPath}`);
  }
  lines.push(`KODELA_HOME recorded: ${result.kodelaHome}`);
  lines.push(`  (.kodela/kodela-home — sourced by hook scripts)`);
  lines.push("Reload the Cursor window after changing hooks.");
  return lines.join("\n");
}
