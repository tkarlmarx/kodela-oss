// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 2 — queue idempotency, atomicity, lease rescue.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claimPendingEvent,
  completeSynthesisEvent,
  enqueueSynthesisEvent,
  eventIdFor,
  failSynthesisEvent,
  listPendingEvents,
  requeueInflightEvent,
  rescueExpiredLeases,
} from "./queue.js";

const SESSION = "test-session-aaa";
const FILE_A = "src/a.ts";
const FILE_B = "src/dir/b.ts";

let repoRoot: string;

before(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kodela-synth-test-"));
});

after(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe("synthesis queue", () => {
  test("eventIdFor is deterministic and unique per (session, file)", () => {
    assert.equal(eventIdFor(SESSION, FILE_A), eventIdFor(SESSION, FILE_A));
    assert.notEqual(eventIdFor(SESSION, FILE_A), eventIdFor(SESSION, FILE_B));
    assert.notEqual(eventIdFor("other", FILE_A), eventIdFor(SESSION, FILE_A));
  });

  test("enqueue creates a pending file and is idempotent on second call", () => {
    const a = enqueueSynthesisEvent(repoRoot, { sessionId: SESSION, filePath: FILE_A });
    assert.equal(a.enqueued, true);
    assert.ok(fs.existsSync(a.eventPath));

    const b = enqueueSynthesisEvent(repoRoot, { sessionId: SESSION, filePath: FILE_A });
    assert.equal(b.enqueued, false, "second enqueue must be no-op");
    assert.equal(a.id, b.id);
  });

  test("listPendingEvents returns events in enqueue order", async () => {
    // FILE_A already pending from prior test; add FILE_B.
    await new Promise((resolve) => setTimeout(resolve, 10)); // ensure ISO timestamps differ
    enqueueSynthesisEvent(repoRoot, { sessionId: SESSION, filePath: FILE_B });

    const pending = listPendingEvents(repoRoot);
    assert.ok(pending.length >= 2);
    const filePaths = pending.map((e) => e.filePath);
    const aIdx = filePaths.indexOf(FILE_A);
    const bIdx = filePaths.indexOf(FILE_B);
    assert.ok(aIdx >= 0 && bIdx >= 0);
    assert.ok(aIdx < bIdx, "earlier enqueue must sort first");
  });

  test("claim atomically moves pending → inflight; second claim returns null", () => {
    const id = eventIdFor(SESSION, FILE_A);
    const first = claimPendingEvent(repoRoot, id, { leaseOwner: "worker-1" });
    assert.ok(first);
    assert.equal(first.leaseOwner, "worker-1");
    assert.ok(first.leaseUntil);

    const second = claimPendingEvent(repoRoot, id, { leaseOwner: "worker-2" });
    assert.equal(second, null, "second claim must fail (pending file already moved)");
  });

  test("complete moves inflight → done and stamps the result", () => {
    const id = eventIdFor(SESSION, FILE_A);
    completeSynthesisEvent(repoRoot, id, {
      resultEntryId: "entry-result-1",
      synthesisTemplateVersion: "v1",
      model: "claude-haiku-4-5",
      tokens: 314,
    });

    // No longer inflight; visible under done/.
    const donePath = path.join(repoRoot, ".kodela/synthesis-queue/done", `${id}.json`);
    assert.ok(fs.existsSync(donePath));
    const completed = JSON.parse(fs.readFileSync(donePath, "utf8"));
    assert.equal(completed.resultEntryId, "entry-result-1");
    assert.equal(completed.model, "claude-haiku-4-5");
    assert.equal(completed.tokens, 314);

    // Re-enqueueing the same id is still a no-op (idempotency across done/).
    const reenqueue = enqueueSynthesisEvent(repoRoot, { sessionId: SESSION, filePath: FILE_A });
    assert.equal(reenqueue.enqueued, false);
  });

  test("requeueInflightEvent stamps lastError + attempts and returns to pending", () => {
    const id = eventIdFor(SESSION, FILE_B);
    claimPendingEvent(repoRoot, id, { leaseOwner: "worker-1" });
    requeueInflightEvent(repoRoot, id, "transient: rate limit");

    const pending = listPendingEvents(repoRoot);
    const event = pending.find((e) => e.id === id);
    assert.ok(event);
    assert.equal(event.attempts, 1);
    assert.equal(event.lastError, "transient: rate limit");
    assert.equal(event.leaseOwner, undefined);
  });

  test("failSynthesisEvent terminally moves inflight → failed", () => {
    const id = eventIdFor(SESSION, FILE_B);
    // Re-claim (the previous requeue made it pending again).
    claimPendingEvent(repoRoot, id, { leaseOwner: "worker-1" });
    failSynthesisEvent(repoRoot, id, "max attempts exhausted");

    const failedPath = path.join(repoRoot, ".kodela/synthesis-queue/failed", `${id}.json`);
    assert.ok(fs.existsSync(failedPath));
  });

  test("rescueExpiredLeases moves inflight → pending when leaseUntil has passed", () => {
    const sessionId = "rescue-session";
    const filePath = "src/rescue.ts";
    const id = eventIdFor(sessionId, filePath);
    enqueueSynthesisEvent(repoRoot, { sessionId, filePath });
    claimPendingEvent(repoRoot, id, { leaseOwner: "worker-stuck", leaseSeconds: 1 });

    // Simulate clock advance past leaseUntil.
    const now = Date.now() + 5_000;
    const rescued = rescueExpiredLeases(repoRoot, now);
    assert.ok(rescued.includes(id), "expired event must be rescued");

    const pending = listPendingEvents(repoRoot);
    assert.ok(pending.some((e) => e.id === id), "rescued event must reappear in pending");
  });
});
