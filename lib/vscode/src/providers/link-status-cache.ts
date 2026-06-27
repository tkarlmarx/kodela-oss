// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 18 — Link rot detection
 *
 * Non-blocking background HEAD checks for `entry.link` URLs.
 * Results are cached with separate TTLs for live and dead links so the hover
 * provider can show a "⚠ Link may be dead" badge without ever blocking the UI.
 */

/** Cached liveness status for a single URL. */
export type LinkStatus = "live" | "dead" | "unknown";

/**
 * Injectable HEAD-check function.  The default implementation uses `fetch`
 * with an `AbortController` timeout; the test-injectable version lets unit
 * tests exercise cache logic without real network I/O.
 *
 * @param url       The URL to HEAD-check.
 * @param timeoutMs Abort the request after this many milliseconds.
 * @returns         The HTTP status code (e.g. 200, 404).
 * @throws          On network failure or timeout.
 */
export type HeadFn = (url: string, timeoutMs: number) => Promise<number>;

const HEAD_TIMEOUT_MS = 500;
const LIVE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEAD_TTL_MS = 5 * 60 * 1000;  // 5 minutes

interface CacheEntry {
  status: "live" | "dead";
  expiresAt: number;
}

/** Performs a real HEAD request using the global `fetch` API (Node 18+ / VS Code 1.80+). */
async function defaultHeadFn(url: string, timeoutMs: number): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Thread-safe (single-threaded JS) URL liveness cache.
 *
 * - `get(url)` returns the cached status synchronously (never awaits).
 * - `startCheck(url)` fires a background HEAD request if no fresh result
 *   is cached and no check is already in-flight for that URL.
 * - Subsequent calls to `get()` after the check completes return the
 *   updated status so the _next_ hover render shows the correct badge.
 */
export class LinkStatusCache {
  private readonly _cache = new Map<string, CacheEntry>();
  private readonly _inFlight = new Set<string>();
  private readonly _headFn: HeadFn;

  constructor(headFn?: HeadFn) {
    this._headFn = headFn ?? defaultHeadFn;
  }

  /**
   * Returns the cached liveness status for `url`.
   * Returns `"unknown"` if the URL has not been checked yet or its entry
   * has expired.
   */
  get(url: string): LinkStatus {
    const entry = this._cache.get(url);
    if (!entry) return "unknown";
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(url);
      return "unknown";
    }
    return entry.status;
  }

  /**
   * Fires a non-blocking HEAD check for `url` unless:
   * - a fresh result is already cached, or
   * - a check for this URL is already in-flight.
   *
   * The check result is written to the cache when it completes; the caller
   * does not need to await anything.
   */
  startCheck(url: string): void {
    if (this._inFlight.has(url)) return;
    if (this.get(url) !== "unknown") return;
    this._inFlight.add(url);
    this._check(url).finally(() => {
      this._inFlight.delete(url);
    });
  }

  /** Clears all cached state and aborts in-flight tracking. */
  dispose(): void {
    this._cache.clear();
    this._inFlight.clear();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async _check(url: string): Promise<void> {
    try {
      const statusCode = await this._headFn(url, HEAD_TIMEOUT_MS);
      const isLive = statusCode >= 200 && statusCode < 400;
      this._cache.set(url, {
        status: isLive ? "live" : "dead",
        expiresAt: Date.now() + (isLive ? LIVE_TTL_MS : DEAD_TTL_MS),
      });
    } catch {
      // Network error or timeout — mark as dead with short TTL so a later
      // check (e.g. after the user reconnects) can retry.
      this._cache.set(url, {
        status: "dead",
        expiresAt: Date.now() + DEAD_TTL_MS,
      });
    }
  }
}
