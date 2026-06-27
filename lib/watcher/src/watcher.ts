// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import { watch } from "chokidar";
import { coalesceChangeType } from "./coalescer.js";
import type { RawEventType } from "./coalescer.js";
import type {
  BatchCallback,
  BatchedEvent,
  ChangeEvent,
  ChangeType as ChangeTypeValue,
  ReadyCallback,
  Watcher,
  WatcherOptions,
} from "./types.js";

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_MAX_WAIT_MS = 2000;
const DEFAULT_MAX_BATCH_SIZE = 500;
const RENAME_WINDOW_MS = 100;

/**
 * Directories chokidar must never descend into.  Each entry is matched both
 * as a directory name AND against all paths inside it so chokidar never opens
 * inotify watches on their contents (prevents ENOSPC on large workspaces).
 */
const IGNORED_DIRS = [
  "node_modules",
  ".git",
  ".kodela",
  ".local",
  "dist",
  "build",
  ".pnpm-store",
  ".cache",
  "coverage",
  "__pycache__",
] as const;

const DEFAULT_IGNORED: ReadonlyArray<string | RegExp | ((p: string) => boolean)> = [
  // Match both the directory itself and everything inside it.
  // Using a function ensures chokidar skips traversal at directory level,
  // which prevents ENOSPC on workspaces with many node_modules entries.
  (p: string) => {
    const parts = p.replace(/\\/g, "/").split("/");
    return IGNORED_DIRS.some((dir) => parts.includes(dir));
  },
];

type FileState = {
  changeType: ChangeTypeValue;
  timestamp: number;
  eventCount: number;
  knownSize: number | undefined;
  /**
   * Running byte-delta for this file within the debounce window.
   * Undefined until at least one successful stat enrichment completes, so
   * consumers can distinguish "no stat available" from a zero-byte change.
   */
  sizeDelta: number | undefined;
  renameFrom: string | undefined;
  /**
   * Monotonically increasing sequence number, incremented on every synchronous
   * event. The async stat enrichment path checks this before writing back to
   * prevent stale results from out-of-order Promise resolutions.
   */
  enrichSeq: number;
};

type RecentEvent = {
  filePath: string;
  timestamp: number;
};

function warn(message: string): void {
  process.stderr.write(`[kodela/watcher] WARN ${message}\n`);
}

