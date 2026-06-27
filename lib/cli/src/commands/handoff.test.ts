// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInit } from "./init.js";
import { runHandoff } from "./handoff.js";
import { writeContextEntry } from "@kodela/core";
import {
  startSession,
  linkEntryToSession,
} from "@kodela/core/sessions";
import type { ContextEntry } from "@kodela/core";

function makeEntry(sessionId: string): ContextEntry {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.1.0",
    id: crypto.randomUUID(),
    sessionId,
    filePath: "lib/core/src/sessions/manager.ts",
    astAnchor: null,
    contentHash: "a".repeat(64),
    lineRange: { start: 1, end: 40 },
    note: "Added shared summary writer for session sidecars",
    author: "watcher",
    createdAt: now,
    updatedAt: now,
    severity: "low",
    tags: ["ai", "auto"],
    source: "ai",
    confidence: 0.82,
    status: "mapped",
    reviewRequired: false,
    summary: {
      intent: "Implemented watcher session summary parity",
      shortSummary: "Write summary sidecar in shared flow",
      changeType: "addition",
      risk: "low",
    },
    rawContext: {
      linesAdded: 80,
      linesRemoved: 5,
      fileCount: 1,
      diff: "+ summary helper\n- duplicated logic",
    },
  };
}

describe("runHandoff", () => {
  let tmpDir = "";

  after(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("synthesises summary when sidecar is missing", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-handoff-"));
    await runInit(tmpDir);

    const sessionId = crypto.randomUUID();
    await startSession(tmpDir, sessionId, { model: "test-model" });

    const entry = makeEntry(sessionId);
    await writeContextEntry(tmpDir, entry);
    await linkEntryToSession(tmpDir, sessionId, entry.id, entry.filePath);

    const summaryPath = path.join(
      tmpDir,
      ".kodela",
      "sessions",
      `${sessionId}.summary.json`,
    );

    await fs.rm(summaryPath, { force: true });

    const markdown = await runHandoff({
      repoRoot: tmpDir,
      sessionId,
      markdownOnly: true,
    });

    assert.ok(
      markdown.includes("Implemented watcher session summary parity"),
      "handoff should use synthesized summary intent when sidecar is missing",
    );
    assert.ok(
      !markdown.includes("Gap 120 — session intent synthesised from heuristics/commit messages only"),
      "Gap 120 warning should be cleared after summary synthesis",
    );

    const summaryRaw = await fs.readFile(summaryPath, "utf-8");
    const summary = JSON.parse(summaryRaw) as {
      sessionId: string;
      intentSource: string;
    };
    assert.equal(summary.sessionId, sessionId);
    assert.equal(summary.intentSource, "summary-aggregate");
  });

  test("refreshes stale structural sidecar and clears heuristic quality gaps", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-handoff-stale-"));
    await runInit(tmpDir);

    const sessionId = crypto.randomUUID();
    await startSession(tmpDir, sessionId, { model: "test-model" });

    const entry = makeEntry(sessionId);
    await writeContextEntry(tmpDir, entry);
    await linkEntryToSession(tmpDir, sessionId, entry.id, entry.filePath);

    const summaryPath = path.join(
      tmpDir,
      ".kodela",
      "sessions",
      `${sessionId}.summary.json`,
    );

    await fs.writeFile(
      summaryPath,
      JSON.stringify(
        {
          sessionId,
          intent: "Modified 1 file: lib/core/src/sessions/manager.ts",
          reasoning: "",
          goal: "",
          filesChanged: ["lib/core/src/sessions/manager.ts"],
          totalLinesAdded: 80,
          totalLinesRemoved: 5,
          dominantChangeType: "addition",
          riskLevel: "low",
          avgConfidence: 0.82,
          entryCount: 1,
          synthesisedAt: new Date().toISOString(),
          intentSource: "structural-fallback",
        },
        null,
        2,
      ),
      "utf-8",
    );

    const markdown = await runHandoff({
      repoRoot: tmpDir,
      sessionId,
      markdownOnly: true,
    });

    assert.ok(
      markdown.includes("Implemented watcher session summary parity"),
      "handoff should refresh stale structural intent with semantic summary",
    );
    assert.ok(
      !markdown.includes("Gap 120 — session intent synthesised from heuristics/commit messages only"),
      "heuristic intent warning should be cleared after stale sidecar refresh",
    );
    assert.ok(
      !markdown.includes("Gap 122 — reasoning fields not populated"),
      "reasoning warning should be cleared when semantic reasoning is synthesized",
    );

    const summaryRaw = await fs.readFile(summaryPath, "utf-8");
    const summary = JSON.parse(summaryRaw) as {
      intentSource: string;
      reasoning: string;
    };

    assert.equal(summary.intentSource, "summary-aggregate");
    assert.ok(
      summary.reasoning.length > 0,
      "refreshed sidecar should include synthesized reasoning",
    );
  });

  test("refreshes sidecar when memory payload is missing", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-handoff-missing-memory-"));
    await runInit(tmpDir);

    const sessionId = crypto.randomUUID();
    await startSession(tmpDir, sessionId, { model: "test-model" });

    const entry = makeEntry(sessionId);
    await writeContextEntry(tmpDir, entry);
    await linkEntryToSession(tmpDir, sessionId, entry.id, entry.filePath);

    const summaryPath = path.join(
      tmpDir,
      ".kodela",
      "sessions",
      `${sessionId}.summary.json`,
    );

    await fs.writeFile(
      summaryPath,
      JSON.stringify(
        {
          sessionId,
          intent: "Implemented watcher session summary parity",
          reasoning: "Implemented watcher session summary parity for sidecar consistency.",
          goal: "",
          filesChanged: ["lib/core/src/sessions/manager.ts"],
          totalLinesAdded: 80,
          totalLinesRemoved: 5,
          dominantChangeType: "addition",
          riskLevel: "low",
          avgConfidence: 0.82,
          entryCount: 1,
          synthesisedAt: new Date().toISOString(),
          intentSource: "summary-aggregate",
        },
        null,
        2,
      ),
      "utf-8",
    );

    await runHandoff({
      repoRoot: tmpDir,
      sessionId,
      markdownOnly: true,
    });

    const summaryRaw = await fs.readFile(summaryPath, "utf-8");
    const summary = JSON.parse(summaryRaw) as {
      memory?: {
        whatChanged?: string[];
        validationContext?: string;
      };
      reasoning: string;
    };

    assert.ok(summary.memory, "refreshed sidecar should include memory payload");
    assert.ok(
      (summary.memory?.whatChanged?.length ?? 0) > 0,
      "refreshed sidecar should include memory.whatChanged entries",
    );
    assert.ok(
      (summary.memory?.validationContext ?? "").length > 0,
      "refreshed sidecar should include memory.validationContext",
    );
    assert.ok(
      summary.reasoning.includes("Session scope:"),
      "refreshed sidecar should include expanded reasoning scope context",
    );
  });

  test("replaces identifier-heavy sidecar intent with semantic synthesis", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-handoff-identifier-sidecar-"));
    await runInit(tmpDir);

    const sessionId = crypto.randomUUID();
    await startSession(tmpDir, sessionId, { model: "test-model" });

    const entry: ContextEntry = {
      ...makeEntry(sessionId),
      note: "Auto-annotated: unknown agent change — 1 hunk, 139 lines",
      confidence: 0.7,
      summary: {
        intent: "AI-generated change",
        shortSummary: "makeEntry, tmpDir, sessionsDir (138+/0-)",
        changeType: "addition",
        risk: "low",
      },
      rawContext: {
        linesAdded: 138,
        linesRemoved: 0,
        fileCount: 1,
        diff: [
          '+ note: "Implemented watcher session summary parity"',
          '+ goal: "Support consistent summary sidecar generation"',
        ].join("\n"),
      },
    };

    await writeContextEntry(tmpDir, entry);
    await linkEntryToSession(tmpDir, sessionId, entry.id, entry.filePath);

    const summaryPath = path.join(
      tmpDir,
      ".kodela",
      "sessions",
      `${sessionId}.summary.json`,
    );

    await fs.writeFile(
      summaryPath,
      JSON.stringify(
        {
          sessionId,
          intent: "makeEntry, tmpDir, sessionsDir (138+/0-); makeEntry, now, tmpDir (103+/0-)",
          reasoning: "makeEntry, tmpDir, sessionsDir (138+/0-) makeEntry, now, tmpDir (103+/0-)",
          goal: "",
          filesChanged: ["lib/core/src/sessions/manager.ts"],
          totalLinesAdded: 138,
          totalLinesRemoved: 0,
          dominantChangeType: "addition",
          riskLevel: "low",
          avgConfidence: 0.7,
          entryCount: 1,
          synthesisedAt: new Date().toISOString(),
          intentSource: "summary-aggregate",
        },
        null,
        2,
      ),
      "utf-8",
    );

    const markdown = await runHandoff({
      repoRoot: tmpDir,
      sessionId,
      markdownOnly: true,
    });

    assert.ok(
      markdown.includes("Implemented watcher session summary parity"),
      "handoff should promote semantic diff-derived phrasing over identifier-heavy sidecar strings",
    );
    assert.ok(
      !markdown.includes("makeEntry, tmpDir"),
      "identifier-heavy sidecar wording should not appear in final handoff",
    );

    const summaryRaw = await fs.readFile(summaryPath, "utf-8");
    const summary = JSON.parse(summaryRaw) as {
      intent: string;
      reasoning: string;
      intentSource: string;
    };

    assert.ok(
      summary.intent.includes("Implemented watcher session summary parity"),
      "refreshed sidecar should store semantic intent",
    );
    assert.ok(
      !summary.intent.includes("makeEntry, tmpDir"),
      "identifier-heavy intent should be removed from refreshed sidecar",
    );
    assert.ok(summary.reasoning.length > 0);
    assert.equal(summary.intentSource, "summary-aggregate");
  });

  test("includes git snapshot files and user prompt fallback for entryless watch sessions", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-handoff-entryless-watch-"));
    await runInit(tmpDir);

    const sessionId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const sessionsDir = path.join(tmpDir, ".kodela", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    await fs.writeFile(
      path.join(sessionsDir, `${sessionId}.json`),
      JSON.stringify(
        {
          id: sessionId,
          startedAt,
          endedAt: startedAt,
          entries: [],
          aggregatedRisk: "low",
          filesChanged: [],
          actor: {
            tool: "unknown",
            author: "alice",
          },
          intent: {
            userPrompt: "Validate malformed-fragment guard in session summaries.",
            source: "watch-none",
            confidence: 0,
          },
          git: {
            end: {
              filesChanged: ["docs/session-fragment-guard-validation.md"],
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const markdown = await runHandoff({
      repoRoot: tmpDir,
      sessionId,
      markdownOnly: true,
    });

    assert.ok(markdown.includes("Captured file activity in 1 file during this watch session."));
    assert.ok(markdown.includes("### 📦 Files changed (1)"));
    assert.ok(markdown.includes("docs/session-fragment-guard-validation.md"));
    assert.ok(markdown.includes("### 💬 Original request"));
    assert.ok(markdown.includes("Validate malformed-fragment guard in session summaries."));
    assert.ok(!markdown.includes("Gap 121 — user prompt not captured at session start"));
  });
});
