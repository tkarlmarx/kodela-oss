// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { coalesceChangeType } from "./coalescer.js";
import { startWatcher } from "./watcher.js";
import { ChangeType } from "./types.js";
import type { BatchedEvent, Watcher } from "./types.js";

function waitForBatch(
  watcher: Watcher,
  timeoutMs = 3000,
): Promise<BatchedEvent> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`Timed out waiting for batch event after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    watcher.on("batch", (batch) => {
      clearTimeout(t);
      resolve(batch);
    });
  });
}

function waitForReady(
  watcher: Watcher,
  timeoutMs = 3000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`Timed out waiting for ready event after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    watcher.on("ready", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kodela-watcher-test-"));
}

describe("coalesceChangeType — state machine rules", () => {
  it("undefined + add → create", () => {
    assert.equal(coalesceChangeType(undefined, "add"), ChangeType.create);
  });

  it("undefined + change → modify", () => {
    assert.equal(coalesceChangeType(undefined, "change"), ChangeType.modify);
  });

  it("undefined + unlink → delete", () => {
    assert.equal(coalesceChangeType(undefined, "unlink"), ChangeType.delete);
  });

  it("create + change → create (add→change stays add)", () => {
    assert.equal(coalesceChangeType(ChangeType.create, "change"), ChangeType.create);
  });

  it("create + unlink → delete (add→delete)", () => {
    assert.equal(coalesceChangeType(ChangeType.create, "unlink"), ChangeType.delete);
  });

  it("modify + change → modify (change→change)", () => {
    assert.equal(coalesceChangeType(ChangeType.modify, "change"), ChangeType.modify);
  });

  it("modify + unlink → delete (change→delete)", () => {
    assert.equal(coalesceChangeType(ChangeType.modify, "unlink"), ChangeType.delete);
  });

  it("delete + add → modify (delete→add becomes recreate)", () => {
    assert.equal(coalesceChangeType(ChangeType.delete, "add"), ChangeType.modify);
  });

  it("modify + add → modify (duplicate add after modify)", () => {
    assert.equal(coalesceChangeType(ChangeType.modify, "add"), ChangeType.modify);
  });
});

