// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInit } from "@kodela/cli";
import { readSession } from "@kodela/core";
import { readSessionTimeline, readSessionTurns } from "@kodela/core/sessions";
import { CopilotSessionCapture } from "./copilot-session-capture.js";

describe("CopilotSessionCapture", () => {
  let tmpDir: string;

  after(async () => {
    const vscode = await import("vscode");
    (
      vscode as unknown as {
        _testResetInstalledExtensions?: () => void;
        _testResetChatModels?: () => void;
        _testResetChatParticipants?: () => void;
      }
    )._testResetInstalledExtensions?.();
    (
      vscode as unknown as {
        _testResetInstalledExtensions?: () => void;
        _testResetChatModels?: () => void;
        _testResetChatParticipants?: () => void;
      }
    )._testResetChatModels?.();
    (
      vscode as unknown as {
        _testResetInstalledExtensions?: () => void;
        _testResetChatModels?: () => void;
        _testResetChatParticipants?: () => void;
      }
    )._testResetChatParticipants?.();

    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("captures prompt + assistant snippet and enriches session intent after close", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-chat-capture-"));
    await runInit(tmpDir);

    const vscode = await import("vscode");

    Object.defineProperty(
      (vscode as { workspace: typeof vscode.workspace }).workspace,
      "workspaceFolders",
      {
        value: [{ uri: { fsPath: tmpDir }, name: "test", index: 0 }],
        configurable: true,
        writable: true,
      },
    );

    const longAssistantTail = "Implemented prompt logging and LM enrichment flow. ".repeat(16);
    const expectedAssistantReasoning = (
      "Captured session context for this request. " + longAssistantTail
    ).trim();

    const chatModel = (
      vscode as unknown as {
        _testCreateChatModel: (options: {
          id: string;
          vendor: string;
          family: string;
          textChunks: readonly string[];
        }) => unknown;
      }
    )._testCreateChatModel({
      id: "gpt-4o-test",
      vendor: "copilot",
      family: "gpt-4o",
      textChunks: [
        "Captured session context for this request. ",
        longAssistantTail,
      ],
    });

    (
      vscode as unknown as {
        _testSetChatModels: (models: readonly unknown[]) => void;
      }
    )._testSetChatModels([chatModel]);

    const repoState = {
      HEAD: { name: "feature/session-capture", commit: "abc123" },
      workingTreeChanges: [
        { resourceUri: vscode.Uri.file(path.join(tmpDir, "src", "capture.ts")) },
      ],
      indexChanges: [],
      mergeChanges: [],
    };

    const gitExports = {
      getAPI: () => ({
        repositories: [
          {
            rootUri: vscode.Uri.file(tmpDir),
            state: repoState,
            log: async () => [{ message: "feat: capture vscode chat context" }],
          },
        ],
      }),
    };

    (
      vscode as unknown as {
        _testSetExtensionWithExports: (id: string, exportsValue: unknown) => void;
      }
    )._testSetExtensionWithExports("vscode.git", gitExports);

    const capture = new CopilotSessionCapture(tmpDir, undefined, {
      idleCloseMs: 10,
      enrichmentDelayMs: 10,
      sessionIdFactory: () => "vscode-session-001",
    });

    const invocation = await (
      vscode as unknown as {
        _testInvokeChatParticipant: (
          participantId: string,
          request: { prompt: string },
          context?: { history?: readonly unknown[] },
        ) => Promise<{ markdown: string[] }>;
      }
    )._testInvokeChatParticipant("kodela.context", {
      prompt: "Capture VS Code session context and summarize changes",
    });

    assert.ok(invocation.markdown.join("").includes("Captured session context"));

    const deadline = Date.now() + 2000;
    let session = await readSession(tmpDir, "vscode-session-001");
    while (
      Date.now() < deadline &&
      session &&
      session.intent?.source !== "copilot-lm-api"
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      session = await readSession(tmpDir, "vscode-session-001");
    }

    assert.ok(session, "session should be persisted");

    assert.equal(
      session.intent?.userPrompt,
      "Capture VS Code session context and summarize changes",
    );
    assert.equal(session.annotation?.source, "vscode-chat-participant");
    assert.equal(session.annotation?.reasoning, expectedAssistantReasoning);
    assert.ok(
      (session.annotation?.reasoning?.length ?? 0) > 500,
      "assistant reasoning should persist full response text",
    );

    assert.equal(session.git?.start?.branch, "feature/session-capture");
    assert.equal(session.git?.end?.branch, "feature/session-capture");
    assert.equal(session.git?.end?.diffStats?.total, 1);

    assert.equal(session.intent?.source, "copilot-lm-api");
    assert.equal(session.intent?.confidence, 0.88);
    assert.ok(
      session.intent?.synthesised?.includes("Implemented prompt logging"),
      "LM synthesis should be written into session.intent.synthesised",
    );
    assert.equal(
      session.intent?.commitMessage,
      "feat: capture vscode chat context",
    );

    assert.equal(session.actor?.tool, "vscode-copilot");
    assert.equal(session.actor?.model, "gpt-4o-test");

    const turns = await readSessionTurns(tmpDir, "vscode-session-001");
    assert.ok(turns.length >= 2, "request and response turns should be captured");
    assert.equal(turns[0]!.role, "user");
    assert.equal(turns[1]!.role, "assistant");
    assert.equal(turns[1]!.promptId, turns[0]!.id);

    const timeline = await readSessionTimeline(tmpDir, "vscode-session-001");
    const responseEvent = [...timeline]
      .reverse()
      .find((event) => event.type === "chat-response-captured");
    const reasoningPreview =
      responseEvent && responseEvent.data && typeof responseEvent.data["reasoningPreview"] === "string"
        ? responseEvent.data["reasoningPreview"]
        : "";
    assert.equal(reasoningPreview, expectedAssistantReasoning.slice(0, 500));

    const summaryPath = path.join(
      tmpDir,
      ".kodela",
      "sessions",
      "vscode-session-001.summary.json",
    );
    const summaryRaw = await fs.readFile(summaryPath, "utf-8");
    const summary = JSON.parse(summaryRaw) as {
      sessionId: string;
      intent: string;
      goal: string;
      intentSource: string;
    };

    assert.equal(summary.sessionId, "vscode-session-001");
    assert.equal(summary.goal, "Capture VS Code session context and summarize changes");
    assert.equal(summary.intent, "Capture VS Code session context and summarize changes");
    assert.equal(summary.intentSource, "user-goal");

    capture.dispose();
  });
});
