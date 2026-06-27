// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { collectGap19Context, isArtifactUrl } from "./gap19-prompts.js";
import type { ShowInputBoxFn, ShowInfoFn } from "./gap19-prompts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a ShowInputBoxFn that yields responses in order (then undefined). */
function inputSeq(...responses: (string | undefined)[]): {
  fn: ShowInputBoxFn;
  calls: { prompt: string; placeHolder: string | undefined }[];
} {
  const calls: { prompt: string; placeHolder: string | undefined }[] = [];
  let i = 0;
  const fn: ShowInputBoxFn = async (opts) => {
    calls.push({ prompt: opts.prompt, placeHolder: opts.placeHolder });
    return responses[i++];
  };
  return { fn, calls };
}

/** No-op info banner. */
const noInfo: ShowInfoFn = () => {};

/** Collects info messages. */
function spyInfo(): { fn: ShowInfoFn; messages: string[] } {
  const messages: string[] = [];
  return { fn: (m) => messages.push(m), messages };
}

// ---------------------------------------------------------------------------
// isArtifactUrl
// ---------------------------------------------------------------------------

describe("isArtifactUrl", () => {
  test("matches claude.ai/artifact/ URLs", () => {
    assert.ok(isArtifactUrl("https://claude.ai/artifact/abc-123"));
  });

  test("matches claude.ai/canvas/ URLs", () => {
    assert.ok(isArtifactUrl("https://claude.ai/canvas/abc-123"));
  });

  test("matches chatgpt.com/canvas/ URLs", () => {
    assert.ok(isArtifactUrl("https://chatgpt.com/canvas/abc-123"));
  });

  test("matches chat.openai.com/canvas/ URLs", () => {
    assert.ok(isArtifactUrl("https://chat.openai.com/canvas/abc-123"));
  });

  test("does not match regular claude.ai/share/ URLs", () => {
    assert.ok(!isArtifactUrl("https://claude.ai/share/abc-123"));
  });

  test("does not match regular chatgpt.com/share/ URLs", () => {
    assert.ok(!isArtifactUrl("https://chatgpt.com/share/abc-123"));
  });

  test("does not match unrelated URLs", () => {
    assert.ok(!isArtifactUrl("https://github.com/user/repo"));
    assert.ok(!isArtifactUrl("https://cursor.com/session/abc"));
  });

  test("is case-insensitive", () => {
    assert.ok(isArtifactUrl("https://CLAUDE.AI/ARTIFACT/abc-123"));
  });
});

// ---------------------------------------------------------------------------
// 19a — Cursor Composer summary
// ---------------------------------------------------------------------------

describe("collectGap19Context — 19a: Cursor Composer summary", () => {
  test("shows composer prompt when aiTool is 'cursor'", async () => {
    const seq = inputSeq("session summary text", undefined);
    const result = await collectGap19Context("cursor", undefined, seq.fn, noInfo);
    assert.ok(
      seq.calls.length >= 1,
      "at least one prompt should have been shown for cursor",
    );
    assert.ok(
      seq.calls[0].prompt.toLowerCase().includes("cursor") ||
        seq.calls[0].prompt.toLowerCase().includes("composer"),
      `Expected cursor/composer in first prompt. Got: ${seq.calls[0].prompt}`,
    );
  });

  test("stores response as originSummary for cursor", async () => {
    const seq = inputSeq("Full session intent text", undefined, undefined);
    const result = await collectGap19Context("cursor", undefined, seq.fn, noInfo);
    assert.equal(result.originSummary, "Full session intent text");
  });

  test("does NOT show composer prompt for non-cursor tools", async () => {
    const seq = inputSeq(undefined);
    await collectGap19Context("copilot", undefined, seq.fn, noInfo);
    // The only prompts that could fire are 19b or 19c, not 19a
    const composerPrompt = seq.calls.find(
      (c) => c.prompt.toLowerCase().includes("composer"),
    );
    assert.ok(!composerPrompt, "no composer prompt for non-cursor tool");
  });

  test("does NOT show composer prompt when aiTool is undefined", async () => {
    const seq = inputSeq();
    await collectGap19Context(undefined, undefined, seq.fn, noInfo);
    assert.equal(seq.calls.length, 0, "no prompts for unknown tool");
  });

  test("skips originSummary when user gives empty string", async () => {
    const seq = inputSeq("", undefined, undefined);
    const result = await collectGap19Context("cursor", undefined, seq.fn, noInfo);
    assert.equal(result.originSummary, undefined, "empty string should not set originSummary");
  });

  test("skips originSummary when user presses Escape (undefined)", async () => {
    const seq = inputSeq(undefined, undefined, undefined);
    const result = await collectGap19Context("cursor", undefined, seq.fn, noInfo);
    assert.equal(result.originSummary, undefined);
  });
});

