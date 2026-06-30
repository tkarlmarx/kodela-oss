// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runAdd } from "./add.js";
import { runInit } from "./init.js";
import { readContextEntry } from "@kodela/core";

describe("runAdd", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-add-test-"));
    await fs.writeFile(
      path.join(tmpDir, "hello.ts"),
      "export function hello() {\n  return 'hello';\n}\n",
    );
    await runInit(tmpDir);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("creates a context entry with the correct fields", async () => {
    const { entry } = await runAdd({
      repoRoot: tmpDir,
      filePath: "hello.ts",
      lineStart: 1,
      lineEnd: 3,
      note: "Main hello function",
      severity: "low",
      source: "human",
    });

    assert.equal(entry.filePath, "hello.ts");
    assert.equal(entry.lineRange.start, 1);
    assert.equal(entry.lineRange.end, 3);
    assert.equal(entry.note, "Main hello function");
    assert.equal(entry.severity, "low");
    assert.equal(entry.source, "human");
    assert.equal(entry.status, "mapped");
    assert.equal(entry.confidence, 1.0);
    assert.equal(entry.reviewRequired, false);
    assert.match(entry.id, /^[0-9a-f-]{36}$/);
  });

  test("entry is persisted and readable after add", async () => {
    const { entry } = await runAdd({
      repoRoot: tmpDir,
      filePath: "hello.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Persisted note",
      severity: "low",
      source: "human",
    });
    const stored = await readContextEntry(tmpDir, entry.id);
    assert.equal(stored.id, entry.id);
    assert.equal(stored.note, "Persisted note");
  });

  test("sets reviewRequired: true for ai source", async () => {
    const { entry } = await runAdd({
      repoRoot: tmpDir,
      filePath: "hello.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "AI generated",
      source: "ai",
    });
    assert.equal(entry.reviewRequired, true);
    assert.equal(entry.source, "ai");
  });

  test("throws when lineStart is missing", async () => {
    await assert.rejects(
      () =>
        runAdd({
          repoRoot: tmpDir,
          filePath: "hello.ts",
          note: "Missing start",
        }),
      /lineStart is required/,
    );
  });

  test("security-sensitive path forces reviewRequired and adds tag", async () => {
    const { entry, securityFlagged } = await runAdd({
      repoRoot: tmpDir,
      filePath: "auth/session.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "AI session logic",
      source: "ai",
      sensitivePaths: ["auth/", "payments/"],
    });
    assert.equal(securityFlagged, true);
    assert.equal(entry.reviewRequired, true);
    assert.ok(entry.tags.includes("security-sensitive"));
  });

  test("non-sensitive AI path does not add security-sensitive tag", async () => {
    const { entry, securityFlagged } = await runAdd({
      repoRoot: tmpDir,
      filePath: "hello.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "AI generated utility",
      source: "ai",
      sensitivePaths: ["auth/", "payments/"],
    });
    assert.equal(securityFlagged, false);
    assert.equal(entry.reviewRequired, true);
    assert.ok(!entry.tags.includes("security-sensitive"));
  });

  test("human source on sensitive path is flagged and severity elevated", async () => {
    const { entry, securityFlagged } = await runAdd({
      repoRoot: tmpDir,
      filePath: "auth/helper.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Hand-written auth helper",
      source: "human",
      sensitivePaths: ["auth/"],
    });
    assert.equal(securityFlagged, true);
    assert.equal(entry.reviewRequired, true);
    assert.ok(entry.tags.includes("security-sensitive"));
    assert.equal(entry.severity, "high");
  });

  test("throws when lineEnd < lineStart", async () => {
    await assert.rejects(
      () =>
        runAdd({
          repoRoot: tmpDir,
          filePath: "hello.ts",
          lineStart: 10,
          lineEnd: 5,
          note: "Bad range",
        }),
      /lineEnd must be/,
    );
  });
});

