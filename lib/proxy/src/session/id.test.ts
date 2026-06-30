// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  generateSessionId,
  generateExchangeId,
  resolveSessionGroupId,
  type SessionGroupState,
} from "./id.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("session id generators", () => {
  test("generateSessionId returns a unique UUID", () => {
    const a = generateSessionId();
    const b = generateSessionId();
    assert.match(a, UUID_RE);
    assert.notEqual(a, b);
  });

  test("generateExchangeId returns a unique UUID", () => {
    assert.match(generateExchangeId(), UUID_RE);
    assert.notEqual(generateExchangeId(), generateExchangeId());
  });
});

describe("resolveSessionGroupId", () => {
  const baseState = (over: Partial<SessionGroupState> = {}): SessionGroupState => ({
    lastSessionId: "s1",
    lastSessionGroupId: "group-1",
    lastClosedAt: Date.now(),
    lastBranch: "main",
    ...over,
  });

  test("returns undefined when there is no prior state", () => {
    assert.equal(resolveSessionGroupId("main", null), undefined);
  });

  test("reuses the group id within the window on the same branch", () => {
    const state = baseState({ lastClosedAt: Date.now() - 60_000 });
    assert.equal(resolveSessionGroupId("main", state), "group-1");
  });

  test("starts a new group when the branch differs", () => {
    const state = baseState({ lastBranch: "feature/x", lastClosedAt: Date.now() - 1_000 });
    assert.equal(resolveSessionGroupId("main", state), undefined);
  });

  test("starts a new group once the 30-minute window has elapsed", () => {
    const state = baseState({ lastClosedAt: Date.now() - 31 * 60 * 1000 });
    assert.equal(resolveSessionGroupId("main", state), undefined);
  });

  test("still reuses the group just inside the 30-minute window", () => {
    const state = baseState({ lastClosedAt: Date.now() - (30 * 60 * 1000 - 2_000) });
    assert.equal(resolveSessionGroupId("main", state), "group-1");
  });
});