export function startWatcher(options: WatcherOptions): Watcher {
  const {
    rootDir,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
    ignored = [],
  } = options;

  const mergedIgnored: Array<string | RegExp | ((p: string) => boolean)> = [
    ...DEFAULT_IGNORED,
    ...ignored,
  ];

  let stopped = false;
  let isReady = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  const batchListeners: BatchCallback[] = [];
  const readyListeners: ReadyCallback[] = [];

  const buffer = new Map<string, FileState>();

  const recentUnlinks: RecentEvent[] = [];
  const recentAdds: RecentEvent[] = [];

  function flush(): void {
    if (buffer.size === 0) return;

    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }

    if (maxWaitTimer !== undefined) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = undefined;
    }

    const events: ChangeEvent[] = [];

    for (const [filePath, state] of buffer) {
      const event: ChangeEvent = {
        filePath,
        changeType: state.changeType,
        timestamp: state.timestamp,
        eventCount: state.eventCount,
      };

      if (state.sizeDelta !== undefined) {
        event.sizeDelta = state.sizeDelta;
      }

      if (state.renameFrom !== undefined) {
        event.renameFrom = state.renameFrom;
      }

      events.push(event);
    }

    buffer.clear();

    if (batchListeners.length > 0 && events.length > 0) {
      const batch: BatchedEvent = { events };
      for (const listener of batchListeners) {
        listener(batch);
      }
    }
  }

  function scheduleFlush(): void {
    if (stopped) return;

    if (buffer.size > maxBatchSize) {
      warn(
        `Batch size exceeded ${String(maxBatchSize)} files — flushing early to prevent overload.`,
      );
      flush();
      return;
    }

    // Start the max-wait timer on the first event of each new batch.
    // Once started it is not reset by subsequent events — it fires at most
    // maxWaitMs after the batch began, guaranteeing a flush deadline.
    if (maxWaitTimer === undefined && maxWaitMs > 0) {
      maxWaitTimer = setTimeout(() => {
        maxWaitTimer = undefined;
        flush();
      }, maxWaitMs);
    }

    // Reset the debounce timer so it restarts from now on every new event.
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = undefined;
      flush();
    }, debounceMs);
  }

  function renameWindow(): number {
    return Math.min(RENAME_WINDOW_MS, debounceMs);
  }

  function pruneList(list: RecentEvent[], now: number): void {
    const cutoff = now - renameWindow() - debounceMs;
    let i = 0;
    while (i < list.length) {
      const entry = list[i];
      if (entry !== undefined && entry.timestamp < cutoff) {
        list.splice(i, 1);
      } else {
        i++;
      }
    }
  }

  function findAndConsumeNearest(
    list: RecentEvent[],
    now: number,
    excludeFilePath: string,
  ): string | undefined {
    const cutoff = now - renameWindow();
    let bestIdx = -1;
    let bestTimestamp = -1;

    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (
        entry !== undefined &&
        entry.filePath !== excludeFilePath &&
        entry.timestamp >= cutoff
      ) {
        if (entry.timestamp > bestTimestamp) {
          bestTimestamp = entry.timestamp;
          bestIdx = i;
        }
      }
    }

    if (bestIdx === -1) return undefined;
    const candidate = list[bestIdx];
    list.splice(bestIdx, 1);
    return candidate?.filePath;
  }

  function handleEventSync(rawType: RawEventType, filePath: string): number {
    if (stopped) return 0;

    const now = Date.now();
    const existing = buffer.get(filePath);

    const newChangeType = coalesceChangeType(existing?.changeType, rawType);
    const eventCount = (existing?.eventCount ?? 0) + 1;
    let effectiveKnownSize = existing?.knownSize;
    const currentSizeDelta = existing?.sizeDelta;
    const nextSeq = (existing?.enrichSeq ?? 0) + 1;
    let resolvedRenameFrom = existing?.renameFrom;

    if (rawType === "unlink") {
      pruneList(recentUnlinks, now);
      pruneList(recentAdds, now);

      const addCandidate = findAndConsumeNearest(recentAdds, now, filePath);
      if (addCandidate !== undefined) {
        const addState = buffer.get(addCandidate);
        if (addState !== undefined) {
          buffer.set(addCandidate, {
            ...addState,
            renameFrom: filePath,
          });
        }
      }

      recentUnlinks.push({ filePath, timestamp: now });
    }

    if (rawType === "add") {
      pruneList(recentUnlinks, now);
      pruneList(recentAdds, now);

      const unlinkCandidate = findAndConsumeNearest(
        recentUnlinks,
        now,
        filePath,
      );
      if (unlinkCandidate !== undefined) {
        resolvedRenameFrom = unlinkCandidate;
      }

      if (existing?.changeType === "delete") {
        effectiveKnownSize = 0;
      }

      recentAdds.push({ filePath, timestamp: now });
    }

    let newSizeDelta = currentSizeDelta;
    if (rawType === "unlink" && effectiveKnownSize !== undefined) {
      newSizeDelta = (currentSizeDelta ?? 0) - effectiveKnownSize;
    }

    buffer.set(filePath, {
      changeType: newChangeType,
      timestamp: now,
      eventCount,
      knownSize: effectiveKnownSize,
      sizeDelta: newSizeDelta,
      renameFrom: resolvedRenameFrom,
      enrichSeq: nextSeq,
    });

    scheduleFlush();
    return nextSeq;
  }

  async function enrichWithSize(
    filePath: string,
    expectedSeq: number,
  ): Promise<void> {
    if (stopped) return;

    try {
      const stat = await fs.stat(filePath);
      if (stopped) return;

      const existing = buffer.get(filePath);
      if (existing === undefined || existing.enrichSeq !== expectedSeq) {
        return;
      }

      const newSize = stat.size;

      if (existing.changeType === "create" && existing.knownSize === undefined) {
        const sizeDeltaBase = existing.sizeDelta ?? 0;
        buffer.set(filePath, {
          ...existing,
          knownSize: newSize,
          sizeDelta: sizeDeltaBase + newSize,
        });
      } else if (existing.knownSize !== undefined) {
        const sizeDeltaBase = existing.sizeDelta ?? 0;
        buffer.set(filePath, {
          ...existing,
          knownSize: newSize,
          sizeDelta: sizeDeltaBase + (newSize - existing.knownSize),
        });
      } else {
        buffer.set(filePath, {
          ...existing,
          knownSize: newSize,
        });
      }
    } catch {
    }
  }

  const chokidarWatcher = watch(rootDir, {
    ignored: mergedIgnored,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: false,
  });

  chokidarWatcher.on("add", (filePath: string) => {
    const seq = handleEventSync("add", filePath);
    void enrichWithSize(filePath, seq);
  });

  chokidarWatcher.on("change", (filePath: string) => {
    const seq = handleEventSync("change", filePath);
    void enrichWithSize(filePath, seq);
  });

  chokidarWatcher.on("unlink", (filePath: string) => {
    handleEventSync("unlink", filePath);
  });

  chokidarWatcher.on("ready", () => {
    if (stopped) return;
    isReady = true;
    for (const cb of readyListeners) {
      cb();
    }
    readyListeners.length = 0;
  });

  const watcher: Watcher = {
    on(event: "batch" | "ready", callback: BatchCallback | ReadyCallback): void {
      if (event === "batch") {
        batchListeners.push(callback as BatchCallback);
      } else if (event === "ready") {
        if (isReady) {
          (callback as ReadyCallback)();
        } else {
          readyListeners.push(callback as ReadyCallback);
        }
      }
    },

    stop(): void {
      if (stopped) return;
      stopped = true;

      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }

      if (maxWaitTimer !== undefined) {
        clearTimeout(maxWaitTimer);
        maxWaitTimer = undefined;
      }

      buffer.clear();
      recentUnlinks.length = 0;
      recentAdds.length = 0;
      readyListeners.length = 0;

      void chokidarWatcher.close();
    },
  };

  return watcher;
}
