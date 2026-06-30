// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import {
  KodelaConfigSchema,
  DEFAULT_CONFIG,
  type KodelaConfig,
  type CaptureMode,
} from "./schema.js";
import { defaultNextStepsLines } from "../output/messaging.js";

export const CONFIG_FILE_NAME = "kodela.config.json";

/**
 * Current schema version of the `_kodela` metadata block.  Bump when adding
 * new required fields to `KodelaMetadataSchema`; the bump triggers a
 * one-shot refresh on the next `kodela setup --force` or `kodela doctor --fix`.
 */
export const KODELA_METADATA_SCHEMA_VERSION = 1;

/**
 * CLI version embedded in the `_kodela.last_updated_cli_version` field.
 *
 * Sourced from `package.json#version` at BUILD TIME via esbuild's `define`
 * replacement (`build.mjs` injects `process.env.__KODELA_CLI_VERSION__`).
 * The fallback `"0.0.0-dev"` only fires in `tsx`/dev-mode where the source
 * runs without going through the bundler — never in published artifacts.
 *
 * Bumping the version is a single edit to `lib/cli/package.json`; the smoke
 * test + release workflow both verify the published bin reports the same
 * version as the git tag, so drift is impossible in CI.
 */
export const CLI_VERSION: string =
  process.env.__KODELA_CLI_VERSION__ ?? "0.0.0-dev";

/** Default documentation URL — used by the messaging block and config block. */
export const DEFAULT_DOCS_URL = "https://kodela.dev/getting-started";

/**
 * Thrown when a `kodela.config.json` file exists but cannot be parsed or
 * fails schema validation.  Distinguished from low-level IO errors so callers
 * can choose to fall back gracefully versus surfacing an operational failure.
 */
export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigLoadError";
  }
}

