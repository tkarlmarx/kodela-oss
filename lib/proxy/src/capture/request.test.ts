// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import {
  extractModel,
  extractPrompt,
  extractToolSignature,
  isStreaming,
} from "./request.js";

function fakeReq(headers: Record<string, string>, url = ""): IncomingMessage {
  return { headers, url } as unknown as IncomingMessage;
}

describe("extractModel", () => {
  test("returns the model string when present", () => {
    assert.equal(extractModel({ model: "gpt-4o" }), "gpt-4o");
  });

  test("returns empty string when model is missing or non-string", () => {
    assert.equal(extractModel({}), "");
    assert.equal(extractModel({ model: 123 }), "");
  });
});

describe("extractPrompt", () => {
  test("returns the last user message with string content", () => {
    const body = {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
    };
    assert.equal(extractPrompt(body), "second");
  });

  test("joins text blocks from array-style content", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image", url: "ignored" },
            { type: "text", text: "world" },
          ],
        },
      ],
    };
    assert.equal(extractPrompt(body), "hello world");
  });

  test("falls back to a top-level prompt field for completion-style bodies", () => {
    assert.equal(extractPrompt({ prompt: "legacy" }), "legacy");
  });

  test("returns empty string when no prompt can be found", () => {
    assert.equal(extractPrompt({}), "");
    assert.equal(extractPrompt({ messages: [] }), "");
  });
});

describe("extractToolSignature", () => {
  test("an explicit x-kodela-tool header wins over everything else", () => {
    const req = fakeReq({ "x-kodela-tool": "my-tool", "user-agent": "cursor/1" });
    assert.deepEqual(extractToolSignature(req, {}, "claude-3"), {
      tool: "my-tool",
      model: "claude-3",
    });
  });

  test("detects known tools from the user-agent", () => {
    assert.equal(extractToolSignature(fakeReq({ "user-agent": "Cursor/1.0" }), {}, "m").tool, "cursor");
    assert.equal(
      extractToolSignature(fakeReq({ "user-agent": "claude-code/2" }), {}, "m").tool,
      "claude-code",
    );
    assert.equal(
      extractToolSignature(fakeReq({ "user-agent": "Windsurf" }), {}, "m").tool,
      "windsurf",
    );
    assert.equal(
      extractToolSignature(fakeReq({ "user-agent": "vscode-copilot" }), {}, "m").tool,
      "vscode",
    );
  });

  test("falls back to the request path when the user-agent is unhelpful", () => {
    assert.equal(
      extractToolSignature(fakeReq({ "user-agent": "curl/8" }, "/v1/messages"), {}, "m").tool,
      "anthropic-sdk",
    );
    assert.equal(
      extractToolSignature(fakeReq({ "user-agent": "curl/8" }, "/v1/chat/completions"), {}, "m").tool,
      "openai-sdk",
    );
  });

  test("falls back to the model family when path and UA are unknown", () => {
    assert.equal(extractToolSignature(fakeReq({}), {}, "claude-3-opus").tool, "claude-code");
    assert.equal(extractToolSignature(fakeReq({}), {}, "gpt-4o").tool, "openai-sdk");
    assert.equal(extractToolSignature(fakeReq({}), {}, "o1-preview").tool, "openai-sdk");
  });

  test("returns 'unknown' when nothing matches and not in Replit", () => {
    const prev = process.env["REPL_ID"];
    delete process.env["REPL_ID"];
    try {
      assert.equal(extractToolSignature(fakeReq({}), {}, "mystery-model").tool, "unknown");
    } finally {
      if (prev !== undefined) process.env["REPL_ID"] = prev;
    }
  });

  test("attributes to Replit when REPL_ID is set and nothing else matches", () => {
    const prev = process.env["REPL_ID"];
    process.env["REPL_ID"] = "repl-abc";
    try {
      assert.equal(extractToolSignature(fakeReq({}), {}, "mystery-model").tool, "replit");
    } finally {
      if (prev === undefined) delete process.env["REPL_ID"];
      else process.env["REPL_ID"] = prev;
    }
  });
});

describe("isStreaming", () => {
  test("true only when stream === true", () => {
    assert.equal(isStreaming({ stream: true }), true);
    assert.equal(isStreaming({ stream: false }), false);
    assert.equal(isStreaming({}), false);
    assert.equal(isStreaming({ stream: "true" }), false);
  });
});
