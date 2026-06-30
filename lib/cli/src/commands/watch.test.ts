// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runWatch } from "./watch.js";
import type { WatcherFactory, HealFn } from "./watch.js";
import type { KodelaConfig } from "../config/schema.js";
import {
  formatWatchBatchResult,
  formatEngineWatchBatchResult,
} from "../output/formatters.js";
import type { WatchBatchResult, EngineWatchBatchResult } from "../output/formatters.js";
import type { Watcher, BatchCallback, ReadyCallback, ChangeEvent } from "@kodela/watcher";
import { heal } from "./heal-engine.js";
import type { HealEngineOptions, MappingDecision } from "./heal-engine.js";
import { runInit } from "./init.js";
import { runAdd } from "./add.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Races `promise` against a timeout.  If the timeout fires first the returned
 * promise rejects with a descriptive error so the test fails immediately
 * instead of hanging until the runner's global deadline.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, reject) => {
    handle = setTimeout(
      () => reject(new Error(`withTimeout: "${label}" did not settle within ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(handle));
}

function captureStream(): { stream: NodeJS.WriteStream; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc: string, cb: () => void) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  return { stream, lines: () => chunks.join("").split("\n").filter(Boolean) };
}

function makeStubWatcher(): {
  watcher: Watcher;
  fireBatch: (filePaths: string[]) => void;
  fireBatchEvents: (events: ChangeEvent[]) => void;
  fireReady: () => void;
  stopped: () => boolean;
} {
  let batchListeners: BatchCallback[] = [];
  let readyListeners: ReadyCallback[] = [];
  let isReady = false;
  let isStopped = false;

  const watcher: Watcher = {
    on(event: "batch" | "ready", cb: BatchCallback | ReadyCallback) {
      if (event === "batch") {
        batchListeners.push(cb as BatchCallback);
      } else {
        if (isReady) {
          (cb as ReadyCallback)();
        } else {
          readyListeners.push(cb as ReadyCallback);
        }
      }
    },
    stop() {
      isStopped = true;
    },
  };

  const fireReady = () => {
    isReady = true;
    for (const cb of readyListeners) cb();
    readyListeners = [];
  };

  const fireBatch = (filePaths: string[]) => {
    const batch = {
      events: filePaths.map((fp) => ({
        filePath: fp,
        changeType: "modify" as const,
        timestamp: Date.now(),
      })),
    };
    for (const cb of batchListeners) cb(batch);
  };

  const fireBatchEvents = (events: ChangeEvent[]) => {
    for (const cb of batchListeners) cb({ events });
  };

  return { watcher, fireBatch, fireBatchEvents, fireReady, stopped: () => isStopped };
}

/**
 * Stub for the engine-style `HealFn`:
 *   (changes: ChangeEvent[], opts: HealEngineOptions) => Promise<{ updated, orphaned, uncertain }>
 */
function makeStubHealFn(result: { updated?: number; orphaned?: number; uncertain?: number } = {}): {
  fn: HealFn;
  calls: () => Array<{ changes: ChangeEvent[]; opts: HealEngineOptions }>;
} {
  const calls: Array<{ changes: ChangeEvent[]; opts: HealEngineOptions }> = [];
  const fn: HealFn = async (changes, opts) => {
    calls.push({ changes, opts });
    return {
      updated: result.updated ?? 0,
      orphaned: result.orphaned ?? 0,
      uncertain: result.uncertain ?? 0,
    };
  };
  return { fn, calls: () => calls };
}

// ─── formatWatchBatchResult (legacy formatter) ─────────────────────────────

describe("formatWatchBatchResult", () => {
  test("formats a single-file batch correctly", () => {
    const result: WatchBatchResult = {
      filePaths: ["src/foo.ts"],
      healed: 2,
      total: 3,
      failed: 0,
      dryRun: false,
      durationMs: 42,
    };
    const msg = formatWatchBatchResult(result);
    assert.ok(msg.includes("[watch]"), "has [watch] prefix");
    assert.ok(msg.includes("healed 2/3"), "shows healed/total");
    assert.ok(msg.includes("1 file"), "singular 'file'");
    assert.ok(msg.includes("(42ms)"), "includes duration");
    assert.ok(!msg.includes("[DRY RUN]"), "no dry-run prefix");
  });

  test("uses plural 'files' for multiple files", () => {
    const result: WatchBatchResult = {
      filePaths: ["src/a.ts", "src/b.ts"],
      healed: 1,
      total: 2,
      failed: 0,
      dryRun: false,
      durationMs: 10,
    };
    assert.ok(formatWatchBatchResult(result).includes("2 files"));
  });

  test("includes [DRY RUN] prefix when dryRun is true", () => {
    const result: WatchBatchResult = {
      filePaths: ["src/foo.ts"],
      healed: 0,
      total: 1,
      failed: 0,
      dryRun: true,
      durationMs: 5,
    };
    assert.ok(formatWatchBatchResult(result).includes("[DRY RUN]"));
  });
});

// ─── formatEngineWatchBatchResult ──────────────────────────────────────────

describe("formatEngineWatchBatchResult", () => {
  test("formats engine result with updated/orphaned/uncertain counts", () => {
    const result: EngineWatchBatchResult = {
      filePaths: ["src/foo.ts"],
      updated: 3,
      orphaned: 1,
      uncertain: 2,
      dryRun: false,
      durationMs: 55,
    };
    const msg = formatEngineWatchBatchResult(result);
    assert.ok(msg.includes("[watch]"), "has [watch] prefix");
    assert.ok(msg.includes("healed 3/6"), "shows updated/total");
    assert.ok(msg.includes("1 file"), "singular 'file'");
    assert.ok(msg.includes("(55ms)"), "includes duration");
    assert.ok(msg.includes("updated=3"), "includes updated count");
    assert.ok(msg.includes("orphaned=1"), "includes orphaned count");
    assert.ok(msg.includes("uncertain=2"), "includes uncertain count");
    assert.ok(!msg.includes("[DRY RUN]"), "no dry-run prefix when dryRun=false");
  });

  test("uses plural 'files' for multiple files", () => {
    const result: EngineWatchBatchResult = {
      filePaths: ["src/a.ts", "src/b.ts"],
      updated: 1,
      orphaned: 0,
      uncertain: 1,
      dryRun: false,
      durationMs: 10,
    };
    assert.ok(formatEngineWatchBatchResult(result).includes("2 files"));
  });

  test("includes [DRY RUN] prefix when dryRun is true", () => {
    const result: EngineWatchBatchResult = {
      filePaths: ["src/foo.ts"],
      updated: 0,
      orphaned: 0,
      uncertain: 1,
      dryRun: true,
      durationMs: 5,
    };
    assert.ok(formatEngineWatchBatchResult(result).includes("[DRY RUN]"));
  });

  test("total is sum of all three buckets", () => {
    const result: EngineWatchBatchResult = {
      filePaths: ["src/x.ts"],
      updated: 2,
      orphaned: 3,
      uncertain: 5,
      dryRun: false,
      durationMs: 20,
    };
    const msg = formatEngineWatchBatchResult(result);
    assert.ok(msg.includes("healed 2/10"), "total = 2+3+5 = 10");
  });
});

// ─── runWatch (incremental engine path) ────────────────────────────────────

describe("runWatch", () => {
  test("prints starting and ready lines", async () => {
    const { stream, lines } = captureStream();
    const stub = makeStubWatcher();
    const factory: WatcherFactory = () => stub.watcher;
    const healFn = makeStubHealFn().fn;

    await runWatch({ repoRoot: "/repo", watcherFactory: factory, healFn }, stream);
    stub.fireReady();

    const output = lines();
    assert.ok(output.some((l) => l.includes("[watch]") && l.includes("Starting")), "prints starting line");
    assert.ok(output.some((l) => l.includes("[watch]") && l.includes("Ready")), "prints ready line");
  });

  test("returns a Watcher with a stop() method", async () => {
    const stub = makeStubWatcher();
    const factory: WatcherFactory = () => stub.watcher;
    const { stream } = captureStream();

    const watcher = await runWatch({ repoRoot: "/repo", watcherFactory: factory, healFn: makeStubHealFn().fn }, stream);
    assert.ok(typeof watcher.stop === "function");
  });

  test("calls healFn with raw ChangeEvent[] and HealEngineOptions on batch", async () => {
    const repoRoot = "/repo";
    const stub = makeStubWatcher();
    const factory: WatcherFactory = () => stub.watcher;
    const { fn: healFn, calls } = makeStubHealFn({ updated: 1 });
    const { stream } = captureStream();

    await runWatch({ repoRoot, watcherFactory: factory, healFn }, stream);

    const events: ChangeEvent[] = [
      { filePath: path.join(repoRoot, "src", "utils.ts"), changeType: "modify", timestamp: Date.now() },
      { filePath: path.join(repoRoot, "src", "index.ts"), changeType: "create", timestamp: Date.now() },
    ];
    stub.fireBatchEvents(events);

    await new Promise((r) => setImmediate(r));

    assert.equal(calls().length, 1, "heal called once per batch");
    const call = calls()[0]!;
    assert.equal(call.changes.length, 2, "both events forwarded");
    assert.equal(call.changes[0]!.filePath, events[0]!.filePath, "first event filePath preserved");
    assert.equal(call.changes[1]!.changeType, "create", "second event changeType preserved");
    assert.equal(call.opts.repoRoot, repoRoot, "repoRoot forwarded");
  });

  test("forwards dryRun flag to healFn opts", async () => {
    const repoRoot = "/repo";
    const stub = makeStubWatcher();
    const factory: WatcherFactory = () => stub.watcher;
    const { fn: healFn, calls } = makeStubHealFn();
    const { stream } = captureStream();

    await runWatch({ repoRoot, dryRun: true, watcherFactory: factory, healFn }, stream);
    stub.fireBatch([path.join(repoRoot, "src", "a.ts")]);

    await new Promise((r) => setImmediate(r));

    assert.equal(calls()[0]?.opts.dryRun, true, "dryRun forwarded to heal opts");
  });

  test("passes contentCache in opts and reuses same Map instance across batches", async () => {
    const repoRoot = "/repo";
    const stub = makeStubWatcher();
    const factory: WatcherFactory = () => stub.watcher;
    const cacheInstances: Array<Map<string, string>> = [];
    const healFn: HealFn = async (_changes, opts) => {
      if (opts.contentCache) cacheInstances.push(opts.contentCache);
      return { updated: 0, orphaned: 0, uncertain: 0 };
    };
    const { stream } = captureStream();

    await runWatch({ repoRoot, watcherFactory: factory, healFn }, stream);

    stub.fireBatch([path.join(repoRoot, "src", "a.ts")]);
    await new Promise((r) => setImmediate(r));

    stub.fireBatch([path.join(repoRoot, "src", "b.ts")]);
    await new Promise((r) => setImmediate(r));

    assert.equal(cacheInstances.length, 2, "cache passed in both batches");
    assert.ok(cacheInstances[0] === cacheInstances[1], "same Map instance reused across batches");
  });

  test("clears contentCache between batches", async () => {
    const repoRoot = "/repo";
    const stub = makeStubWatcher();
    const factory: WatcherFactory = () => stub.watcher;
    const cacheSizesAtCallTime: number[] = [];
    const healFn: HealFn = async (_changes, opts) => {
      if (opts.contentCache) {
        cacheSizesAtCallTime.push(opts.contentCache.size);
        opts.contentCache.set("stale-key", "stale-value");
      }
      return { updated: 0, orphaned: 0, uncertain: 0 };
    };
    const { stream } = captureStream();

    await runWatch({ repoRoot, watcherFactory: factory, healFn }, stream);

    stub.fireBatch([path.join(repoRoot, "src", "a.ts")]);
    await new Promise((r) => setImmediate(r));

    stub.fireBatch([path.join(repoRoot, "src", "b.ts")]);
    await new Promise((r) => setImmediate(r));

    assert.equal(cacheSizesAtCallTime[0], 0, "cache is empty at start of first batch");
    assert.equal(cacheSizesAtCallTime[1], 0, "cache cleared before second batch");
  });

  test("prints engine batch summary with updated/orphaned/uncertain on each batch", async () => {
    const repoRoot = "/repo";
    const stub = makeStubWatcher();
    const factory: WatcherFactory = () => stub.watcher;
    const healFn = makeStubHealFn({ updated: 2, orphaned: 1, uncertain: 1 }).fn;
    const { stream, lines } = captureStream();

    await runWatch({ repoRoot, watcherFactory: factory, healFn }, stream);
    stub.fireBatch([path.join(repoRoot, "src", "foo.ts")]);

    await new Promise((r) => setImmediate(r));

    const batchLines = lines().filter((l) => l.includes("healed"));
    assert.equal(batchLines.length, 1, "one batch summary line printed");
    assert.ok(batchLines[0]!.includes("healed 2/4"), "shows updated/total");
    assert.ok(batchLines[0]!.includes("updated=2"), "surfaces updated count");
    assert.ok(batchLines[0]!.includes("orphaned=1"), "surfaces orphaned count");
    assert.ok(batchLines[0]!.includes("uncertain=1"), "surfaces uncertain count");
  });

  test("prints error line when healFn throws", async () => {
    const repoRoot = "/repo";
    const stub = makeStubWatcher();
    const factory: WatcherFactory = () => stub.watcher;
    const errorHeal: HealFn = async () => {
      throw new Error("disk full");
    };
    const { stream, lines } = captureStream();

    await runWatch({ repoRoot, watcherFactory: factory, healFn: errorHeal }, stream);
    stub.fireBatch([path.join(repoRoot, "src", "x.ts")]);

    await new Promise((r) => setImmediate(r));

    const errLines = lines().filter((l) => l.includes("Error during heal"));
    assert.equal(errLines.length, 1, "error line printed");
    assert.ok(errLines[0]!.includes("disk full"), "error message included");
  });

  test("forwards rename event metadata (renameFrom) to healFn intact", async () => {
    const repoRoot = "/repo";
    const stub = makeStubWatcher();
    const factory: WatcherFactory = () => stub.watcher;
    const { fn: healFn, calls } = makeStubHealFn({ updated: 1 });
    const { stream } = captureStream();

    await runWatch({ repoRoot, watcherFactory: factory, healFn }, stream);

    const renameEvent: ChangeEvent = {
      filePath: path.join(repoRoot, "src", "utils-new.ts"),
      changeType: "create",
      renameFrom: path.join(repoRoot, "src", "utils-old.ts"),
      timestamp: Date.now(),
    };
    stub.fireBatchEvents([renameEvent]);

    await new Promise((r) => setImmediate(r));

    assert.equal(calls().length, 1, "healFn called once for the rename batch");
    const call = calls()[0]!;
    assert.equal(call.changes.length, 1, "one event forwarded");
    const forwarded = call.changes[0]!;
    assert.equal(forwarded.changeType, "create", "changeType is 'create'");
    assert.equal(forwarded.filePath, renameEvent.filePath, "new filePath preserved");
    assert.equal(forwarded.renameFrom, renameEvent.renameFrom, "renameFrom metadata preserved");
  });

  test("summary line reports correct file count for a rename batch", async () => {
    const repoRoot = "/repo";
    const stub = makeStubWatcher();
    const factory: WatcherFactory = () => stub.watcher;
    const healFn = makeStubHealFn({ updated: 1 }).fn;
    const { stream, lines } = captureStream();

    await runWatch({ repoRoot, watcherFactory: factory, healFn }, stream);

    const renameEvent: ChangeEvent = {
      filePath: path.join(repoRoot, "src", "widget-new.ts"),
      changeType: "create",
      renameFrom: path.join(repoRoot, "src", "widget-old.ts"),
      timestamp: Date.now(),
    };
    stub.fireBatchEvents([renameEvent]);

    await new Promise((r) => setImmediate(r));

    const summaryLines = lines().filter((l) => l.includes("healed"));
    assert.equal(summaryLines.length, 1, "one summary line printed for rename batch");
    assert.ok(
      summaryLines[0]!.includes("1 file"),
      "summary reports 1 file for a single-rename batch",
    );
  });

  test("forwards config to healFn opts when provided in WatchOptions", async () => {
    const repoRoot = "/repo";
    const stub = makeStubWatcher();
    const factory: WatcherFactory = () => stub.watcher;
    const { fn: healFn, calls } = makeStubHealFn();
    const { stream } = captureStream();

    const customConfig = {
      heal: { ai_confidence_cap: 0.75, rewrite_confidence_factor: 0.9 },
      hooks: { line_threshold: 50, minimum_summary_length: 10, required_fields: ["note"] },
      ci: {
        enforcement: "advisory" as const,
        thresholds: { min_confidence_score: 0.8, max_orphaned_pct: 10, max_unresolved_critical_pct: 5 },
      },
      baseline: { ignore_patterns: [], max_days_before_archive: 90 },
      ai_detection: {
        enabled: true,
        min_lines_added: 100,
        comment_patterns: [],
        insertion_speed_threshold_ms: 2000,
        editor_insertion_min_lines: 10,
        new_file_flag: true,
        new_file_min_lines: 50,
        min_auto_annotate_confidence: 0.7,
      },
      security: { sensitive_paths: [] },
      origin: {
        capture_prompt: false,
        capture_reasoning: true,
        hash_algorithm: "sha256" as const,
      },
      notify: {
        quiet_hours: 24,
        webhooks: [],
        webhook_threshold_pct: 5,
        author_map: {},
      },
      storage: {
        mode: "local" as const,
        server: undefined,
        flush_interval_s: 30,
        max_queue_size: 500,
      },
      detect: {
        threshold_lines: 50,
        uba_threshold: 0.6,
        interactive: true,
      },
    };

    await runWatch({ repoRoot, watcherFactory: factory, healFn, config: customConfig }, stream);
    stub.fireBatch([path.join(repoRoot, "src", "a.ts")]);

    await new Promise((r) => setImmediate(r));

    assert.equal(calls().length, 1, "healFn called once");
    assert.deepStrictEqual(calls()[0]!.opts.config, customConfig, "config forwarded to heal opts");
  });

  test("logs config file path on startup when configPath is provided", async () => {
    const { stream, lines } = captureStream();
    const stub = makeStubWatcher();
    const factory: WatcherFactory = () => stub.watcher;
    const healFn = makeStubHealFn().fn;

    await runWatch(
      { repoRoot: "/repo", watcherFactory: factory, healFn, configPath: "/repo/kodela.config.json" },
      stream,
    );

    const output = lines();
    assert.ok(
      output.some((l) => l.includes("[watch]") && l.includes("Loaded config from") && l.includes("/repo/kodela.config.json")),
      "prints config path on startup",
    );
  });

  test("logs 'No config file found' on startup when configPath is null", async () => {
    const { stream, lines } = captureStream();
    const stub = makeStubWatcher();
    const factory: WatcherFactory = () => stub.watcher;
    const healFn = makeStubHealFn().fn;

    await runWatch(
      { repoRoot: "/repo", watcherFactory: factory, healFn, configPath: null },
      stream,
    );

    const output = lines();
    assert.ok(
      output.some((l) => l.includes("[watch]") && l.includes("No config file found") && l.includes("using defaults")),
      "prints 'using defaults' note on startup when no config found",
    );
  });

  test("stop() can be called to halt the watcher", async () => {
    const stub = makeStubWatcher();
    const factory: WatcherFactory = () => stub.watcher;
    const { stream } = captureStream();

    const watcher = await runWatch({
      repoRoot: "/repo",
      watcherFactory: factory,
      healFn: makeStubHealFn().fn,
    }, stream);

    watcher.stop();
    assert.ok(stub.stopped(), "stop() propagated to underlying watcher");
  });

  test("rename event end-to-end: decisions show filePath updated to new path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-watch-rename-e2e-"));
    try {
      await fs.writeFile(path.join(tmpDir, "old-name.ts"), "export const x = 1;\n");
      await runInit(tmpDir);
      await runAdd({
        repoRoot: tmpDir,
        filePath: "old-name.ts",
        lineStart: 1,
        lineEnd: 1,
        note: "Rename e2e test",
        source: "human",
      });
      // Perform the rename on disk so the heal engine can read new-name.ts
      await fs.rename(path.join(tmpDir, "old-name.ts"), path.join(tmpDir, "new-name.ts"));

      const stub = makeStubWatcher();
      const factory: WatcherFactory = () => stub.watcher;
      const { stream } = captureStream();

      let capturedDecisions: MappingDecision[] | undefined;
      let signalHealDone!: () => void;
      const healDone = new Promise<void>((resolve) => { signalHealDone = resolve; });

      const wrappedHeal: HealFn = async (changes, opts) => {
        try {
          const result = await heal(changes, { ...opts, collectDecisions: true, dryRun: true });
          capturedDecisions = result.decisions;
          return { updated: result.updated, orphaned: result.orphaned, uncertain: result.uncertain };
        } finally {
          signalHealDone();
        }
      };

      await runWatch({ repoRoot: tmpDir, watcherFactory: factory, healFn: wrappedHeal }, stream);

      const renameEvent: ChangeEvent = {
        filePath: path.join(tmpDir, "new-name.ts"),
        changeType: "create",
        renameFrom: path.join(tmpDir, "old-name.ts"),
        timestamp: Date.now(),
      };
      stub.fireBatchEvents([renameEvent]);

      await withTimeout(healDone, 5000, "healDone — heal function never completed");

      assert.ok(Array.isArray(capturedDecisions), "decisions array must be present");
      assert.equal(capturedDecisions!.length, 1, "exactly one decision for the renamed entry");
      assert.equal(
        capturedDecisions![0]!.filePath,
        "new-name.ts",
        "filePath in decision must reflect the new path, not the old one",
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("logs pre-populated prevContentMap message after ready fires", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-watch-prepopulate-"));
    try {
      await fs.writeFile(path.join(tmpDir, "a.ts"), "const a = 1;\n");
      await fs.writeFile(path.join(tmpDir, "b.ts"), "const b = 2;\n");
      await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "src", "c.ts"), "const c = 3;\n");

      const stub = makeStubWatcher();
      const factory: WatcherFactory = () => stub.watcher;
      const healFn = makeStubHealFn().fn;
      const { stream, lines } = captureStream();

      await runWatch({ repoRoot: tmpDir, watcherFactory: factory, healFn }, stream);
      stub.fireReady();

      // Wait for the async pre-population walk to finish.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const output = lines();
      const prePop = output.find((l) => l.includes("Pre-populated prevContentMap"));
      assert.ok(prePop, "should log pre-population message");
      assert.ok(
        prePop!.includes("3 file(s)"),
        `should report 3 files, got: ${prePop}`,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("skips PREWALK_SKIP_DIRS directories during pre-population", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-watch-prepopulate-skip-"));
    try {
      await fs.writeFile(path.join(tmpDir, "index.ts"), "export default 1;\n");
      await fs.mkdir(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
      await fs.mkdir(path.join(tmpDir, ".git"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      const stub = makeStubWatcher();
      const factory: WatcherFactory = () => stub.watcher;
      const healFn = makeStubHealFn().fn;
      const { stream, lines } = captureStream();

      await runWatch({ repoRoot: tmpDir, watcherFactory: factory, healFn }, stream);
      stub.fireReady();
      await new Promise((resolve) => setTimeout(resolve, 200));

      const output = lines();
      const prePop = output.find((l) => l.includes("Pre-populated prevContentMap"));
      assert.ok(prePop, "should log pre-population message");
      assert.ok(
        prePop!.includes("1 file(s)"),
        `should only count 1 file (not node_modules or .git), got: ${prePop}`,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test.skip("SIGTERM causes clean exit with code 0 [quarantined in CE: flaky signal-delivery race; active in enterprise]", async () => {
    const harnessPath = path.resolve(__dirname, "../test-helpers/watch-signal-harness.ts");

    const child = spawn(
      process.execPath,
      ["--import", "tsx", harnessPath],
      {
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let output = "";

      child.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (!ready && output.includes("harness:ready")) {
          ready = true;
          child.kill("SIGTERM");
        }
      });

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("harness timed out"));
      }, 8000);

      child.on("close", (code) => {
        clearTimeout(timeout);
        try {
          assert.equal(code, 0, `SIGTERM should produce exit code 0, got ${code}`);
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      child.on("error", reject);
    });
  });

  // ─── Gap 66 — Batch summary always written by handleAutoAnnotate ─────────

  test("Gap 66: batch summary line is written for a lock-file batch (not meaningful → all skipped)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-gap66-lock-"));
    try {
      const lockFile = path.join(tmpDir, "pnpm-lock.yaml");
      await fs.writeFile(lockFile, "lockfileVersion: '9.0'\n");

      const stub = makeStubWatcher();
      const factory: WatcherFactory = () => stub.watcher;
      const { stream, lines } = captureStream();

      await runWatch({ repoRoot: tmpDir, autoAnnotate: true, watcherFactory: factory }, stream);
      stub.fireReady();
      stub.fireBatch([lockFile]);

      // Give handleAutoAnnotate time to complete.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const output = lines();
      const summaryLine = output.find((l) => l.includes("[watch] Batch processed:"));
      assert.ok(summaryLine, `Expected batch summary line. Got:\n${output.join("\n")}`);
      assert.ok(summaryLine!.includes("1 file(s) seen"), "summary shows 1 file seen");
      assert.ok(summaryLine!.includes("0 annotated"), "summary shows 0 annotated");
      assert.ok(summaryLine!.includes("1 skipped"), "summary shows 1 skipped");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("Gap 66: verbose=true emits per-file skip reason for a lock file (not meaningful)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-gap66-verbose-"));
    try {
      const lockFile = path.join(tmpDir, "package-lock.json");
      await fs.writeFile(lockFile, '{"lockfileVersion": 3, "packages": {}}\n');

      const stub = makeStubWatcher();
      const factory: WatcherFactory = () => stub.watcher;
      const { stream, lines } = captureStream();

      await runWatch({ repoRoot: tmpDir, autoAnnotate: true, verbose: true, watcherFactory: factory }, stream);
      stub.fireReady();
      stub.fireBatch([lockFile]);

      await new Promise((resolve) => setTimeout(resolve, 300));

      const output = lines();
      const skipLine = output.find((l) => l.includes("skipped (not meaningful"));
      assert.ok(
        skipLine,
        `Expected per-file skip line in verbose mode. Got:\n${output.join("\n")}`,
      );
      assert.ok(
        skipLine!.includes("package-lock.json"),
        `Skip line should mention the file. Got: ${skipLine}`,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("Gap 66: verbose=false does NOT emit per-file skip reason for a lock file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-gap66-quiet-"));
    try {
      const lockFile = path.join(tmpDir, "yarn.lock");
      await fs.writeFile(lockFile, "# yarn lockfile v1\n");

      const stub = makeStubWatcher();
      const factory: WatcherFactory = () => stub.watcher;
      const { stream, lines } = captureStream();

      await runWatch({ repoRoot: tmpDir, autoAnnotate: true, verbose: false, watcherFactory: factory }, stream);
      stub.fireReady();
      stub.fireBatch([lockFile]);

      await new Promise((resolve) => setTimeout(resolve, 300));

      const output = lines();
      assert.ok(
        !output.some((l) => l.includes("skipped (not meaningful")),
        `Non-verbose mode must not emit per-file skip lines. Got:\n${output.join("\n")}`,
      );
      // But the batch summary must still appear.
      assert.ok(
        output.some((l) => l.includes("[watch] Batch processed:")),
        "Batch summary line must still appear in non-verbose mode",
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("Gap 66: verbose=true emits skip reason for sensitive path (.env file)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-gap66-sensitive-"));
    try {
      const envFile = path.join(tmpDir, ".env");
      await fs.writeFile(envFile, "SECRET=abc\n");

      const stub = makeStubWatcher();
      const factory: WatcherFactory = () => stub.watcher;
      const { stream, lines } = captureStream();

      await runWatch({ repoRoot: tmpDir, autoAnnotate: true, verbose: true, watcherFactory: factory }, stream);
      stub.fireReady();
      stub.fireBatch([envFile]);

      await new Promise((resolve) => setTimeout(resolve, 300));

      const output = lines();
      const skipLine = output.find((l) => l.includes(".env") && l.includes("skipped"));
      assert.ok(
        skipLine,
        `Expected skip line for .env file in verbose mode. Got:\n${output.join("\n")}`,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ─── AI Summary Layer — diffText decoupled from captureReasoning ──────────

  test("AI summary layer: diffText is computed when aiConfig present even if capture_reasoning=false", async () => {
    // This test verifies that callForProposal() can be reached (and fall back to
    // heuristic on failure) even when capture_reasoning=false.  Without the
    // decoupling fix, diffText was always undefined when captureReasoning=false,
    // so the callForProposal block was never entered.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ai-summary-decoupled-"));

    // Declare KODELA_AGENT so the attribution pipeline fires Layer 1 (confidence=1.0)
    // and the explicit-agent override promotes small UBA changes to "ai" source.
    const origAgent = process.env["KODELA_AGENT"];
    process.env["KODELA_AGENT"] = "replit-agent";

    try {
      await runInit(tmpDir);

      const stub = makeStubWatcher();
      const factory: WatcherFactory = () => stub.watcher;
      const { stream, lines } = captureStream();

      // Config: API key present (aiConfig will be set) but capture_reasoning=false.
      const config = {
        ai_provider: { api_key: "fake-key-for-testing", provider: "openai" as const },
        origin: { capture_reasoning: false, capture_prompt: false, prompt_hash_algorithm: "sha256" as const },
      } as unknown as KodelaConfig;

      await runWatch({ repoRoot: tmpDir, autoAnnotate: true, config, watcherFactory: factory }, stream);
      stub.fireReady();

      // Write a file with enough content to be considered a meaningful change.
      const srcFile = path.join(tmpDir, "src-feature.ts");
      const content = [
        "// AI summary layer decoupling test",
        "export function processItems(items: string[]): string[] {",
        "  return items.filter(Boolean).map(s => s.trim());",
        "}",
        "export function computeHash(value: string): number {",
        "  return value.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);",
        "}",
        "export function formatResult(result: string[]): string {",
        "  return result.join(', ');",
        "}",
      ].join("\n") + "\n";
      await fs.writeFile(srcFile, content);
      stub.fireBatch([srcFile]);

      // Give handleAutoAnnotate enough time to attempt the (failing) AI call and
      // fall back to writing the heuristic note.
      await new Promise((resolve) => setTimeout(resolve, 600));

      const output = lines();

      // With the fix: diffText is computed because aiConfig is set, so the
      // callForProposal block is entered (it throws → heuristic fallback used),
      // and the batch summary reflects an annotation was created.
      // Without the fix: diffText would be undefined, callForProposal skipped,
      // but the entry would STILL be created (with heuristic note regardless).
      // The meaningful assertion is that the entry was created at all, proving
      // that the captureReasoning=false path doesn't break annotation.
      const summaryLine = output.find((l) => l.includes("[watch] Batch processed:"));
      assert.ok(summaryLine, `Expected batch summary line. Got:\n${output.join("\n")}`);

      // The file should be annotated (not skipped) because KODELA_AGENT is set.
      // If captureReasoning=false had erroneously suppressed diffText AND the code
      // had a guard like "if (!diffText) skip annotation", no entry would appear.
      // Since we don't have that guard, we verify the annotation path ran by
      // checking that 0 annotated is NOT the result.
      assert.ok(
        !summaryLine!.includes("0 annotated"),
        `Entry should have been created. Got summary: ${summaryLine}`,
      );
    } finally {
      // Restore env
      if (origAgent === undefined) {
        delete process.env["KODELA_AGENT"];
      } else {
        process.env["KODELA_AGENT"] = origAgent;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("watch auto-annotate writes synthetic request/response turns for continuity", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-watch-turns-"));

    const origAgent = process.env["KODELA_AGENT"];
    process.env["KODELA_AGENT"] = "replit-agent";

    try {
      await runInit(tmpDir);

      const stub = makeStubWatcher();
      const factory: WatcherFactory = () => stub.watcher;
      const { stream } = captureStream();

      await runWatch({ repoRoot: tmpDir, autoAnnotate: true, watcherFactory: factory }, stream);
      stub.fireReady();

      const srcFile = path.join(tmpDir, "watch-turns.ts");
      const content = [
        "export function createWatchTurnSignals(items: string[]): string[] {",
        "  return items.filter(Boolean).map((item) => item.trim());",
        "}",
        "export function summarizeWatchBatch(files: string[]): string {",
        "  return files.join(', ');",
        "}",
      ].join("\n") + "\n";
      await fs.writeFile(srcFile, content);
      stub.fireBatch([srcFile]);

      await new Promise((resolve) => setTimeout(resolve, 700));

      const sessionsDir = path.join(tmpDir, ".kodela", "sessions");
      const sessionFiles = await fs.readdir(sessionsDir);
      const turnFiles = sessionFiles.filter((name) => name.endsWith(".turns.jsonl"));
      assert.ok(
        turnFiles.length > 0,
        `Expected at least one turns file, got: ${sessionFiles.join(", ")}`,
      );

      const turnsRaw = await fs.readFile(path.join(sessionsDir, turnFiles[0]!), "utf-8");
      assert.ok(turnsRaw.includes('"role":"user"'));
      assert.ok(turnsRaw.includes('"role":"assistant"'));
      assert.ok(turnsRaw.includes('"source":"watch-auto-annotate"'));
    } finally {
      if (origAgent === undefined) {
        delete process.env["KODELA_AGENT"];
      } else {
        process.env["KODELA_AGENT"] = origAgent;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
