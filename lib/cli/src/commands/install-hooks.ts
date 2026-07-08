// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { fileExists } from "../utils/repo.js";
import { renderCapturePathBlock } from "../output/messaging.js";
import { runHookInstallClaude } from "./hook.js";

/**
 * Gap 78 — After successfully writing git hooks, mark hooksInstalled: true in
 * kodela.config.json so `kodela doctor` and the init output reflect the real
 * state. Errors are swallowed — the hooks are the important part.
 */
async function writeConfigHooksInstalled(repoRoot: string): Promise<void> {
  const configPath = path.join(repoRoot, "kodela.config.json");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed["hooksInstalled"] = true;
    await fs.writeFile(configPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
  } catch {
    // Config may not exist yet (bare install) or be malformed — non-fatal
  }
}

export type InstallHooksOptions = {
  repoRoot: string;
  force?: boolean;
  /** Gap 52 Phase A — also install Claude Code hooks into .claude/settings.json */
  claude?: boolean;
  /** Also install a post-merge hook that runs `kodela sync` (central mode). */
  sync?: boolean;
};

export type InstallHooksResult = {
  repoRoot: string;
  preCommitInstalled: boolean;
  postCommitInstalled: boolean;
  preCommitSkipped: boolean;
  postCommitSkipped: boolean;
  /** Set only when --sync was passed. */
  postMergeInstalled?: boolean;
  postMergeSkipped?: boolean;
  /** Gap 52 Phase A — Claude Code hooks install result. Undefined when --claude was not passed. */
  claudeResult?: {
    settingsPath: string;
    created: boolean;
    updated: boolean;
    skipped: boolean;
    alreadyInstalled: boolean;
  };
};

const PRE_COMMIT_SCRIPT = `#!/usr/bin/env sh
# Kodela pre-commit hook
# Installed by: kodela install-hooks
#
# This hook runs \`kodela status --ci\` before every commit.
# Behaviour is controlled by the \`ci.enforcement\` field in kodela.config.json:
#
#   "advisory"    — warns on threshold breaches but always allows the commit.
#   "enforcement" — blocks the commit when thresholds are breached.
#
# Gap 58: also runs \`kodela detect-ai-change --staged\` as an advisory check.
# This warns when staged changes look AI-generated but have no Kodela annotation.
# It never blocks the commit on its own.
#
# To bypass this hook for a single commit (e.g. during a rebase):
#   git commit --no-verify

set -e

# Locate the kodela binary: prefer local node_modules, fall back to PATH.
if [ -x "./node_modules/.bin/kodela" ]; then
  KODELA="./node_modules/.bin/kodela"
elif command -v kodela >/dev/null 2>&1; then
  KODELA="kodela"
elif command -v npx >/dev/null 2>&1; then
  KODELA="npx --yes @kodela/cli"
else
  echo "[kodela] WARNING: kodela binary not found — skipping pre-commit check." >&2
  exit 0
fi

$KODELA status --ci

# Gap 58 Phase C — advisory AI change detection for staged files.
# Warns when staged changes are likely AI-generated without a Kodela annotation.
# Never blocks the commit — the governance gate above handles enforcement.
$KODELA detect-ai-change --staged 2>/dev/null || true
`;

const POST_COMMIT_SCRIPT = `#!/usr/bin/env sh
# Kodela post-commit hook
# Installed by: kodela install-hooks
#
# After each commit:
#   1. \`kodela heal\` re-maps context annotations against the latest file state.
#   2. \`kodela sync --auto\` pushes context to the central server — but ONLY when
#      storage.mode is "central" (team/enterprise). It is a silent no-op for
#      local-only repos, so this single hook works for everyone. Central mode is
#      set once by an admin and inherited via \`kodela config-pull\`, so team sync
#      is fully automatic — no developer ever runs \`kodela sync\` by hand.

set -e

# Locate the kodela binary: prefer local node_modules, fall back to PATH.
if [ -x "./node_modules/.bin/kodela" ]; then
  KODELA="./node_modules/.bin/kodela"
elif command -v kodela >/dev/null 2>&1; then
  KODELA="kodela"
elif command -v npx >/dev/null 2>&1; then
  KODELA="npx --yes @kodela/cli"
else
  echo "[kodela] WARNING: kodela binary not found — skipping post-commit heal." >&2
  exit 0
fi

$KODELA heal 2>/dev/null || true

# Auto central-sync (no-op unless storage.mode: central). Backgrounded so it
# never adds latency to the commit, and fully detached so it survives the hook.
( $KODELA sync --auto >/dev/null 2>&1 & ) || true
`;