// ---------------------------------------------------------------------------
// 19b — Claude Artifact / ChatGPT Canvas convention
// ---------------------------------------------------------------------------

describe("collectGap19Context — 19b: Artifact URL convention", () => {
  const ARTIFACT_URL = "https://claude.ai/artifact/abc-123";
  const REGULAR_URL = "https://claude.ai/share/abc-123";

  test("shows info banner when an artifact URL is detected", async () => {
    const info = spyInfo();
    const seq = inputSeq(undefined);
    await collectGap19Context(undefined, ARTIFACT_URL, seq.fn, info.fn);
    assert.ok(info.messages.length > 0, "info banner should fire for artifact URL");
    assert.ok(
      info.messages[0].toLowerCase().includes("artifact"),
      `Expected 'artifact' in info message. Got: ${info.messages[0]}`,
    );
  });

  test("shows artifact summary prompt when URL is an artifact URL", async () => {
    const seq = inputSeq("claude artifact v7 · auth refactor");
    await collectGap19Context(undefined, ARTIFACT_URL, seq.fn, noInfo);
    assert.ok(seq.calls.length >= 1, "at least one prompt shown for artifact URL");
  });

  test("stores artifact summary as originSummary", async () => {
    const seq = inputSeq("claude artifact v7 · handle refresh rotation");
    const result = await collectGap19Context(undefined, ARTIFACT_URL, seq.fn, noInfo);
    assert.equal(result.originSummary, "claude artifact v7 · handle refresh rotation");
  });

  test("does NOT show artifact prompt for regular share URLs", async () => {
    const info = spyInfo();
    const seq = inputSeq();
    await collectGap19Context(undefined, REGULAR_URL, seq.fn, info.fn);
    assert.equal(info.messages.length, 0, "no info for non-artifact URL");
  });

  test("skips artifact prompt when 19a already set originSummary", async () => {
    // cursor → 19a fires first and sets originSummary; 19b should be skipped
    const info = spyInfo();
    const seq = inputSeq("cursor summary", undefined, undefined);
    const result = await collectGap19Context("cursor", ARTIFACT_URL, seq.fn, info.fn);
    assert.equal(info.messages.length, 0, "no artifact banner when 19a already set summary");
    assert.equal(result.originSummary, "cursor summary", "19a summary is preserved");
  });

  test("skips artifact prompt when link is undefined", async () => {
    const info = spyInfo();
    const seq = inputSeq();
    await collectGap19Context(undefined, undefined, seq.fn, info.fn);
    assert.equal(info.messages.length, 0, "no artifact banner when link is absent");
  });
});

// ---------------------------------------------------------------------------
// 19c — Shared team AI accounts: thread title
// ---------------------------------------------------------------------------

