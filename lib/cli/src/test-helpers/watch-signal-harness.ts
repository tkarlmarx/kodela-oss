// SPDX-License-Identifier: AGPL-3.0-only
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

process.stdout.write("harness:ready\n");
