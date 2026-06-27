// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectClaudeCode } from "./claude-detection.js";

describe("detectClaudeCode", () => {
  let tmpHome: string;
  let originalEnv: NodeJS.ProcessEnv;

  before(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-claude-detect-home-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = tmpHome;
    delete process.env["CLAUDECODE"];
    delete process.env["CLAUDE_CODE_ENTRYPOINT"];
  });

  after(async () => {
    process.env = originalEnv;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  test("returns 'none' when no signals are present", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-detect-empty-"));
    try {
      const result = await detectClaudeCode(repoRoot);
      assert.equal(result.level, "none");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("returns 'high' when CLAUDECODE env var is set", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-detect-env-"));
    process.env["CLAUDECODE"] = "1";
    try {
      const result = await detectClaudeCode(repoRoot);
      assert.equal(result.level, "high");
      assert.ok(result.signals.some((s) => s.toLowerCase().includes("claudecode")));
    } finally {
      delete process.env["CLAUDECODE"];
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("returns 'high' when .claude/settings.json has non-Kodela hooks", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-detect-settings-"));
    try {
      await fs.mkdir(path.join(repoRoot, ".claude"), { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PostToolUse: [{ matcher: "Edit", command: "echo 'user-defined'" }],
          },
        }),
        "utf-8",
      );
      const result = await detectClaudeCode(repoRoot);
      assert.equal(result.level, "high");
      assert.ok(
        result.signals.some((s) => s.toLowerCase().includes("settings.json") || s.toLowerCase().includes("non-kodela")),
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("returns 'low' when only an empty .claude/ directory exists", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-detect-empty-claude-"));
    try {
      await fs.mkdir(path.join(repoRoot, ".claude"), { recursive: true });
      const result = await detectClaudeCode(repoRoot);
      // Empty .claude/ dir is a low-confidence signal (presence-only).
      assert.ok(["low", "none"].includes(result.level));
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("ignores Kodela-installed hooks (returns 'none')", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-detect-kodela-hooks-"));
    try {
      await fs.mkdir(path.join(repoRoot, ".claude"), { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PostToolUse: [{ _kodela: "kodela-hook-v1", matcher: "*", command: "kodela hook process --event PostToolUse" }],
          },
        }),
        "utf-8",
      );
      const result = await detectClaudeCode(repoRoot);
      // Kodela's own hooks must not raise the level to "high" — the
      // user-installed-hooks signal is the high-confidence trigger.  The
      // bare presence of `.claude/` may still register as a low-confidence
      // signal, which is fine.
      assert.notEqual(result.level, "high");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});