describe("startWatcher — integration", () => {
  let tmpDir: string;
  let watcher: Watcher;
  const SHORT_DEBOUNCE = 200;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    watcher.stop();
    await sleep(100);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("emits a batch event when a file is created", async () => {
    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });
    const batchPromise = waitForBatch(watcher);

    await sleep(150);
    await fs.writeFile(path.join(tmpDir, "hello.ts"), "export {}");

    const batch = await batchPromise;
    assert.equal(batch.events.length, 1);
    const [ev] = batch.events;
    assert.ok(ev !== undefined);
    assert.ok(ev.filePath.endsWith("hello.ts"));
    assert.equal(ev.changeType, ChangeType.create);
    assert.equal(typeof ev.timestamp, "number");
    assert.ok(ev.eventCount !== undefined && ev.eventCount >= 1);
  });

  it("emits modify when an existing file is changed", async () => {
    const filePath = path.join(tmpDir, "change-me.ts");
    await fs.writeFile(filePath, "const a = 1;");

    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });
    const batchPromise = waitForBatch(watcher);

    await sleep(150);
    await fs.writeFile(filePath, "const a = 2;");

    const batch = await batchPromise;
    assert.equal(batch.events.length, 1);
    const [ev] = batch.events;
    assert.ok(ev !== undefined);
    assert.equal(ev.changeType, ChangeType.modify);
  });

  it("emits delete when a file is removed", async () => {
    const filePath = path.join(tmpDir, "delete-me.ts");
    await fs.writeFile(filePath, "const x = 0;");

    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });
    const batchPromise = waitForBatch(watcher);

    await sleep(150);
    await fs.rm(filePath);

    const batch = await batchPromise;
    assert.equal(batch.events.length, 1);
    const [ev] = batch.events;
    assert.ok(ev !== undefined);
    assert.equal(ev.changeType, ChangeType.delete);
  });

  it("batches multiple file changes into one event", async () => {
    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });
    const batchPromise = waitForBatch(watcher);

    await sleep(150);
    await Promise.all([
      fs.writeFile(path.join(tmpDir, "a.ts"), "1"),
      fs.writeFile(path.join(tmpDir, "b.ts"), "2"),
      fs.writeFile(path.join(tmpDir, "c.ts"), "3"),
    ]);

    const batch = await batchPromise;
    assert.ok(batch.events.length >= 1);
    const paths = batch.events.map((e) => path.basename(e.filePath));
    assert.ok(paths.includes("a.ts"), "expected a.ts in batch");
    assert.ok(paths.includes("b.ts"), "expected b.ts in batch");
    assert.ok(paths.includes("c.ts"), "expected c.ts in batch");
  });

  it("deduplicates rapid writes to the same file — one ChangeEvent per file", async () => {
    const filePath = path.join(tmpDir, "rapid.ts");

    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });
    const batchPromise = waitForBatch(watcher);

    await sleep(150);
    await fs.writeFile(filePath, "v1");
    await sleep(20);
    await fs.writeFile(filePath, "v2");
    await sleep(20);
    await fs.writeFile(filePath, "v3");

    const batch = await batchPromise;
    const matching = batch.events.filter((e) =>
      e.filePath.endsWith("rapid.ts"),
    );
    assert.equal(matching.length, 1, "expected exactly one event for rapid.ts");
    const [ev] = matching;
    assert.ok(ev !== undefined);
    assert.ok(
      ev.eventCount !== undefined && ev.eventCount >= 1,
      `expected eventCount >= 1, got ${String(ev.eventCount)}`,
    );
  });

  it("coalesces add → change into a single create event", async () => {
    const filePath = path.join(tmpDir, "coalesce.ts");
    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });
    const batchPromise = waitForBatch(watcher);

    await sleep(150);
    await fs.writeFile(filePath, "v1");
    await sleep(20);
    await fs.writeFile(filePath, "v2");

    const batch = await batchPromise;
    const [ev] = batch.events.filter((e) => e.filePath.endsWith("coalesce.ts"));
    assert.ok(ev !== undefined);
    assert.equal(ev.changeType, ChangeType.create);
  });

  it("detects a potential rename when unlink + add occur in same window", async () => {
    const srcPath = path.join(tmpDir, "before.ts");
    const dstPath = path.join(tmpDir, "after.ts");
    await fs.writeFile(srcPath, "const x = 1;");

    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });
    const batchPromise = waitForBatch(watcher);

    await sleep(150);
    await fs.rename(srcPath, dstPath);

    const batch = await batchPromise;
    const addEv = batch.events.find((e) => e.filePath.endsWith("after.ts"));

    assert.ok(
      addEv !== undefined,
      `expected an add event for after.ts in: ${JSON.stringify(batch.events.map((e) => e.filePath))}`,
    );
    assert.ok(
      addEv.renameFrom !== undefined && addEv.renameFrom.endsWith("before.ts"),
      `expected renameFrom to reference before.ts, got: ${String(addEv.renameFrom)}`,
    );
  });

  it("flushes early when maxBatchSize is exceeded", async () => {
    const MAX = 5;
    watcher = startWatcher({
      rootDir: tmpDir,
      debounceMs: 5000,
      maxBatchSize: MAX,
    });

    const batches: BatchedEvent[] = [];
    watcher.on("batch", (b) => batches.push(b));

    await sleep(150);

    for (let i = 0; i < MAX + 1; i++) {
      await fs.writeFile(path.join(tmpDir, `file-${String(i)}.ts`), String(i));
    }

    await sleep(500);
    assert.ok(batches.length >= 1, "expected at least one early flush batch");
    const totalEvents = batches.flatMap((b) => b.events).length;
    assert.ok(totalEvents >= 1, "expected events in early flush");
  });

  it("stop() is idempotent — calling twice does not throw", () => {
    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });
    assert.doesNotThrow(() => {
      watcher.stop();
      watcher.stop();
    });
  });

  it("stop() clears pending timer — no late events after stop", async () => {
    const filePath = path.join(tmpDir, "late.ts");

    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });

    let batchFired = false;
    watcher.on("batch", () => {
      batchFired = true;
    });

    await sleep(150);
    await fs.writeFile(filePath, "x");
    await sleep(50);
    watcher.stop();

    await sleep(SHORT_DEBOUNCE + 100);
    assert.equal(batchFired, false, "expected no batch after stop()");
  });

  it("includes sizeDelta in events when stat is available", async () => {
    const filePath = path.join(tmpDir, "sized.ts");

    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });
    const batchPromise = waitForBatch(watcher);

    await sleep(150);
    await fs.writeFile(filePath, "hello world");

    const batch = await batchPromise;
    const [ev] = batch.events.filter((e) => e.filePath.endsWith("sized.ts"));
    assert.ok(ev !== undefined);
    assert.ok(
      ev.sizeDelta !== undefined,
      "expected sizeDelta to be present",
    );
  });

  it("flushes early at the default maxBatchSize of 500 (no custom override)", async () => {
    watcher = startWatcher({ rootDir: tmpDir, debounceMs: 5000 });

    const batches: BatchedEvent[] = [];
    watcher.on("batch", (b) => batches.push(b));

    await sleep(150);

    const fileCount = 501;
    await Promise.all(
      Array.from({ length: fileCount }, (_, i) =>
        fs.writeFile(path.join(tmpDir, `bulk-default-${String(i)}.ts`), ""),
      ),
    );

    await sleep(800);
    assert.ok(batches.length >= 1, "expected early flush at default 500-file threshold");
    const totalEvents = batches.flatMap((b) => b.events).length;
    assert.ok(
      totalEvents >= 1,
      `expected events in early flush, got ${String(totalEvents)}`,
    );
  });

  it("sizeDelta is undefined for a pre-existing file's first change (no inflated baseline)", async () => {
    const filePath = path.join(tmpDir, "existing.ts");
    await fs.writeFile(filePath, "const a = 1;");

    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });
    const batchPromise = waitForBatch(watcher);

    await sleep(150);
    await fs.writeFile(filePath, "const a = 2;");

    const batch = await batchPromise;
    const [ev] = batch.events.filter((e) => e.filePath.endsWith("existing.ts"));
    assert.ok(ev !== undefined);
    assert.equal(ev.changeType, ChangeType.modify);
    assert.equal(
      ev.sizeDelta,
      undefined,
      "sizeDelta must be undefined when prior size baseline is unknown (pre-existing file)",
    );
  });

  it("supports multiple on('batch') listeners — all are called", async () => {
    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });

    const results: string[] = [];
    watcher.on("batch", () => results.push("listener-a"));
    watcher.on("batch", () => results.push("listener-b"));

    await sleep(150);
    await fs.writeFile(path.join(tmpDir, "multi.ts"), "x");

    await sleep(SHORT_DEBOUNCE + 200);
    assert.deepEqual(results, ["listener-a", "listener-b"]);
  });

  it("sizeDelta is not double-counted when delete + add occur in the same window", async () => {
    const filePath = path.join(tmpDir, "recreate.ts");

    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });

    await sleep(150);

    await fs.writeFile(filePath, "hello");
    const firstBatch = await waitForBatch(watcher);
    const firstEv = firstBatch.events.find((e) =>
      e.filePath.endsWith("recreate.ts"),
    );
    assert.ok(firstEv !== undefined, "expected event for recreate.ts in first batch");
    const firstSize = firstEv.sizeDelta;
    assert.ok(firstSize !== undefined && firstSize > 0, "first create sizeDelta should be > 0");

    const nextBatch = waitForBatch(watcher);
    await fs.unlink(filePath);
    await fs.writeFile(filePath, "world-larger-content");

    const secondBatch = await nextBatch;
    const secondEv = secondBatch.events.find((e) =>
      e.filePath.endsWith("recreate.ts"),
    );
    assert.ok(secondEv !== undefined, "expected event for recreate.ts in second batch");
    if (secondEv.sizeDelta !== undefined) {
      assert.ok(
        secondEv.sizeDelta >= 0,
        `sizeDelta must not be double-counted (was ${String(secondEv.sizeDelta)})`,
      );
    }
  });

  it("coalescing is correct under rapid concurrent events (no async race)", async () => {
    const filePath = path.join(tmpDir, "race.ts");

    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });
    const batchPromise = waitForBatch(watcher);

    await sleep(150);

    await fs.writeFile(filePath, "initial");
    await sleep(10);
    await fs.writeFile(filePath, "update1");
    await sleep(10);
    await fs.writeFile(filePath, "update2");

    const batch = await batchPromise;
    const matching = batch.events.filter((e) => e.filePath.endsWith("race.ts"));
    assert.equal(matching.length, 1, "expected one coalesced event for race.ts");
    const [ev] = matching;
    assert.ok(ev !== undefined);
    assert.equal(
      ev.changeType,
      ChangeType.create,
      "add followed by changes must coalesce to create",
    );
    assert.ok(
      ev.eventCount !== undefined && ev.eventCount >= 2,
      `expected eventCount >= 2, got ${String(ev.eventCount)}`,
    );
  });

  it("fires the ready callback after the initial filesystem scan", async () => {
    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });
    await waitForReady(watcher);
  });

  it("supports multiple on('ready') listeners — all called in registration order", async () => {
    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });

    const order: string[] = [];
    const p1 = new Promise<void>((resolve) => {
      watcher.on("ready", () => { order.push("first"); resolve(); });
    });
    const p2 = new Promise<void>((resolve) => {
      watcher.on("ready", () => { order.push("second"); resolve(); });
    });

    await Promise.all([p1, p2]);
    assert.deepEqual(order, ["first", "second"]);
  });

  it("late on('ready') registration fires callback synchronously when already ready", async () => {
    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });
    await waitForReady(watcher);

    let called = false;
    let wasSync = false;
    watcher.on("ready", () => { called = true; });
    wasSync = called;

    assert.equal(wasSync, true, "late ready callback must be called synchronously");
  });

  it("does not fire ready callback after stop()", async () => {
    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });

    let called = false;
    watcher.on("ready", () => { called = true; });

    watcher.stop();
    await sleep(300);

    assert.equal(called, false, "ready callback must not fire after stop()");
  });

  it("batch events are not missed — batch works normally after ready fires", async () => {
    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });
    await waitForReady(watcher);

    const batchPromise = waitForBatch(watcher);
    await fs.writeFile(path.join(tmpDir, "post-ready.ts"), "x");

    const batch = await batchPromise;
    assert.ok(
      batch.events.some((e) => e.filePath.endsWith("post-ready.ts")),
      "expected post-ready.ts in batch after ready",
    );
  });

  it("events fired after ready are reliably captured and not dropped", async () => {
    watcher = startWatcher({ rootDir: tmpDir, debounceMs: SHORT_DEBOUNCE });

    await waitForReady(watcher);

    const batchPromise = waitForBatch(watcher);
    await fs.writeFile(path.join(tmpDir, "after-ready.ts"), "x");
    await fs.writeFile(path.join(tmpDir, "after-ready-2.ts"), "y");

    const batch = await batchPromise;
    assert.ok(
      batch.events.some((e) => e.filePath.endsWith("after-ready.ts")),
      "after-ready.ts must not be dropped",
    );
    assert.ok(
      batch.events.some((e) => e.filePath.endsWith("after-ready-2.ts")),
      "after-ready-2.ts must not be dropped",
    );
  });
});
