// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Shared CLI messaging blocks.
 *
 * The "capture path" block is the canonical hooks-first onboarding summary
 * used by every surface that prints next-steps guidance — `init`, `setup`,
 * `hook install`, `install-hooks`, and the watcher daemon start.  Keeping
 * the format in a single place (with snapshot tests) prevents drift across
 * commands.
 *
 * Canonical format (from `.local/tasks/task-1.md` §"Strict, snapshot-tested
 * output contract") — example with active=hooks:
 *
 *   ✔ Kodela initialized
 *
 *   Capture path:
 *   ★ Claude Code hooks (installed)
 *     → Captures prompts, sessions, and reasoning directly from Claude Code
 *
 *   Next steps:
 *   - Run your AI workflow as usual
 *   - Inspect captured entries with: kodela explain <file>
 *
 *   Other options:
 *   ◆ Watcher (any AI tool)
 *     kodela watch --auto-annotate --detach
 *
 *   ◇ Manual
 *     kodela add <file> -s <line> -e <line> -n "..."
 *
 *   Docs: https://kodela.dev/getting-started
 *
 * Glyph convention:
 *   ★  active capture path (what is currently capturing)
 *   ◆  available alternative (installed / running but not active)
 *   ◇  fallback / not-installed alternative
 *   ✔  completed step (in the headline only)
 */

export type CaptureMode = "hooks" | "watcher" | "manual" | "unset";

export type CapturePathState = {
  /** Which capture path is currently active (drives the ★ marker). */
  active: CaptureMode;
  /** Whether Claude Code hooks are installed in `.claude/settings.json`. */
  hooksInstalled: boolean;
  /** Whether the daemonized watcher is currently running. */
  watcherRunning: boolean;
  /** Optional headline rendered above the block (e.g. "Kodela initialized"). */
  headline?: string;
  /** Optional URL to documentation; defaults to the public docs URL. */
  docsUrl?: string;
};

const DEFAULT_DOCS_URL = "https://kodela.dev/getting-started";

type PathKind = "hooks" | "watcher" | "manual";

function hooksLines(installed: boolean, active: boolean, running: boolean): string[] {
  // `running` is unused for hooks but kept to keep the helper signature uniform.
  void running;
  if (active) {
    return [
      "★ Claude Code hooks (installed)",
      "  → Captures prompts, sessions, and reasoning directly from Claude Code",
    ];
  }
  if (installed) {
    return [
      "◆ Claude Code hooks (installed)",
      "  → Available — prompts, sessions, and reasoning captured automatically",
    ];
  }
  return [
    "◇ Claude Code hooks (not installed)",
    "  kodela hook install --claude",
  ];
}

function watcherLines(installed: boolean, active: boolean, running: boolean): string[] {
  void installed;
  if (active) {
    return [
      `★ Watcher (${running ? "running" : "any AI tool"})`,
      "  → Auto-annotates AI changes detected in the filesystem",
    ];
  }
  if (running) {
    return [
      "◆ Watcher (running)",
      "  → Daemon active — kodela watch status to inspect",
    ];
  }
  return [
    "◆ Watcher (any AI tool)",
    "  kodela watch --auto-annotate --detach",
  ];
}

function manualLines(active: boolean): string[] {
  if (active) {
    return [
      "★ Manual",
      '  → Operator-driven annotation via `kodela add`',
    ];
  }
  return [
    "◇ Manual",
    '  kodela add <file> -s <line> -e <line> -n "..."',
  ];
}

function nextStepsFor(active: CaptureMode): string[] {
  switch (active) {
    case "hooks":
      return [
        "- Run your AI workflow as usual",
        "- Inspect captured entries with: kodela explain <file>",
      ];
    case "watcher":
      return [
        "- Run your AI workflow as usual",
        "- Check status with: kodela watch status",
        "- Inspect captured entries with: kodela explain <file>",
      ];
    case "manual":
      return [
        "- Add a first annotation with `kodela add`",
        "- Or run `kodela setup` for guided capture-path selection",
      ];
    case "unset":
      return [
        "- Run `kodela setup` for guided capture-path selection",
        "- Or pick a path above explicitly",
      ];
  }
}

/**
 * Render the canonical capture-path block.  The output is **stable** and
 * snapshot-tested in `messaging.snapshot.test.ts`: any drift in ordering or
 * labels is intentional and must be reflected in the snapshot.
 */
export function renderCapturePathBlock(state: CapturePathState): string {
  const lines: string[] = [];

  if (state.headline) {
    lines.push(`✔ ${state.headline}`);
    lines.push("");
  }

  // Standard ordering of the three known paths.  The "active" one (if any)
  // appears under "Capture path:"; the rest go under "Other options:".
  const order: PathKind[] = ["hooks", "watcher", "manual"];
  const activePath: PathKind | null =
    state.active === "unset" ? null : (state.active as PathKind);

  // ── Capture path: <active> ──────────────────────────────────────────────
  lines.push("Capture path:");
  if (activePath !== null) {
    if (activePath === "hooks") {
      lines.push(...hooksLines(state.hooksInstalled, true, false));
    } else if (activePath === "watcher") {
      lines.push(...watcherLines(false, true, state.watcherRunning));
    } else {
      lines.push(...manualLines(true));
    }
  } else {
    lines.push("◇ (none chosen yet)");
  }

  // ── Next steps ──────────────────────────────────────────────────────────
  lines.push("");
  lines.push("Next steps:");
  for (const ns of nextStepsFor(state.active)) lines.push(ns);

  // ── Other options ───────────────────────────────────────────────────────
  const others = order.filter((p) => p !== activePath);
  lines.push("");
  lines.push("Other options:");
  for (let i = 0; i < others.length; i++) {
    const p = others[i];
    if (p === "hooks") {
      lines.push(...hooksLines(state.hooksInstalled, false, false));
    } else if (p === "watcher") {
      lines.push(...watcherLines(false, false, state.watcherRunning));
    } else {
      lines.push(...manualLines(false));
    }
    if (i < others.length - 1) lines.push("");
  }

  // ── Docs ────────────────────────────────────────────────────────────────
  lines.push("");
  lines.push(`Docs: ${state.docsUrl ?? DEFAULT_DOCS_URL}`);

  return lines.join("\n");
}

/**
 * Compact next-steps block used after specific commands (e.g. `kodela add`)
 * where the full capture-path block would be too noisy.
 */
export function renderQuickHelp(): string {
  return [
    "Tip: run `kodela setup` for guided capture-path selection,",
    "  or `kodela doctor` to verify your installation.",
  ].join("\n");
}

/**
 * The default `_kodela.next_steps` array embedded in `kodela.config.json`.
 * Captures the canonical messaging hierarchy in a machine-readable form so
 * other tools (or future enterprise dashboards) can read it directly.
 */
export function defaultNextStepsLines(): string[] {
  return [
    "★ Claude Code hooks (preferred) — kodela hook install --claude",
    "◆ Watcher (any AI tool)         — kodela watch --auto-annotate --detach",
    '◇ Manual                        — kodela add <file> -s <line> -e <line> -n "..."',
  ];
}
