// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCommandAttribution,
  resolveToolNameAttribution,
  AiToolTracker,
  KNOWN_AI_TOOL_LINKS,
  KNOWN_AI_COMMAND_PREFIXES,
} from "./ai-tool-resolver.js";
import { _testFireExecuteCommand } from "../__mocks__/vscode.js";

describe("resolveCommandAttribution", () => {
  test("resolves github.copilot prefix", () => {
    const result = resolveCommandAttribution("github.copilot.generate");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "copilot");
    assert.equal(result!.link, "https://github.com/features/copilot");
  });

  test("resolves GitHub.copilot-chat prefix (capital G)", () => {
    const result = resolveCommandAttribution("GitHub.copilot-chat.openChat");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "copilot");
  });

  test("resolves continue. prefix", () => {
    const result = resolveCommandAttribution("continue.acceptDiff");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "continue");
    assert.equal(result!.link, "https://continue.dev");
  });

  test("resolves Continue. prefix (capital C)", () => {
    const result = resolveCommandAttribution("Continue.focusContiuneInput");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "continue");
  });

  test("resolves codeium. prefix", () => {
    const result = resolveCommandAttribution("codeium.completeCode");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "codeium");
    assert.equal(result!.link, "https://codeium.com");
  });

  test("resolves Codeium. prefix (capital C)", () => {
    const result = resolveCommandAttribution("Codeium.openChat");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "codeium");
  });

  test("resolves tabnine. prefix", () => {
    const result = resolveCommandAttribution("tabnine.openSuggestionPanel");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "tabnine");
    assert.equal(result!.link, "https://www.tabnine.com");
  });

  test("resolves TabNine. prefix (capital T)", () => {
    const result = resolveCommandAttribution("TabNine.snippet");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "tabnine");
  });

  test("resolves supermaven. prefix", () => {
    const result = resolveCommandAttribution("supermaven.startCompletion");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "supermaven");
    assert.equal(result!.link, "https://supermaven.com");
  });

  test("resolves cursorai. prefix", () => {
    const result = resolveCommandAttribution("cursorai.action.generateCode");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "cursor");
    assert.equal(result!.link, "https://cursor.sh");
  });

  test("resolves cursor. prefix", () => {
    const result = resolveCommandAttribution("cursor.chat.acceptLine");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "cursor");
    assert.equal(result!.link, "https://cursor.sh");
  });

  test("resolves amazonq. prefix", () => {
    const result = resolveCommandAttribution("amazonq.chat");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "amazon-q");
    assert.equal(result!.link, "https://aws.amazon.com/q/developer/");
  });

  test("resolves aws.codeWhisperer prefix", () => {
    const result = resolveCommandAttribution("aws.codeWhisperer.generateSuggestion");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "amazon-q");
  });

  test("resolves windsurf. prefix", () => {
    const result = resolveCommandAttribution("windsurf.openCascade");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "windsurf");
    assert.equal(result!.link, "https://codeium.com/windsurf");
  });

  test("returns undefined for unknown command", () => {
    assert.equal(resolveCommandAttribution("editor.action.formatDocument"), undefined);
  });

  test("returns undefined for empty string", () => {
    assert.equal(resolveCommandAttribution(""), undefined);
  });

  test("returns undefined for partial but non-matching prefix", () => {
    assert.equal(resolveCommandAttribution("git.commit"), undefined);
  });
});

describe("resolveToolNameAttribution", () => {
  test("resolves known tool name to attribution with link", () => {
    const result = resolveToolNameAttribution("copilot");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "copilot");
    assert.equal(result!.link, "https://github.com/features/copilot");
  });

  test("resolves 'claude' to claude.ai link", () => {
    const result = resolveToolNameAttribution("claude");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "claude");
    assert.equal(result!.link, "https://claude.ai");
  });

  test("resolves 'chatgpt' to chatgpt.com link", () => {
    const result = resolveToolNameAttribution("chatgpt");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "chatgpt");
    assert.equal(result!.link, "https://chatgpt.com");
  });

  test("returns undefined for 'none'", () => {
    assert.equal(resolveToolNameAttribution("none"), undefined);
  });

  test("returns undefined for 'NONE' (case-insensitive)", () => {
    assert.equal(resolveToolNameAttribution("NONE"), undefined);
  });

  test("returns undefined for empty string", () => {
    assert.equal(resolveToolNameAttribution(""), undefined);
  });

  test("returns undefined for whitespace-only string", () => {
    assert.equal(resolveToolNameAttribution("   "), undefined);
  });

  test("returns attribution with empty link for unknown tool name", () => {
    const result = resolveToolNameAttribution("my-custom-tool");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "my-custom-tool");
    assert.equal(result!.link, "");
  });

  test("preserves original casing for aiTool name", () => {
    const result = resolveToolNameAttribution("Copilot");
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "Copilot");
  });
});

describe("KNOWN_AI_TOOL_LINKS", () => {
  test("contains all standard tools", () => {
    const expected = ["copilot", "continue", "codeium", "tabnine", "supermaven", "cursor", "amazon-q", "windsurf", "claude", "chatgpt", "gemini"];
    for (const tool of expected) {
      assert.ok(KNOWN_AI_TOOL_LINKS.has(tool), `Missing tool: ${tool}`);
    }
  });

  test("all links are non-empty strings", () => {
    for (const [tool, link] of KNOWN_AI_TOOL_LINKS) {
      assert.ok(link.length > 0, `Empty link for tool: ${tool}`);
      assert.ok(link.startsWith("https://"), `Link does not start with https:// for tool: ${tool}`);
    }
  });
});