describe("collectGap19Context — 19c: thread / session title", () => {
  test("shows thread title prompt for 'claude'", async () => {
    const seq = inputSeq("Auth refactor sprint");
    const result = await collectGap19Context("claude", undefined, seq.fn, noInfo);
    assert.ok(
      seq.calls.some(
        (c) =>
          c.prompt.toLowerCase().includes("claude") &&
          (c.prompt.toLowerCase().includes("thread") || c.prompt.toLowerCase().includes("session")),
      ),
      `Expected claude/thread in prompt. Calls: ${JSON.stringify(seq.calls)}`,
    );
    assert.equal(result.threadTitle, "Auth refactor sprint");
  });

  test("shows thread title prompt for 'cursor'", async () => {
    const seq = inputSeq(undefined, "Session title for cursor");
    const result = await collectGap19Context("cursor", undefined, seq.fn, noInfo);
    assert.ok(
      seq.calls.some(
        (c) =>
          c.prompt.toLowerCase().includes("cursor") &&
          (c.prompt.toLowerCase().includes("thread") || c.prompt.toLowerCase().includes("session")),
      ),
      `Expected cursor/thread in prompt. Calls: ${JSON.stringify(seq.calls)}`,
    );
    assert.equal(result.threadTitle, "Session title for cursor");
  });

  test("does NOT show thread title prompt for other tools", async () => {
    for (const tool of ["copilot", "chatgpt", "codeium", undefined]) {
      const seq = inputSeq();
      const result = await collectGap19Context(tool, undefined, seq.fn, noInfo);
      const threadPrompt = seq.calls.find(
        (c) => c.prompt.toLowerCase().includes("thread") || c.prompt.toLowerCase().includes("session title"),
      );
      assert.ok(!threadPrompt, `no thread prompt expected for tool=${tool}`);
      assert.equal(result.threadTitle, undefined);
    }
  });

  test("threadTitle is undefined when user gives empty string", async () => {
    const seq = inputSeq("");
    const result = await collectGap19Context("claude", undefined, seq.fn, noInfo);
    assert.equal(result.threadTitle, undefined);
  });

  test("threadTitle is undefined when user presses Escape", async () => {
    const seq = inputSeq(undefined);
    const result = await collectGap19Context("claude", undefined, seq.fn, noInfo);
    assert.equal(result.threadTitle, undefined);
  });
});

// ---------------------------------------------------------------------------
// Combined scenarios
// ---------------------------------------------------------------------------

describe("collectGap19Context — combined scenarios", () => {
  test("cursor + artifact URL: 19a fires, 19b skipped, 19c fires", async () => {
    const ARTIFACT_URL = "https://claude.ai/artifact/xyz";
    const info = spyInfo();
    // 19a → composer summary; 19b → skipped (no prompt); 19c → thread title
    const seq = inputSeq("Composer session summary", "Session title");
    const result = await collectGap19Context("cursor", ARTIFACT_URL, seq.fn, info.fn);

    assert.equal(result.originSummary, "Composer session summary", "19a summary stored");
    assert.equal(result.threadTitle, "Session title", "19c thread title stored");
    assert.equal(info.messages.length, 0, "19b artifact banner suppressed because 19a set summary");
    // Only 2 input-box calls: 19a (composer) + 19c (thread title)
    assert.equal(seq.calls.length, 2, "exactly 2 prompts shown");
  });

  test("claude + no artifact URL: only 19c fires", async () => {
    const info = spyInfo();
    const seq = inputSeq("Auth refactor thread");
    const result = await collectGap19Context("claude", "https://claude.ai/share/abc", seq.fn, info.fn);

    assert.equal(result.originSummary, undefined, "no originSummary for claude without artifact URL");
    assert.equal(result.threadTitle, "Auth refactor thread");
    assert.equal(info.messages.length, 0, "no artifact banner for non-artifact URL");
    assert.equal(seq.calls.length, 1, "only thread-title prompt shown");
  });

  test("non-cursor, non-claude, artifact URL: only 19b fires", async () => {
    const ARTIFACT_URL = "https://chatgpt.com/canvas/abc-123";
    const info = spyInfo();
    const seq = inputSeq("gpt canvas v4 · auth refactor");
    const result = await collectGap19Context("chatgpt", ARTIFACT_URL, seq.fn, info.fn);

    assert.equal(result.originSummary, "gpt canvas v4 · auth refactor");
    assert.equal(result.threadTitle, undefined);
    assert.ok(info.messages.length > 0, "artifact banner shown");
  });

  test("returns empty context when no tool and no link", async () => {
    const seq = inputSeq();
    const result = await collectGap19Context(undefined, undefined, seq.fn, noInfo);
    assert.equal(result.originSummary, undefined);
    assert.equal(result.threadTitle, undefined);
    assert.equal(seq.calls.length, 0, "no prompts shown");
  });
});
