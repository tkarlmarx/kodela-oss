// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import process from "node:process";
import { runWatch } from "../commands/watch.js";
import type { Watcher, WatcherOptions } from "@kodela/watcher";

const stubFactory = (_opts: WatcherOptions): Watcher => ({
  on(_event: "batch" | "ready", _cb: unknown) {},
  stop() {},
});

const stubHeal = async () => ({
  total: 0,
  healed: 0,
  unchanged: 0,
  failed: 0,
  entries: [],
  dryRun: false,
});

const watcher = await runWatch(
  { repoRoot: process.cwd(), watcherFactory: stubFactory, healFn: stubHeal as any },
);

const shutdown = () => {
  watcher.stop();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Signal readiness on the next event-loop turn, not synchronously. Adding the
// first signal listener arms libuv's signal watcher, but the test sends SIGTERM
// the instant it reads "harness:ready"; emitting on a setImmediate guarantees
// the watcher is fully active before the parent can deliver the signal, so the
// handler runs (exit 0) instead of the process dying from the default action.
setImmediate(() => process.stdout.write("harness:ready\n"));
