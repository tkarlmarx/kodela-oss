// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSetup, formatSetupResult } from "./setup.js";

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-setup-test-"));
  // Initialize a tiny git repo so findRepoRoot et al. behave; runSetup
  // doesn't require git but a simple tracked file makes initBaseline cheap.
  await fs.writeFile(path.join(dir, "README.md"), "test\n", "utf-8");
  return dir;
}

describe("runSetup", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await makeRepo();
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  test("--print-only performs no side effects", async () => {
    const result = await runSetup({
      repoRoot,
      yes: true,
      noWatcher: true,
      printOnly: true,
      detectionOverride: { level: "none", signals: [] },
    });
    assert.equal(result.printOnly, true);
    assert.ok(result.actions.includes("init"));
    // No baseline was written.
    await assert.rejects(() => fs.access(path.join(repoRoot, ".kodela", "baseline.json")));
  });

  test("high-confidence detection installs hooks", async () => {
    const result = await runSetup({
      repoRoot,
      yes: true,
      noWatcher: true,
      detectionOverride: {
        level: "high",
        signals: ["test signal"],
      },
    });
    assert.equal(result.captureMode, "hooks");
    assert.ok(
      result.actions.includes("hooks-installed") ||
        result.actions.includes("hooks-skipped"),
    );
    // .claude/settings.json should now exist with Kodela hooks.
    const raw = await fs.readFile(
      path.join(repoRoot, ".claude", "settings.json"),
      "utf-8",
    );
    assert.match(raw, /kodela-hook-v1/);
  });

  test("low-confidence + --yes is non-blocking (CI-safe deterministic path)", async () => {
    // CI requirement: `setup --yes --no-watcher` must NEVER prompt and must
    // exit deterministically.  In low-confidence mode, --yes picks the safe
    // path (skip hooks, fall through to watcher / manual fallback) without
    // ever opening stdin.  We deliberately do NOT inject a prompt fixture
    // here — if the implementation ever called `createPrompt()` and read
    // from real stdin, this test would hang.
    let promptCalls = 0;
    const result = await runSetup({
      repoRoot,
      yes: true,
      noWatcher: true,
      detectionOverride: {
        level: "low",
        signals: ["weak signal"],
      },
      // The fixture should never be used; if it is, fail loudly.
      prompt: {
        question: async () => {
          promptCalls++;
          throw new Error("setup must not prompt under --yes (CI safety)");
        },
        close: () => undefined,
      },
    });
    assert.equal(promptCalls, 0, "--yes must not invoke the prompt");
    assert.ok(
      result.notes.some((n) => /deterministic safe path/.test(n)),
      "expected an explanatory note about --yes choosing the safe path",
    );
    // With --no-watcher the only remaining option is manual.
    assert.equal(result.captureMode, "manual");
    // No hooks should have been installed.
    await assert.rejects(() =>
      fs.access(path.join(repoRoot, ".claude", "settings.json")),
    );
  });

  test("low-confidence detection installs hooks when prompt answers 'y'", async () => {
    let asked = "";
    const result = await runSetup({
      repoRoot,
      yes: false,
      noWatcher: true,
      detectionOverride: {
        level: "low",
        signals: ["weak signal"],
      },
      prompt: {
        question: async (q: string) => {
          asked = q;
          return "y";
        },
        close: () => undefined,
      },
    });
    assert.match(asked, /Install Claude Code hooks/i);
    assert.equal(result.captureMode, "hooks");
  });

  test("none-confidence + --no-watcher leaves capture_mode='manual'", async () => {
    const result = await runSetup({
      repoRoot,
      yes: true,
      noWatcher: true,
      detectionOverride: { level: "none", signals: [] },
    });
    assert.equal(result.captureMode, "manual");
    assert.ok(result.actions.includes("manual"));
  });

  test("formatSetupResult mentions capture_mode and includes the capture-path block", () => {
    const out = formatSetupResult({
      initResult: {
        repoRoot: "/repo",
        alreadyExisted: false,
        configWritten: true,
        kodelaignoreWritten: true,
        gettingStartedWritten: true,
        trackedFiles: 0,
        hooksInstalled: false,
        hooksSkipped: false,
      },
      detection: { level: "none", signals: [] },
      captureMode: "watcher",
      actions: ["init", "watcher-started"],
      notes: ["Watcher started in background — pid=1234"],
      printOnly: false,
    });
    assert.match(out, /capture_mode=watcher/);
    assert.match(out, /Watcher/);
    assert.match(out, /Capture path:/);
  });

  test("formatSetupResult renders watcher as RUNNING when capture mode is 'watcher' even without a fresh start", () => {
    // Idempotency contract: when setup is re-run against an already-running
    // watcher, actions = ["init", "watcher-skipped"] but captureMode is still
    // "watcher".  The shared block must show watcher as running, not stopped.
    const out = formatSetupResult({
      initResult: {
        repoRoot: "/repo",
        alreadyExisted: true,
        configWritten: false,
        kodelaignoreWritten: false,
        gettingStartedWritten: false,
        trackedFiles: 42,
        hooksInstalled: false,
        hooksSkipped: false,
      },
      detection: { level: "none", signals: [] },
      captureMode: "watcher",
      actions: ["init", "watcher-skipped"],
      notes: ["Watcher already running — pid=9999"],
      printOnly: false,
    });
    assert.match(out, /capture_mode=watcher/);
    // The shared block must reflect the live state (watcher is running),
    // not whether *this* invocation freshly started it.
    assert.doesNotMatch(
      out,
      /watcher.*not running|watcher.*stopped/i,
      "watcher must not be rendered as stopped when capture_mode is 'watcher'",
    );
  });

  test("formatSetupResult renders hooks as INSTALLED when capture mode is 'hooks' even without a fresh install", () => {
    // Sister test for hooks idempotency: re-running setup against an already
    // hooks-installed repo gives actions=["init"] (no hooks action), captureMode="hooks".
    const out = formatSetupResult({
      initResult: {
        repoRoot: "/repo",
        alreadyExisted: true,
        configWritten: false,
        kodelaignoreWritten: false,
        gettingStartedWritten: false,
        trackedFiles: 42,
        hooksInstalled: false,
        hooksSkipped: false,
      },
      detection: { level: "high", signals: ["CLAUDECODE=1"] },
      captureMode: "hooks",
      actions: ["init"],
      notes: ["Capture mode already set to hooks"],
      printOnly: false,
    });
    assert.match(out, /capture_mode=hooks/);
    assert.doesNotMatch(
      out,
      /hooks.*not installed/i,
      "hooks must not be rendered as missing when capture_mode is 'hooks'",
    );
  });

  // ── Stale-schema upgrade path (spec lines 98 & 109) ────────────────────
  // When `kodela.config.json` already exists with an older
  // `_kodela.schema_version` (or no `_kodela` block at all), `kodela setup`
  // must offer to refresh just that block — auto-refresh under `--yes`.
  // A successful refresh also regenerates `.kodela/GETTING_STARTED.md`.

  test("setup --yes auto-refreshes a stale _kodela.schema_version (no --force needed)", async () => {
    // First, run setup once so baseline.json + a real config + GETTING_STARTED.md
    // are generated with the canonical schema.
    await runSetup({
      repoRoot,
      yes: true,
      noWatcher: true,
      detectionOverride: { level: "none", signals: [] },
    });

    // Now mutate the on-disk config so its _kodela.schema_version looks stale
    // (simulating a config written by an older CLI), and overwrite the
    // GETTING_STARTED.md with a sentinel so we can prove it gets regenerated.
    const cfgPath = path.join(repoRoot, "kodela.config.json");
    const cfg = JSON.parse(await fs.readFile(cfgPath, "utf-8")) as {
      _kodela?: Record<string, unknown>;
    };
    cfg._kodela = { ...(cfg._kodela ?? {}), schema_version: 0 };
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    await fs.writeFile(
      path.join(repoRoot, ".kodela", "GETTING_STARTED.md"),
      "OUTDATED — should be regenerated\n",
      "utf-8",
    );

    let promptCalls = 0;
    const result = await runSetup({
      repoRoot,
      yes: true,
      noWatcher: true,
      // No --force — this is the path the reviewer flagged.
      detectionOverride: { level: "none", signals: [] },
      prompt: {
        question: async () => {
          promptCalls++;
          throw new Error("setup --yes must not prompt for stale-schema refresh");
        },
        close: () => undefined,
      },
    });

    assert.equal(promptCalls, 0);
    assert.ok(
      result.notes.some((n) => /Refreshed _kodela metadata block/i.test(n)),
      "expected a 'Refreshed _kodela metadata block' note",
    );

    // On-disk: _kodela.schema_version is now current.
    const raw = await fs.readFile(
      path.join(repoRoot, "kodela.config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as {
      _kodela?: { schema_version?: number };
    };
    assert.ok((parsed._kodela?.schema_version ?? 0) >= 1);

    // GETTING_STARTED.md was regenerated (no longer the OUTDATED placeholder).
    const md = await fs.readFile(
      path.join(repoRoot, ".kodela", "GETTING_STARTED.md"),
      "utf-8",
    );
    assert.doesNotMatch(md, /OUTDATED — should be regenerated/);
    assert.match(md, /Kodela/);
  });

  test("setup (interactive) prompts to refresh a stale _kodela.schema_version and applies it on default-yes", async () => {
    // Bootstrap a real on-disk state, then strip the _kodela block to simulate
    // an older config written before the metadata block existed.
    await runSetup({
      repoRoot,
      yes: true,
      noWatcher: true,
      detectionOverride: { level: "none", signals: [] },
    });
    const cfgPath = path.join(repoRoot, "kodela.config.json");
    const cfg = JSON.parse(await fs.readFile(cfgPath, "utf-8")) as Record<
      string,
      unknown
    >;
    delete cfg["_kodela"];
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");

    let asked = "";
    const result = await runSetup({
      repoRoot,
      yes: false,
      noWatcher: true,
      detectionOverride: { level: "none", signals: [] },
      prompt: {
        question: async (q: string) => {
          asked = q;
          // Default-yes contract: empty input accepts.
          return "";
        },
        close: () => undefined,
      },
    });

    assert.match(asked, /Refresh the _kodela metadata block/);
    assert.ok(
      result.notes.some((n) => /Refreshed _kodela metadata block/i.test(n)),
    );
    const raw = await fs.readFile(
      path.join(repoRoot, "kodela.config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as {
      _kodela?: { schema_version?: number };
    };
    assert.ok(parsed._kodela, "_kodela block should now exist");
  });

  test("setup (interactive) keeps the existing block when the operator declines the refresh", async () => {
    await runSetup({
      repoRoot,
      yes: true,
      noWatcher: true,
      detectionOverride: { level: "none", signals: [] },
    });
    const cfgPath = path.join(repoRoot, "kodela.config.json");
    const cfg = JSON.parse(await fs.readFile(cfgPath, "utf-8")) as {
      _kodela?: Record<string, unknown>;
    };
    cfg._kodela = { ...(cfg._kodela ?? {}), schema_version: 0 };
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");

    const result = await runSetup({
      repoRoot,
      yes: false,
      noWatcher: true,
      detectionOverride: { level: "none", signals: [] },
      prompt: {
        question: async () => "n",
        close: () => undefined,
      },
    });

    assert.ok(
      result.notes.some((n) => /declined the metadata refresh/i.test(n)),
    );
    const raw = await fs.readFile(
      path.join(repoRoot, "kodela.config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw) as {
      _kodela?: { schema_version?: number };
    };
    assert.equal(parsed._kodela?.schema_version, 0);
  });

  test("setup is a no-op for stale-schema detection when _kodela.schema_version is already current", async () => {
    // After a fresh setup, the on-disk config is already at the current
    // schema_version — re-running setup should not prompt or refresh.
    await runSetup({
      repoRoot,
      yes: true,
      noWatcher: true,
      detectionOverride: { level: "none", signals: [] },
    });

    let promptCalls = 0;
    const result = await runSetup({
      repoRoot,
      yes: false,
      noWatcher: true,
      detectionOverride: { level: "none", signals: [] },
      prompt: {
        question: async () => {
          promptCalls++;
          return "n";
        },
        close: () => undefined,
      },
    });
    assert.equal(promptCalls, 0, "no prompt when schema is already current");
    assert.ok(
      !result.notes.some((n) => /Refreshed _kodela metadata block/i.test(n)),
    );
  });
});
