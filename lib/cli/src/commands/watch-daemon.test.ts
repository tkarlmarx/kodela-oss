// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanWatcherState,
  formatUptime,
  formatWatchStatus,
  isProcessAlive,
  metaFilePath,
  pidFilePath,
  readWatcherMeta,
  refreshWatcherHeartbeat,
  runWatchDetach,
  runWatchStatus,
  runWatchStop,
  writeWatcherMeta,
  HEARTBEAT_STALE_THRESHOLD_MS,
} from "./watch-daemon.js";

const STALE_AGO_MS = HEARTBEAT_STALE_THRESHOLD_MS + 5_000;

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-watch-daemon-"));
  await fs.mkdir(path.join(dir, ".kodela"), { recursive: true });
  return dir;
}

describe("isProcessAlive", () => {
  test("returns true for the current process", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  test("returns false for an obviously dead PID", () => {
    // PID 0 / negative are invalid; pick a very high number unlikely to exist.
    assert.equal(isProcessAlive(2_147_483_646), false);
  });

  test("returns false for invalid PID values", () => {
    assert.equal(isProcessAlive(0), false);
    assert.equal(isProcessAlive(-1), false);
    assert.equal(isProcessAlive(Number.NaN), false);
  });
});

describe("runWatchStatus state machine", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await makeRepo();
  });

  test("returns 'stopped' when no PID/meta files exist", async () => {
    const status = await runWatchStatus(repoRoot);
    assert.equal(status.state, "stopped");
  });

  test("returns 'stopped-stale' when PID points at a dead process", async () => {
    await fs.writeFile(pidFilePath(repoRoot), "2147483646\n", "utf-8");
    await writeWatcherMeta(repoRoot, {
      pid: 2_147_483_646,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      cliVersion: "0.1.0",
    });
    const status = await runWatchStatus(repoRoot);
    assert.equal(status.state, "stopped-stale");
    // Verify the state files were cleaned up.
    await assert.rejects(() => fs.access(pidFilePath(repoRoot)));
    await assert.rejects(() => fs.access(metaFilePath(repoRoot)));
  });

  test("returns 'running' when PID is alive and heartbeat is fresh", async () => {
    const now = Date.now();
    const meta = {
      pid: process.pid,
      startedAt: new Date(now - 60_000).toISOString(),
      lastHeartbeat: new Date(now).toISOString(),
      cliVersion: "0.1.0",
    };
    await fs.writeFile(pidFilePath(repoRoot), `${process.pid}\n`, "utf-8");
    await writeWatcherMeta(repoRoot, meta);
    const status = await runWatchStatus(repoRoot, now);
    assert.equal(status.state, "running");
    if (status.state === "running") {
      assert.equal(status.pid, process.pid);
      assert.ok(status.uptimeMs >= 60_000 - 100);
    }
  });

  test("returns 'degraded' when PID is alive but heartbeat is stale", async () => {
    const now = Date.now();
    const meta = {
      pid: process.pid,
      startedAt: new Date(now - 120_000).toISOString(),
      lastHeartbeat: new Date(now - STALE_AGO_MS).toISOString(),
      cliVersion: "0.1.0",
    };
    await fs.writeFile(pidFilePath(repoRoot), `${process.pid}\n`, "utf-8");
    await writeWatcherMeta(repoRoot, meta);
    const status = await runWatchStatus(repoRoot, now);
    assert.equal(status.state, "degraded");
    if (status.state === "degraded") {
      assert.match(status.reason, /heartbeat/i);
    }
  });
});

describe("runWatchStop", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await makeRepo();
  });

  test("returns alreadyStopped=true when no PID file exists", async () => {
    const result = await runWatchStop(repoRoot);
    assert.equal(result.alreadyStopped, true);
    assert.equal(result.stopped, true);
  });

  test("cleans up state files when PID points at a dead process", async () => {
    await fs.writeFile(pidFilePath(repoRoot), "2147483646\n", "utf-8");
    await writeWatcherMeta(repoRoot, {
      pid: 2_147_483_646,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      cliVersion: "0.1.0",
    });
    const result = await runWatchStop(repoRoot);
    assert.equal(result.alreadyStopped, true);
    assert.equal(result.stopped, true);
    await assert.rejects(() => fs.access(pidFilePath(repoRoot)));
    await assert.rejects(() => fs.access(metaFilePath(repoRoot)));
  });
});