const POST_MERGE_SYNC_SCRIPT = `#!/usr/bin/env sh
# Kodela post-merge sync hook
# Installed by: kodela install-hooks --sync
#
# After each \`git pull\` / \`git merge\`, pushes newly captured context to the
# central Kodela server (\`kodela sync\`). Non-fatal and silent when no server is
# configured, so it is a no-op for local-only repos.

set -e

# Locate the kodela binary: prefer local node_modules, fall back to PATH.
if [ -x "./node_modules/.bin/kodela" ]; then
  KODELA="./node_modules/.bin/kodela"
elif command -v kodela >/dev/null 2>&1; then
  KODELA="kodela"
elif command -v npx >/dev/null 2>&1; then
  KODELA="npx --yes @kodela/cli"
else
  exit 0
fi

# Silent + non-fatal: no server configured → sync exits non-zero → swallowed.
$KODELA sync >/dev/null 2>&1 || true
`;

export async function runInstallHooks(
  opts: InstallHooksOptions,
): Promise<InstallHooksResult> {
  const { repoRoot, force = false, claude = false, sync = false } = opts;

  const hooksDir = path.join(repoRoot, ".git", "hooks");

  const gitDirExists = await fileExists(path.join(repoRoot, ".git"));
  if (!gitDirExists) {
    throw new Error(
      `No .git directory found at ${repoRoot}. Run \`git init\` first.`,
    );
  }

  await fs.mkdir(hooksDir, { recursive: true });

  const preCommitPath = path.join(hooksDir, "pre-commit");
  const postCommitPath = path.join(hooksDir, "post-commit");

  const preCommitExists = await fileExists(preCommitPath);
  const postCommitExists = await fileExists(postCommitPath);

  let preCommitInstalled = false;
  let postCommitInstalled = false;
  let preCommitSkipped = false;
  let postCommitSkipped = false;

  if (preCommitExists && !force) {
    preCommitSkipped = true;
  } else {
    await fs.writeFile(preCommitPath, PRE_COMMIT_SCRIPT, { mode: 0o755 });
    preCommitInstalled = true;
  }

  if (postCommitExists && !force) {
    postCommitSkipped = true;
  } else {
    await fs.writeFile(postCommitPath, POST_COMMIT_SCRIPT, { mode: 0o755 });
    postCommitInstalled = true;
  }

  // Opt-in central-sync: a post-merge hook that pushes context after each pull.
  let postMergeInstalled: boolean | undefined;
  let postMergeSkipped: boolean | undefined;
  if (sync) {
    const postMergePath = path.join(hooksDir, "post-merge");
    if ((await fileExists(postMergePath)) && !force) {
      postMergeSkipped = true;
    } else {
      await fs.writeFile(postMergePath, POST_MERGE_SYNC_SCRIPT, { mode: 0o755 });
      postMergeInstalled = true;
    }
  }

  // Gap 52 Phase A — optionally install Claude Code hooks alongside git hooks.
  let claudeResult: InstallHooksResult["claudeResult"] | undefined;
  if (claude) {
    claudeResult = await runHookInstallClaude({ repoRoot, force });
  }

  // Gap 78 — write hooksInstalled: true to kodela.config.json whenever at
  // least one hook was newly written, so the field reflects reality.
  if (preCommitInstalled || postCommitInstalled || postMergeInstalled) {
    await writeConfigHooksInstalled(repoRoot);
  }

  return {
    repoRoot,
    preCommitInstalled,
    postCommitInstalled,
    preCommitSkipped,
    postCommitSkipped,
    postMergeInstalled,
    postMergeSkipped,
    claudeResult,
  };
}

