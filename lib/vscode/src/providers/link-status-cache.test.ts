// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LinkStatusCache } from "./link-status-cache.js";
import type { HeadFn } from "./link-status-cache.js";

/** Drain the micro-task / timer queue so background `_check` calls complete. */
async function drain(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("LinkStatusCache", () => {
  test("returns 'unknown' for a URL that has never been checked", () => {
    const cache = new LinkStatusCache();
    assert.equal(cache.get("https://example.com/"), "unknown");
  });

  test("startCheck then get returns 'live' after a 200 response", async () => {
    const head: HeadFn = async () => 200;
    const cache = new LinkStatusCache(head);

    cache.startCheck("https://example.com/live");
    await drain();

    assert.equal(cache.get("https://example.com/live"), "live");
  });

  test("startCheck then get returns 'live' for 301 redirect", async () => {
    const head: HeadFn = async () => 301;
    const cache = new LinkStatusCache(head);

    cache.startCheck("https://example.com/redirect");
    await drain();

    assert.equal(cache.get("https://example.com/redirect"), "live");
  });

  test("startCheck then get returns 'dead' after a 404 response", async () => {
    const head: HeadFn = async () => 404;
    const cache = new LinkStatusCache(head);

    cache.startCheck("https://example.com/missing");
    await drain();

    assert.equal(cache.get("https://example.com/missing"), "dead");
  });

  test("startCheck then get returns 'dead' after a 500 server error", async () => {
    const head: HeadFn = async () => 500;
    const cache = new LinkStatusCache(head);

    cache.startCheck("https://example.com/error");
    await drain();

    assert.equal(cache.get("https://example.com/error"), "dead");
  });

  test("startCheck then get returns 'dead' when headFn throws (network error)", async () => {
    const head: HeadFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    const cache = new LinkStatusCache(head);

    cache.startCheck("https://example.com/offline");
    await drain();

    assert.equal(cache.get("https://example.com/offline"), "dead");
  });

  test("multiple startCheck calls for the same URL fire headFn only once", async () => {
    let callCount = 0;
    const head: HeadFn = async () => {
      callCount++;
      return 200;
    };
    const cache = new LinkStatusCache(head);

    cache.startCheck("https://example.com/dedup");
    cache.startCheck("https://example.com/dedup");
    cache.startCheck("https://example.com/dedup");
    await drain();

    assert.equal(callCount, 1, "headFn should only be called once");
    assert.equal(cache.get("https://example.com/dedup"), "live");
  });

  test("startCheck is a no-op when a fresh cached result exists", async () => {
    let callCount = 0;
    const head: HeadFn = async () => {
      callCount++;
      return 200;
    };
    const cache = new LinkStatusCache(head);

    cache.startCheck("https://example.com/cached");
    await drain();
    assert.equal(callCount, 1);

    // Second call — cache is still fresh, so headFn must not be called again.
    cache.startCheck("https://example.com/cached");
    await drain();
    assert.equal(callCount, 1, "no second HEAD request while cache is fresh");
  });

  test("expired 'live' entry is evicted and returns 'unknown'", () => {
    const cache = new LinkStatusCache();
    // Manually seed an already-expired entry.
    (cache as unknown as { _cache: Map<string, unknown> })._cache.set(
      "https://example.com/expired",
      { status: "live", expiresAt: Date.now() - 1 },
    );
    assert.equal(cache.get("https://example.com/expired"), "unknown");
  });

  test("expired 'dead' entry is evicted and returns 'unknown'", () => {
    const cache = new LinkStatusCache();
    (cache as unknown as { _cache: Map<string, unknown> })._cache.set(
      "https://example.com/expired-dead",
      { status: "dead", expiresAt: Date.now() - 1 },
    );
    assert.equal(cache.get("https://example.com/expired-dead"), "unknown");
  });

  test("dispose clears the cache", async () => {
    const head: HeadFn = async () => 200;
    const cache = new LinkStatusCache(head);

    cache.startCheck("https://example.com/before-dispose");
    await drain();
    assert.equal(cache.get("https://example.com/before-dispose"), "live");

    cache.dispose();
    assert.equal(cache.get("https://example.com/before-dispose"), "unknown");
  });

  test("dispose clears in-flight tracking so a re-check can fire after dispose", async () => {
    let callCount = 0;
    const head: HeadFn = async () => {
      callCount++;
      return 404;
    };
    const cache = new LinkStatusCache(head);

    cache.startCheck("https://example.com/reflight");
    await drain();
    assert.equal(callCount, 1);

    cache.dispose();

    // After dispose the in-flight set is cleared; startCheck must be able to
    // fire a fresh request (even for the same URL).
    cache.startCheck("https://example.com/reflight");
    await drain();
    assert.equal(callCount, 2);
  });
});