describe("runAdd — AI tool auto-attribution", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-add-aitool-"));
    await fs.writeFile(
      path.join(tmpDir, "hello.ts"),
      "export function hello() {\n  return 'hello';\n}\n",
    );
    await runInit(tmpDir);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("--ai-tool copilot auto-resolves canonical link", async () => {
    const { entry } = await runAdd({
      repoRoot: tmpDir,
      filePath: "hello.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Copilot-generated function",
      source: "ai",
      aiTool: "copilot",
    });
    assert.equal(entry.aiTool, "copilot");
    assert.equal(entry.link, "https://github.com/features/copilot");
  });

  test("--ai-tool claude auto-resolves canonical link", async () => {
    const { entry } = await runAdd({
      repoRoot: tmpDir,
      filePath: "hello.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Claude-generated function",
      source: "ai",
      aiTool: "claude",
    });
    assert.equal(entry.aiTool, "claude");
    assert.equal(entry.link, "https://claude.ai");
  });

  test("--ai-tool with explicit --link uses the provided link, not the canonical one", async () => {
    const { entry } = await runAdd({
      repoRoot: tmpDir,
      filePath: "hello.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Custom session link",
      source: "ai",
      aiTool: "copilot",
      link: "https://github.com/copilot/session/abc123",
    });
    assert.equal(entry.aiTool, "copilot");
    assert.equal(entry.link, "https://github.com/copilot/session/abc123");
  });

  test("--ai-tool with unknown name stores tool name and empty link", async () => {
    const { entry } = await runAdd({
      repoRoot: tmpDir,
      filePath: "hello.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Internal LLM annotation",
      source: "ai",
      aiTool: "my-internal-llm",
    });
    assert.equal(entry.aiTool, "my-internal-llm");
    assert.equal(entry.link, undefined);
  });

  test("--ai-tool unknown name + explicit --link stores both", async () => {
    const { entry } = await runAdd({
      repoRoot: tmpDir,
      filePath: "hello.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Internal LLM with explicit link",
      source: "ai",
      aiTool: "my-internal-llm",
      link: "https://internal.tool",
    });
    assert.equal(entry.aiTool, "my-internal-llm");
    assert.equal(entry.link, "https://internal.tool");
  });

  test("Cursor IDE auto-detected via CURSOR_TRACE_ID env var when no --ai-tool", async () => {
    const prev = process.env["CURSOR_TRACE_ID"];
    process.env["CURSOR_TRACE_ID"] = "trace-abc-123";
    try {
      const { entry } = await runAdd({
        repoRoot: tmpDir,
        filePath: "hello.ts",
        lineStart: 1,
        lineEnd: 1,
        note: "Auto-detected Cursor annotation",
        source: "ai",
      });
      assert.equal(entry.aiTool, "cursor");
      assert.equal(entry.link, "https://cursor.sh");
    } finally {
      if (prev === undefined) {
        delete process.env["CURSOR_TRACE_ID"];
      } else {
        process.env["CURSOR_TRACE_ID"] = prev;
      }
    }
  });

  test("Cursor IDE auto-detected via CURSOR_SESSION_ID env var when no --ai-tool", async () => {
    const prevTrace = process.env["CURSOR_TRACE_ID"];
    const prevSession = process.env["CURSOR_SESSION_ID"];
    delete process.env["CURSOR_TRACE_ID"];
    process.env["CURSOR_SESSION_ID"] = "session-xyz";
    try {
      const { entry } = await runAdd({
        repoRoot: tmpDir,
        filePath: "hello.ts",
        lineStart: 1,
        lineEnd: 1,
        note: "Auto-detected Cursor via session id",
        source: "ai",
      });
      assert.equal(entry.aiTool, "cursor");
      assert.equal(entry.link, "https://cursor.sh");
    } finally {
      if (prevTrace === undefined) {
        delete process.env["CURSOR_TRACE_ID"];
      } else {
        process.env["CURSOR_TRACE_ID"] = prevTrace;
      }
      if (prevSession === undefined) {
        delete process.env["CURSOR_SESSION_ID"];
      } else {
        process.env["CURSOR_SESSION_ID"] = prevSession;
      }
    }
  });

  test("Cursor env vars do not override explicit --ai-tool", async () => {
    const prev = process.env["CURSOR_TRACE_ID"];
    process.env["CURSOR_TRACE_ID"] = "trace-abc-123";
    try {
      const { entry } = await runAdd({
        repoRoot: tmpDir,
        filePath: "hello.ts",
        lineStart: 1,
        lineEnd: 1,
        note: "Explicit tool wins over Cursor env",
        source: "ai",
        aiTool: "claude",
      });
      assert.equal(entry.aiTool, "claude");
      assert.equal(entry.link, "https://claude.ai");
    } finally {
      if (prev === undefined) {
        delete process.env["CURSOR_TRACE_ID"];
      } else {
        process.env["CURSOR_TRACE_ID"] = prev;
      }
    }
  });

  test("no AI tool set and no Cursor env — aiTool and link are both absent", async () => {
    const prevTrace = process.env["CURSOR_TRACE_ID"];
    const prevSession = process.env["CURSOR_SESSION_ID"];
    delete process.env["CURSOR_TRACE_ID"];
    delete process.env["CURSOR_SESSION_ID"];
    try {
      const { entry } = await runAdd({
        repoRoot: tmpDir,
        filePath: "hello.ts",
        lineStart: 1,
        lineEnd: 1,
        note: "No tool attribution",
        source: "human",
      });
      assert.equal(entry.aiTool, undefined);
      assert.equal(entry.link, undefined);
    } finally {
      if (prevTrace !== undefined) process.env["CURSOR_TRACE_ID"] = prevTrace;
      if (prevSession !== undefined) process.env["CURSOR_SESSION_ID"] = prevSession;
    }
  });

  test("source: human + Cursor env — aiTool is still set (env heuristic applies regardless of source)", async () => {
    const prev = process.env["CURSOR_TRACE_ID"];
    process.env["CURSOR_TRACE_ID"] = "trace-human-test";
    try {
      const { entry } = await runAdd({
        repoRoot: tmpDir,
        filePath: "hello.ts",
        lineStart: 1,
        lineEnd: 1,
        note: "Human note written inside Cursor IDE",
        source: "human",
      });
      assert.equal(entry.aiTool, "cursor");
      assert.equal(entry.link, "https://cursor.sh");
      assert.equal(entry.source, "human");
    } finally {
      if (prev === undefined) {
        delete process.env["CURSOR_TRACE_ID"];
      } else {
        process.env["CURSOR_TRACE_ID"] = prev;
      }
    }
  });
});