describe("refreshWatcherHeartbeat", () => {
  let repoRoot: string;

  before(async () => {
    repoRoot = await makeRepo();
  });

  after(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  test("is a no-op when no meta file exists", async () => {
    await refreshWatcherHeartbeat(repoRoot);
    // No throw, no file created.
    await assert.rejects(() => fs.access(metaFilePath(repoRoot)));
  });

  test("updates lastHeartbeat without touching other fields", async () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    await writeWatcherMeta(repoRoot, {
      pid: 12345,
      startedAt,
      lastHeartbeat: startedAt,
      cliVersion: "0.1.0",
    });
    await refreshWatcherHeartbeat(repoRoot);
    const updated = await readWatcherMeta(repoRoot);
    assert.ok(updated);
    assert.equal(updated!.pid, 12345);
    assert.equal(updated!.startedAt, startedAt);
    assert.notEqual(updated!.lastHeartbeat, startedAt);
    await cleanWatcherState(repoRoot);
  });
});

describe("formatters", () => {
  test("formatUptime handles seconds, minutes, hours", () => {
    assert.equal(formatUptime(0), "0s");
    assert.equal(formatUptime(45_000), "45s");
    assert.equal(formatUptime(125_000), "2m5s");
    assert.equal(formatUptime(3_600_000), "1h0m");
  });

  test("formatWatchStatus produces a non-empty string for each state", () => {
    assert.match(formatWatchStatus({ state: "stopped" }), /stopped/);

    const runningOut = formatWatchStatus({
      state: "running",
      pid: 1,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      uptimeMs: 1_000,
      heartbeatAgeMs: 0,
      logFile: "/tmp/repo/.kodela/watcher.log",
    });
    assert.match(runningOut, /running/);
    assert.match(runningOut, /Log file: \/tmp\/repo\/\.kodela\/watcher\.log/);

    const degradedOut = formatWatchStatus({
      state: "degraded",
      pid: 1,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      uptimeMs: 1_000,
      heartbeatAgeMs: 999_999,
      reason: "test reason",
      logFile: "/tmp/repo/.kodela/watcher.log",
    });
    assert.match(degradedOut, /degraded/);
    assert.match(degradedOut, /Log file: \/tmp\/repo\/\.kodela\/watcher\.log/);

    assert.match(
      formatWatchStatus({
        state: "stopped-stale",
        pid: 1,
        reason: "stale",
      }),
      /stale/,
    );
  });
});

describe("runWatchDetach idempotency", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await makeRepo();
  });

  test("refuses to spawn when an existing watcher is degraded (alive PID, stale heartbeat)", async () => {
    // Simulate: PID points at the live test process (so isProcessAlive=true),
    // but the heartbeat is older than the staleness threshold → degraded.
    const now = Date.now();
    await fs.writeFile(pidFilePath(repoRoot), `${process.pid}\n`, "utf-8");
    await writeWatcherMeta(repoRoot, {
      pid: process.pid,
      startedAt: new Date(now - STALE_AGO_MS - 60_000).toISOString(),
      lastHeartbeat: new Date(now - STALE_AGO_MS).toISOString(),
      cliVersion: "0.1.0",
    });

    // Sanity: status really is degraded.
    const status = await runWatchStatus(repoRoot);
    assert.equal(status.state, "degraded");

    // The detach call must NOT spawn a duplicate watcher.  We don't pass a
    // binPath so even if it tried to spawn it would crash; the test asserts
    // it short-circuits cleanly with `alreadyRunning=true` and a useful
    // remediation in the reason string.
    const result = await runWatchDetach({
      repoRoot,
      cliVersion: "0.1.0",
      binPath: "/nonexistent/never-spawned",
    });

    assert.equal(result.started, false);
    assert.equal(result.alreadyRunning, true);
    assert.equal(result.pid, process.pid);
    assert.match(result.reason ?? "", /degraded/i);
    assert.match(result.reason ?? "", /watch stop/);
    assert.match(result.reason ?? "", /--force/);

    // PID + meta files must NOT have been overwritten.
    const pidAfter = (
      await fs.readFile(pidFilePath(repoRoot), "utf-8")
    ).trim();
    assert.equal(pidAfter, String(process.pid));
  });
});