export function formatInstallHooksResult(result: InstallHooksResult): string {
  const lines: string[] = [];

  if (result.preCommitInstalled) {
    lines.push("✓ Installed .git/hooks/pre-commit");
    lines.push(
      "  Runs `kodela status --ci` before each commit. Behaviour is controlled",
    );
    lines.push(
      "  by `ci.enforcement` in kodela.config.json (advisory | enforcement).",
    );
  } else if (result.preCommitSkipped) {
    lines.push(
      "⚠ Skipped .git/hooks/pre-commit — file already exists. Use --force to overwrite.",
    );
  }

  if (result.postCommitInstalled) {
    lines.push("✓ Installed .git/hooks/post-commit");
    lines.push(
      "  Runs `kodela heal` after each commit, then `kodela sync --auto` — which",
    );
    lines.push(
      "  auto-pushes context in team/enterprise (storage.mode: central) and is a",
    );
    lines.push(
      "  silent no-op for local-only repos. Team sync needs no manual step.",
    );
  } else if (result.postCommitSkipped) {
    lines.push(
      "⚠ Skipped .git/hooks/post-commit — file already exists. Use --force to overwrite.",
    );
  }

  if (result.postMergeInstalled) {
    lines.push("✓ Installed .git/hooks/post-merge");
    lines.push(
      "  Runs `kodela sync` after each pull/merge to push context to the central",
    );
    lines.push(
      "  server (silent no-op when no server is configured).",
    );
  } else if (result.postMergeSkipped) {
    lines.push(
      "⚠ Skipped .git/hooks/post-merge — file already exists. Use --force to overwrite.",
    );
  }

  if (
    !result.preCommitInstalled &&
    !result.postCommitInstalled &&
    !result.postMergeInstalled
  ) {
    lines.push("No git hooks were installed. Use --force to overwrite existing hooks.");
  }

  // Gap 52 Phase A — Claude Code hooks result block.
  if (result.claudeResult) {
    const cr = result.claudeResult;
    lines.push("");
    if (cr.skipped || cr.alreadyInstalled) {
      lines.push(
        "⚠ Claude Code hooks already installed in " + cr.settingsPath + ". Use --force to reinstall.",
      );
    } else if (cr.created) {
      lines.push("✓ Created " + cr.settingsPath + " with Kodela Claude Code hooks");
      lines.push("  Configures PostToolUse, SessionStart, SessionEnd, and UserPromptSubmit.");
    } else if (cr.updated) {
      lines.push("✓ Updated " + cr.settingsPath + " — Kodela Claude Code hooks added");
      lines.push("  Existing non-Kodela hooks were preserved.");
    }
    lines.push(
      "  Next step: start Claude Code in this repository — hooks will fire automatically.",
    );
  }

  lines.push("");
  lines.push(
    "Tip: commit kodela.config.json to your repo so team policy travels with the code.",
  );

  // Shared messaging contract — keep onboarding guidance consistent across
  // every surface that touches a capture path.  When --claude was passed and
  // hooks were installed, the capture path is now "hooks"; otherwise this
  // command only installed git hooks (capture path stays unset).
  const claudeInstalled =
    result.claudeResult !== undefined &&
    (result.claudeResult.created ||
      result.claudeResult.updated ||
      result.claudeResult.alreadyInstalled);

  lines.push("");
  lines.push(
    renderCapturePathBlock({
      active: claudeInstalled ? "hooks" : "unset",
      hooksInstalled: claudeInstalled,
      watcherRunning: false,
    }),
  );

  return lines.join("\n");
}
