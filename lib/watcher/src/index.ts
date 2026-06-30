// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export { startWatcher } from "./watcher.js";
export { ChangeType } from "./types.js";
export type {
  BatchCallback,
  BatchedEvent,
  ChangeEvent,
  ReadyCallback,
  Watcher,
  WatcherOptions,
} from "./types.js";
export { coalesceChangeType } from "./coalescer.js";
export type { RawEventType } from "./coalescer.js";
