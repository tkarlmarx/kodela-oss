// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 4 — P4.1 frictionless install. Guards the repo-root `install.sh` so a
 * careless edit can't ship a broken one-line installer (users pipe it to sh).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const INSTALL = path.join(REPO_ROOT, "install.sh");

describe("install.sh (P4.1)", () => {
  const src = fs.readFileSync(INSTALL, "utf8");

  test("is POSIX sh with strict mode", () => {
    assert.ok(src.startsWith("#!/bin/sh"), "POSIX sh shebang");
    assert.match(src, /set -eu/, "strict mode");
  });

  test("wraps the published @kodela/cli via npx and supports setup + connect", () => {
    assert.match(src, /npx -y "\$\{PKG\}"/, "runs via npx");
    assert.match(src, /@kodela\/cli/);
    assert.match(src, /setup --yes/);
    assert.match(src, /connect --apply --npx/);
  });

  test("checks the Node version before running", () => {
    assert.match(src, /MIN_NODE_MAJOR/);
    assert.match(src, /have node/, "probes for node on PATH");
    assert.match(src, /NODE_MAJOR/, "compares the major version");
  });

  test("passes `sh -n` syntax validation", () => {
    // Throws (failing the test) if the script has a syntax error.
    execFileSync("sh", ["-n", INSTALL]);
  });
});