export async function findConfigFile(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (true) {
    const candidate = path.join(current, CONFIG_FILE_NAME);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      if (current === root) return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

export async function loadConfig(repoRoot: string): Promise<KodelaConfig> {
  const configPath = await findConfigFile(repoRoot);
  if (configPath === null) {
    return DEFAULT_CONFIG;
  }

  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return KodelaConfigSchema.parse(parsed);
  } catch (err) {
    throw new ConfigLoadError(
      `Failed to load ${CONFIG_FILE_NAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Like `loadConfig`, but catches parse / validation errors instead of
 * re-throwing them.  Writes a warning to `stderr` and returns
 * `DEFAULT_CONFIG` so callers (e.g. the `watch` command) can continue with
 * safe built-in defaults when the user's config file is temporarily broken.
 */
export async function loadConfigSafe(
  repoRoot: string,
  stderr: { write: (msg: string) => void } = process.stderr,
): Promise<KodelaConfig> {
  try {
    return await loadConfig(repoRoot);
  } catch (err) {
    if (!(err instanceof ConfigLoadError)) throw err;
    stderr.write(
      `Warning: ${err.message} — using built-in defaults\n`,
    );
    return DEFAULT_CONFIG;
  }
}

/**
 * Build the `_kodela` metadata block to embed at the top of a freshly written
 * `kodela.config.json`.  Captures schema_version, last_updated_cli_version,
 * the canonical next-steps list, and the docs URL.
 */
export function buildKodelaMetadata(
  captureMode: CaptureMode = "unset",
): Record<string, unknown> {
  return {
    schema_version: KODELA_METADATA_SCHEMA_VERSION,
    last_updated_cli_version: CLI_VERSION,
    capture_mode: captureMode,
    next_steps: defaultNextStepsLines(),
    docs_url: DEFAULT_DOCS_URL,
  };
}

export type WriteDefaultConfigOptions = {
  /** Initial capture mode to record (defaults to "unset"). */
  captureMode?: CaptureMode;
};

export async function writeDefaultConfig(
  repoRoot: string,
  opts: WriteDefaultConfigOptions = {},
): Promise<void> {
  const configPath = path.join(repoRoot, CONFIG_FILE_NAME);
  // The `_kodela` block is intentionally written first so users see the
  // versioned guidance metadata at the very top of the file.
  const config = {
    _kodela: buildKodelaMetadata(opts.captureMode),
    hooks: {
      line_threshold: 50,
      minimum_summary_length: 10,
      required_fields: ["note"],
    },
    ci: {
      enforcement: "advisory",
      thresholds: {
        min_confidence_score: 0.8,
        max_orphaned_pct: 10,
        max_unresolved_critical_pct: 5,
      },
    },
    baseline: {
      max_days_before_archive: 90,
      ignore_patterns: [
        "node_modules/**",
        ".git/**",
        ".local/**",
        "dist/**",
        "build/**",
        "coverage/**",
        ".cache/**",
        ".next/**",
        ".nuxt/**",
        "*.map",
        "*.js.map",
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
        "attached_assets/**",
      ],
    },
    ai_detection: {
      enabled: true,
      min_lines_added: 100,
      comment_patterns: [
        "AI-generated",
        "Generated by",
        "Co-authored-by: github-actions",
        "Copilot",
        "ChatGPT",
        "Claude",
        "Gemini",
      ],
      insertion_speed_threshold_ms: 2000,
      editor_insertion_min_lines: 10,
      new_file_flag: true,
      new_file_min_lines: 50,
    },
    security: {
      sensitive_paths: [
        "auth/",
        "authentication/",
        "payments/",
        "billing/",
        "crypto/",
        "cryptography/",
        "security/",
        "secrets/",
        "credentials/",
        "tokens/",
      ],
    },
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Update `_kodela.capture_mode` in the existing config (if present) without
 * touching any other field.  Creates the `_kodela` block when it is missing.
 *
 * Silently no-ops when the config file does not exist or is unreadable —
 * `setCaptureMode` is a best-effort operation that must never crash the
 * caller (e.g. `kodela watch --detach` shouldn't fail the daemon start
 * just because the config file is broken).
 */
export async function setCaptureMode(
  repoRoot: string,
  mode: CaptureMode,
): Promise<boolean> {
  const configPath = path.join(repoRoot, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch {
    return false;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }

  const existingMeta =
    (parsed["_kodela"] as Record<string, unknown> | undefined) ?? {};

  const newMeta = {
    schema_version:
      typeof existingMeta["schema_version"] === "number"
        ? existingMeta["schema_version"]
        : KODELA_METADATA_SCHEMA_VERSION,
    last_updated_cli_version: CLI_VERSION,
    capture_mode: mode,
    next_steps:
      Array.isArray(existingMeta["next_steps"]) &&
      (existingMeta["next_steps"] as unknown[]).length > 0
        ? existingMeta["next_steps"]
        : defaultNextStepsLines(),
    docs_url:
      typeof existingMeta["docs_url"] === "string"
        ? existingMeta["docs_url"]
        : DEFAULT_DOCS_URL,
    // Preserve any unknown fields (forward-compat).
    ...Object.fromEntries(
      Object.entries(existingMeta).filter(
        ([k]) =>
          ![
            "schema_version",
            "last_updated_cli_version",
            "capture_mode",
            "next_steps",
            "docs_url",
          ].includes(k),
      ),
    ),
  };

  // Re-emit with `_kodela` at the top.
  const { _kodela: _drop, ...rest } = parsed;
  const ordered: Record<string, unknown> = { _kodela: newMeta, ...rest };

  try {
    await fs.writeFile(
      configPath,
      JSON.stringify(ordered, null, 2) + "\n",
      "utf-8",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Refresh the `_kodela` block in an existing config to the current
 * `KODELA_METADATA_SCHEMA_VERSION`.  Preserves the recorded `capture_mode`
 * but overwrites schema_version, last_updated_cli_version, next_steps, and
 * docs_url with current values.
 *
 * Returns true when a refresh was performed, false when the file is missing
 * or already up-to-date.
 */
/**
 * Read the `_kodela.schema_version` field from an existing config file.
 *
 * Returns:
 *   - the integer schema_version when present and well-formed
 *   - `null` when the config file is missing, unreadable, malformed JSON,
 *     or has no `_kodela` block at all
 *   - `0` (or whatever value is present) when the block exists but
 *     schema_version is missing — callers treat any value below
 *     `KODELA_METADATA_SCHEMA_VERSION` as stale
 */
export async function getKodelaSchemaVersion(
  repoRoot: string,
): Promise<number | null> {
  const configPath = path.join(repoRoot, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const meta = parsed["_kodela"] as Record<string, unknown> | undefined;
  if (!meta) return null;
  const ver = meta["schema_version"];
  if (typeof ver === "number" && Number.isFinite(ver)) return ver;
  // Block exists but schema_version is missing/invalid — treat as 0 (stale).
  return 0;
}

export async function refreshKodelaMetadata(repoRoot: string): Promise<boolean> {
  const configPath = path.join(repoRoot, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch {
    return false;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }

  const existing =
    (parsed["_kodela"] as Record<string, unknown> | undefined) ?? {};

  if (existing["schema_version"] === KODELA_METADATA_SCHEMA_VERSION) {
    return false;
  }

  const captureMode =
    (typeof existing["capture_mode"] === "string"
      ? (existing["capture_mode"] as CaptureMode)
      : "unset");

  const newMeta = {
    ...buildKodelaMetadata(captureMode),
    // Preserve any unknown fields (forward-compat).
    ...Object.fromEntries(
      Object.entries(existing).filter(
        ([k]) =>
          ![
            "schema_version",
            "last_updated_cli_version",
            "capture_mode",
            "next_steps",
            "docs_url",
          ].includes(k),
      ),
    ),
  };

  const { _kodela: _drop, ...rest } = parsed;
  const ordered: Record<string, unknown> = { _kodela: newMeta, ...rest };

  await fs.writeFile(
    configPath,
    JSON.stringify(ordered, null, 2) + "\n",
    "utf-8",
  );
  return true;
}

/**
 * Write `.kodela/GETTING_STARTED.md` with the canonical hooks-first
 * onboarding hierarchy in human-readable Markdown.
 *
 * By default, never overwrites an existing file.  Pass `{ force: true }` to
 * unconditionally replace it (used by `kodela setup --force` and on
 * `schema_version` advances).
 */
export async function writeGettingStartedMd(
  repoRoot: string,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const dest = path.join(repoRoot, ".kodela", "GETTING_STARTED.md");
  await fs.mkdir(path.dirname(dest), { recursive: true });

  if (!opts.force) {
    try {
      await fs.access(dest);
      return false;
    } catch {
      // Does not exist — fall through and write.
    }
  }

  const md = `# Kodela — Getting Started

Kodela captures the *why* behind every code change so you can navigate AI-assisted
codebases with confidence.  This file describes the three capture paths in
recommended order.

> **Note:** this file is regenerated by \`kodela setup --force\` and when the
> Kodela CLI advances its config schema version.  Edits are not preserved.

---

## 1. Recommended — Claude Code hooks

If you use Claude Code, install hooks once:

\`\`\`bash
kodela hook install --claude
\`\`\`

This wires Kodela into the Claude Code lifecycle so prompts, sessions, and
reasoning are captured automatically with no further action required.

## 2. Fallback — Watcher daemon

For any other AI tool (or in environments without Claude Code), run the
filesystem watcher in the background:

\`\`\`bash
kodela watch --auto-annotate --detach
\`\`\`

Inspect daemon health any time:

\`\`\`bash
kodela watch status
\`\`\`

The watcher detects AI-written changes via a six-layer attribution pipeline
and creates context entries automatically.

## 3. Manual

Add a single annotation by hand whenever you need surgical precision:

\`\`\`bash
kodela add <file> -s <line> -e <line> -n "Why this code exists" --severity medium
\`\`\`

---

## Diagnostics

Run \`kodela doctor\` at any time to verify your installation and see which
capture paths are active.

## Documentation

Full docs: ${DEFAULT_DOCS_URL}
`;

  await fs.writeFile(dest, md, "utf-8");
  return true;
}

export const DEFAULT_KODELAIGNORE = `\
# Kodela custom ignore patterns
# The watcher respects these in addition to .gitignore and kodela.config.json
# baseline.ignore_patterns.  Supports .gitignore-style syntax:
#   *.ext        — file extension wildcard
#   dir/         — any directory with this name anywhere in the tree
#   /anchored    — only matches at the repo root
#   dir/**       — everything inside a directory

# Replit internal state (logs, skills, task metadata)
.local/

# Uploaded archives / binary blobs (rename to track a specific file)
*.zip
*.tar.gz
*.tar.bz2
attached_assets/

# Lock files (versions are pinned; content churn is not meaningful)
pnpm-lock.yaml
package-lock.json
yarn.lock

# Add your project-specific patterns below:
`;

export async function writeDefaultKodelaignore(repoRoot: string): Promise<void> {
  const ignorePath = path.join(repoRoot, ".kodelaignore");
  await fs.writeFile(ignorePath, DEFAULT_KODELAIGNORE, "utf-8");
}
