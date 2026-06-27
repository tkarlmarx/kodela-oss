// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
export const ChangeType = {
  create: "create",
  modify: "modify",
  delete: "delete",
} as const;

export type ChangeType = (typeof ChangeType)[keyof typeof ChangeType];

export type ChangeEvent = {
  filePath: string;
  changeType: ChangeType;
  timestamp: number;
  /**
   * Byte size change for this file within the debounce window.
   *
   * For `create` events the baseline is 0 (file did not exist).
   * For `modify` events where the file existed before the watcher started,
   * the baseline is the size at the time of the first observed stat — the
   * delta therefore reflects changes seen since watching began, not the full
   * history. Omitted only when no stat could be obtained (e.g. rapid delete).
   */
  sizeDelta?: number;
  /** Number of raw filesystem events collapsed into this ChangeEvent. */
  eventCount?: number;
  /**
   * Set when the watcher heuristically detects a rename: an `unlink` event
   * occurred close in time (within `Math.min(100ms, debounceMs)`) before this
   * `add`. Contains the path of the file that was unlinked.
   */
  renameFrom?: string;
};

export type BatchedEvent = {
  events: ChangeEvent[];
};

export type WatcherOptions = {
  rootDir: string;
  debounceMs?: number;
  /**
   * Maximum time in milliseconds to wait before flushing a batch, even if
   * file-change events keep arriving continuously.  Prevents the debounce
   * window from being pushed out indefinitely during large code-generation runs.
   *
   * The flush fires at `maxWaitMs` after the **first** event in the current
   * batch, regardless of how many subsequent events arrive before that deadline.
   *
   * Default: `2000` ms.  Set to `0` to disable.
   */
  maxWaitMs?: number;
  maxBatchSize?: number;
  ignored?: ReadonlyArray<string | RegExp | ((path: string) => boolean)>;
};

export type BatchCallback = (batch: BatchedEvent) => void;

/** Called once after the watcher finishes its initial filesystem scan. */
export type ReadyCallback = () => void;

export type Watcher = {
  /**
   * Register a listener for the "batch" event. Multiple listeners are
   * supported; each is called in registration order once per debounce window
   * with all coalesced file-change events.
   *
   * @param event - "batch"
   * @param callback - Called with the batched events.
   */
  on(event: "batch", callback: BatchCallback): void;

  /**
   * Register a listener for the "ready" event, fired once after the watcher
   * finishes its initial filesystem scan. Multiple listeners are supported and
   * are called in registration order.
   *
   * If `on("ready", cb)` is called after the watcher has already become ready,
   * `cb` is invoked synchronously before `on` returns. This makes it safe to
   * register a ready listener at any point without worrying about a race.
   *
   * @param event - "ready"
   * @param callback - Called with no arguments when the watcher is ready.
   */
  on(event: "ready", callback: ReadyCallback): void;

  /**
   * Stop the watcher, close the underlying filesystem monitor, clear any
   * pending debounce timer, and release internal state. Safe to call multiple
   * times (idempotent).
   */
  stop(): void;
};