describe("KNOWN_AI_COMMAND_PREFIXES", () => {
  test("is a non-empty array", () => {
    assert.ok(KNOWN_AI_COMMAND_PREFIXES.length > 0);
  });

  test("all entries have non-empty prefix and attribution", () => {
    for (const [prefix, attribution] of KNOWN_AI_COMMAND_PREFIXES) {
      assert.ok(prefix.length > 0, "Empty prefix found");
      assert.ok(attribution.aiTool.length > 0, `Empty aiTool for prefix: ${prefix}`);
      assert.ok(attribution.link.length > 0, `Empty link for prefix: ${prefix}`);
    }
  });
});

describe("AiToolTracker", () => {
  test("getMostRecentWithin returns undefined when nothing recorded", () => {
    const tracker = new AiToolTracker();
    tracker.start();
    assert.equal(tracker.getMostRecentWithin(60_000), undefined);
    tracker.dispose();
  });

  test("records attribution when matching command fires", () => {
    const tracker = new AiToolTracker();
    tracker.start();

    _testFireExecuteCommand("github.copilot.generate");

    const result = tracker.getMostRecentWithin(60_000);
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "copilot");
    assert.equal(result!.link, "https://github.com/features/copilot");

    tracker.dispose();
  });

  test("ignores unknown commands", () => {
    const tracker = new AiToolTracker();
    tracker.start();

    _testFireExecuteCommand("editor.action.formatDocument");

    assert.equal(tracker.getMostRecentWithin(60_000), undefined);
    tracker.dispose();
  });

  test("returns most recently fired tool when multiple tools fire", () => {
    const tracker = new AiToolTracker();
    tracker.start();

    _testFireExecuteCommand("continue.acceptDiff");
    _testFireExecuteCommand("github.copilot.generate");

    const result = tracker.getMostRecentWithin(60_000);
    assert.ok(result !== undefined);
    assert.equal(result!.aiTool, "copilot", "copilot fired last so should win");

    tracker.dispose();
  });

  test("getMostRecentWithin returns undefined when window is 0ms", () => {
    const tracker = new AiToolTracker();
    tracker.start();

    _testFireExecuteCommand("github.copilot.generate");

    const result = tracker.getMostRecentWithin(0);
    assert.equal(result, undefined, "window of 0ms should exclude everything");
    tracker.dispose();
  });

  test("updates existing tool entry when same tool fires again", () => {
    const tracker = new AiToolTracker();
    tracker.start();

    _testFireExecuteCommand("github.copilot.generate");
    _testFireExecuteCommand("continue.acceptDiff");
    _testFireExecuteCommand("github.copilot.generate");

    const result = tracker.getMostRecentWithin(60_000);
    assert.equal(result?.aiTool, "copilot", "copilot fired last again so should win");
    tracker.dispose();
  });

  test("dispose stops listening to new commands", () => {
    const tracker = new AiToolTracker();
    tracker.start();
    tracker.dispose();

    _testFireExecuteCommand("github.copilot.generate");

    assert.equal(tracker.getMostRecentWithin(60_000), undefined, "should not record after dispose");
  });

  test("codeium command resolves correctly", () => {
    const tracker = new AiToolTracker();
    tracker.start();

    _testFireExecuteCommand("codeium.completeCode");

    const result = tracker.getMostRecentWithin(60_000);
    assert.equal(result?.aiTool, "codeium");
    assert.equal(result?.link, "https://codeium.com");
    tracker.dispose();
  });

  test("windsurf command resolves correctly", () => {
    const tracker = new AiToolTracker();
    tracker.start();

    _testFireExecuteCommand("windsurf.openCascade");

    const result = tracker.getMostRecentWithin(60_000);
    assert.equal(result?.aiTool, "windsurf");
    tracker.dispose();
  });

  test("tabnine command resolves correctly", () => {
    const tracker = new AiToolTracker();
    tracker.start();

    _testFireExecuteCommand("TabNine.snippet");

    const result = tracker.getMostRecentWithin(60_000);
    assert.equal(result?.aiTool, "tabnine");
    tracker.dispose();
  });

  test("amazon-q command resolves correctly via amazonq prefix", () => {
    const tracker = new AiToolTracker();
    tracker.start();

    _testFireExecuteCommand("amazonq.chat.openPanel");

    const result = tracker.getMostRecentWithin(60_000);
    assert.equal(result?.aiTool, "amazon-q");
    assert.equal(result?.link, "https://aws.amazon.com/q/developer/");
    tracker.dispose();
  });

  test("cursor command resolves correctly via cursorai prefix", () => {
    const tracker = new AiToolTracker();
    tracker.start();

    _testFireExecuteCommand("cursorai.action.generateCode");

    const result = tracker.getMostRecentWithin(60_000);
    assert.equal(result?.aiTool, "cursor");
    assert.equal(result?.link, "https://cursor.sh");
    tracker.dispose();
  });

  test("cursor command resolves correctly via cursor. prefix", () => {
    const tracker = new AiToolTracker();
    tracker.start();

    _testFireExecuteCommand("cursor.chat.acceptLine");

    const result = tracker.getMostRecentWithin(60_000);
    assert.equal(result?.aiTool, "cursor");
    assert.equal(result?.link, "https://cursor.sh");
    tracker.dispose();
  });
});
