// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildHandoff } from "./index.js";

describe("buildHandoff conversation context", () => {
  test("includes conversation and continuity metadata", () => {
    const handoff = buildHandoff(
      "kodela",
      {
        sessionId: "11111111-2222-4333-8444-555555555555",
        tool: "vscode-copilot",
        goal: "Capture continuous handoff context",
        intent: "Implemented session detail API and request/response rendering.",
        reasoning: "Needed durable turn-level memory so future sessions can continue safely.",
        intentSource: "summary-aggregate",
        riskLevel: "low",
        avgConfidence: 0.88,
        createdAt: "2026-05-04T20:00:00.000Z",
        endedAt: "2026-05-04T20:05:00.000Z",
        author: "alice",
      },
      [
        {
          id: "entry-1",
          filePath: "lib/dashboard/src/pages/ContextHistory.tsx",
          note: "Added full context detail tabs",
          author: "alice",
          createdAt: "2026-05-04T20:01:00.000Z",
          confidence: 0.88,
          status: "mapped",
          source: "ai",
          aiTool: "copilot",
          rawContext: { linesAdded: 80, linesRemoved: 10 },
          summary: { intent: "Add detail view", changeType: "addition" },
          reasoning: {
            intent: "Render request response details",
            reasoning: "Needed to show complete context history.",
            confidence: "high",
            extractionMethod: "model",
          },
          origin: { sessionId: "11111111-2222-4333-8444-555555555555", tool: "copilot" },
        },
      ],
      {
        conversation: {
          totalTurns: 2,
          exchanges: [
            {
              requestText: "Please expose full request and response context in UI.",
              requestAt: "2026-05-04T20:00:01.000Z",
              requestSource: "vscode-chat-participant",
              responseText: "Added session detail endpoint and dashboard tabs.",
              responseAt: "2026-05-04T20:00:10.000Z",
              responseSource: "vscode-chat-participant",
            },
          ],
        },
        continuity: {
          lastRequest: "Please expose full request and response context in UI.",
          lastResponse: "Added session detail endpoint and dashboard tabs.",
          unresolvedRequests: 0,
        },
      },
    );

    assert.equal(handoff.conversation?.totalTurns, 2);
    assert.equal(handoff.conversation?.exchangeCount, 1);
    assert.equal(handoff.continuity?.unresolvedRequests, 0);
    assert.ok(handoff.markdownSummary.includes("### 🧵 Context request/response"));
    assert.ok(handoff.markdownSummary.includes("### ▶ Continuous handoff anchor"));
  });
});
