// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

/**
 * Regression test: Commander's `--no-watcher` option must NOT have an explicit
 * default value passed.  Commander treats `--no-X` flags specially — the option
 * name becomes `X`, defaults to `true`, and `--no-X` flips it to `false`.
 * Passing a third-arg default (e.g. `false`) overrides this and breaks the
 * "no flag = true / --no-watcher = false" semantics, which would force
 * watcher-fallback OFF for every invocation.
 */
describe("setup --no-watcher commander wiring", () => {
  function makeProgram(): Command {
    const program = new Command();
    program
      .command("setup")
      .option("--yes", "non-interactive", false)
      // MUST mirror bin.ts exactly — no third-arg default.
      .option("--no-watcher", "Skip the watcher fallback")
      .option("--force", "force", false)
      .option("--print-only", "dry-run", false)
      .action(() => undefined);
    return program;
  }

  test("opts.watcher defaults to true when --no-watcher is NOT passed", async () => {
    let captured: { watcher?: boolean } = {};
    const program = new Command();
    program
      .command("setup")
      .option("--yes", "non-interactive", false)
      .option("--no-watcher", "Skip the watcher fallback")
      .action((opts: { watcher: boolean }) => {
        captured = opts;
      });
    await program.parseAsync(["node", "test", "setup"]);
    assert.equal(
      captured.watcher,
      true,
      "without --no-watcher, opts.watcher should be true (Commander default)",
    );
  });

  test("opts.watcher becomes false when --no-watcher IS passed", async () => {
    let captured: { watcher?: boolean } = {};
    const program = new Command();
    program
      .command("setup")
      .option("--yes", "non-interactive", false)
      .option("--no-watcher", "Skip the watcher fallback")
      .action((opts: { watcher: boolean }) => {
        captured = opts;
      });
    await program.parseAsync(["node", "test", "setup", "--no-watcher"]);
    assert.equal(
      captured.watcher,
      false,
      "with --no-watcher, opts.watcher should be false",
    );
  });

  test("derived noWatcher (=== false) is correct in both cases", async () => {
    let withFlag: { watcher?: boolean } = {};
    let withoutFlag: { watcher?: boolean } = {};
    const program1 = makeProgram();
    program1
      .commands[0]!.action((opts: { watcher: boolean }) => {
        withoutFlag = opts;
      });
    await program1.parseAsync(["node", "test", "setup"]);

    const program2 = makeProgram();
    program2
      .commands[0]!.action((opts: { watcher: boolean }) => {
        withFlag = opts;
      });
    await program2.parseAsync(["node", "test", "setup", "--no-watcher"]);

    // bin.ts derives noWatcher this way:
    assert.equal(withoutFlag.watcher === false, false, "default → noWatcher=false");
    assert.equal(withFlag.watcher === false, true, "--no-watcher → noWatcher=true");
  });
});
