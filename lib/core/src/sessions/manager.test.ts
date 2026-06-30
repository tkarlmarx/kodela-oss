// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 55 Phase B — SessionManager tests
 *
 * Covers: startSession, linkEntryToSession, computeAggregatedRisk,
 *         closeSession (with multi-file and cross-scope penalties),
 *         getSessionEntries (including lazy-close behaviour).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  startSession,
  linkEntryToSession,
  computeAggregatedRisk,
  closeSession,
  getSessionEntries,
  synthesiseAndWriteSessionSummary,
  updateSessionGoal,
  updateSessionIntent,
  updateSessionActor,
  updateSessionAnnotation,
  updateSessionGitSnapshot,
  appendUserTurn,
  appendAssistantTurn,
  readSessionTurns,
  appendSessionTimelineEvent,
  readSessionTimeline,
} from "./manager.js";
import { readSession, writeSession, writeContextEntry, ensureKodelaDir } from "../storage/index.js";
import type { ContextEntry } from "../schema/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-sessions-"));
  await ensureKodelaDir(dir);
  return dir;
}

async function makeEntry(
  repoRoot: string,
  filePath: string,
  severity: ContextEntry["severity"] = "low",
): Promise<ContextEntry> {
  const now = new Date().toISOString();
  const entry: ContextEntry = {
    schemaVersion: "1.1.0",
    id: randomUUID(),
    filePath,
    astAnchor: null,
    contentHash: randomUUID(),
    lineRange: { start: 1, end: 10 },
    note: `Test note for ${filePath}`,
    author: "test",
    createdAt: now,
    updatedAt: now,
    severity,
    tags: [],
    source: "human",
    confidence: 0.9,
    attributionConfidence: 1.0,
    status: "mapped",
    reviewRequired: false,
  };
  await writeContextEntry(repoRoot, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// startSession
// ---------------------------------------------------------------------------

describe("startSession", () => {
  let repoRoot: string;
  before(async () => { repoRoot = await makeTmpRepo(); });
  after(async () => { await fs.rm(repoRoot, { recursive: true, force: true }); });

  it("creates a new session with default values", async () => {
    const sid = randomUUID();
    const session = await startSession(repoRoot, sid);
    assert.equal(session.id, sid);
    assert.equal(session.aggregatedRisk, "low");
    assert.deepEqual(session.entries, []);
    assert.deepEqual(session.filesChanged, []);
    assert.equal(session.endedAt, undefined);
  });

  it("populates model and goal when provided", async () => {
    const sid = randomUUID();
    const session = await startSession(repoRoot, sid, {
      model: "claude-opus-4",
      goal: "refactor auth module",
    });
    assert.equal(session.model, "claude-opus-4");
    assert.equal(session.goal, "refactor auth module");
  });

  it("is idempotent — returns existing open session on repeated call", async () => {
    const sid = randomUUID();
    const s1 = await startSession(repoRoot, sid, { goal: "original" });
    const s2 = await startSession(repoRoot, sid, { goal: "should be ignored" });
    assert.equal(s1.startedAt, s2.startedAt);
    assert.equal(s2.goal, "original");
  });

  it("persists session to disk", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);
    const fromDisk = await readSession(repoRoot, sid);
    assert.ok(fromDisk);
    assert.equal(fromDisk.id, sid);
  });
});

// ---------------------------------------------------------------------------
// linkEntryToSession
// ---------------------------------------------------------------------------

describe("linkEntryToSession", () => {
  let repoRoot: string;
  before(async () => { repoRoot = await makeTmpRepo(); });
  after(async () => { await fs.rm(repoRoot, { recursive: true, force: true }); });

  it("appends entry and file to session", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);
    const entryId = randomUUID();
    await linkEntryToSession(repoRoot, sid, entryId, "src/foo.ts");
    const session = await readSession(repoRoot, sid);
    assert.ok(session);
    assert.ok(session.entries.includes(entryId));
    assert.ok(session.filesChanged.includes("src/foo.ts"));
  });

  it("creates session if it does not exist (appendEntryToSession behaviour)", async () => {
    const sid = randomUUID();
    const entryId = randomUUID();
    await linkEntryToSession(repoRoot, sid, entryId, "src/bar.ts");
    const session = await readSession(repoRoot, sid);
    assert.ok(session);
    assert.ok(session.entries.includes(entryId));
  });
});

// ---------------------------------------------------------------------------
// computeAggregatedRisk
// ---------------------------------------------------------------------------

describe("computeAggregatedRisk", () => {
  let repoRoot: string;
  before(async () => { repoRoot = await makeTmpRepo(); });
  after(async () => { await fs.rm(repoRoot, { recursive: true, force: true }); });

  it("returns low for an empty session", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);
    const risk = await computeAggregatedRisk(repoRoot, sid);
    assert.equal(risk, "low");
  });

  it("returns low for all low-severity entries", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);
    const e1 = await makeEntry(repoRoot, "src/utils.ts", "low");
    const e2 = await makeEntry(repoRoot, "src/helper.ts", "low");
    await linkEntryToSession(repoRoot, sid, e1.id, e1.filePath);
    await linkEntryToSession(repoRoot, sid, e2.id, e2.filePath);
    const risk = await computeAggregatedRisk(repoRoot, sid);
    assert.equal(risk, "low");
  });

  it("inherits max severity — critical entry raises session to critical", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);
    const e1 = await makeEntry(repoRoot, "src/low.ts", "low");
    const e2 = await makeEntry(repoRoot, "src/crit.ts", "critical");
    await linkEntryToSession(repoRoot, sid, e1.id, e1.filePath);
    await linkEntryToSession(repoRoot, sid, e2.id, e2.filePath);
    const risk = await computeAggregatedRisk(repoRoot, sid);
    assert.equal(risk, "critical");
  });

  it("multi-file penalty: > 5 files bumps risk by one level", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);
    for (let i = 0; i < 6; i++) {
      const e = await makeEntry(repoRoot, `src/file${i}.ts`, "low");
      await linkEntryToSession(repoRoot, sid, e.id, e.filePath);
    }
    const risk = await computeAggregatedRisk(repoRoot, sid);
    assert.equal(risk, "medium");
  });

  it("cross-scope penalty: 2+ sensitive scopes bump risk", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);
    const e1 = await makeEntry(repoRoot, "src/auth/login.ts", "low");
    const e2 = await makeEntry(repoRoot, "src/payments/charge.ts", "low");
    await linkEntryToSession(repoRoot, sid, e1.id, e1.filePath);
    await linkEntryToSession(repoRoot, sid, e2.id, e2.filePath);
    const risk = await computeAggregatedRisk(repoRoot, sid);
    assert.equal(risk, "medium");
  });

  it("double penalty: multi-file + cross-scope bumps risk twice", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);
    for (let i = 0; i < 4; i++) {
      const e = await makeEntry(repoRoot, `src/auth/file${i}.ts`, "low");
      await linkEntryToSession(repoRoot, sid, e.id, e.filePath);
    }
    for (let i = 0; i < 2; i++) {
      const e = await makeEntry(repoRoot, `src/payments/file${i}.ts`, "low");
      await linkEntryToSession(repoRoot, sid, e.id, e.filePath);
    }
    const risk = await computeAggregatedRisk(repoRoot, sid);
    assert.equal(risk, "high");
  });

  it("risk is capped at critical — no overflow", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);
    for (let i = 0; i < 6; i++) {
      const e = await makeEntry(repoRoot, `src/auth/f${i}.ts`, "critical");
      await linkEntryToSession(repoRoot, sid, e.id, e.filePath);
    }
    const e7 = await makeEntry(repoRoot, "src/payments/x.ts", "critical");
    await linkEntryToSession(repoRoot, sid, e7.id, e7.filePath);
    const risk = await computeAggregatedRisk(repoRoot, sid);
    assert.equal(risk, "critical");
  });
});

// ---------------------------------------------------------------------------
// closeSession
// ---------------------------------------------------------------------------

describe("closeSession", () => {
  let repoRoot: string;
  before(async () => { repoRoot = await makeTmpRepo(); });
  after(async () => { await fs.rm(repoRoot, { recursive: true, force: true }); });

  it("stamps endedAt and writes aggregatedRisk", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);
    const e = await makeEntry(repoRoot, "src/auth/a.ts", "high");
    await linkEntryToSession(repoRoot, sid, e.id, e.filePath);
    const closed = await closeSession(repoRoot, sid);
    assert.ok(closed);
    assert.ok(closed.endedAt);
    assert.equal(closed.aggregatedRisk, "high");
  });

  it("returns null for a non-existent session", async () => {
    const result = await closeSession(repoRoot, randomUUID());
    assert.equal(result, null);
  });

  it("optional goal is persisted when provided", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);
    const closed = await closeSession(repoRoot, sid, { goal: "add MCP server" });
    assert.ok(closed);
    assert.equal(closed.goal, "add MCP server");
  });
});

// ---------------------------------------------------------------------------
// getSessionEntries
// ---------------------------------------------------------------------------

describe("getSessionEntries", () => {
  let repoRoot: string;
  before(async () => { repoRoot = await makeTmpRepo(); });
  after(async () => { await fs.rm(repoRoot, { recursive: true, force: true }); });

  it("returns null for a non-existent session", async () => {
    const result = await getSessionEntries(repoRoot, randomUUID());
    assert.equal(result, null);
  });

  it("returns session and all linked entries", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);
    const e1 = await makeEntry(repoRoot, "src/a.ts", "low");
    const e2 = await makeEntry(repoRoot, "src/b.ts", "medium");
    await linkEntryToSession(repoRoot, sid, e1.id, e1.filePath);
    await linkEntryToSession(repoRoot, sid, e2.id, e2.filePath);
    const result = await getSessionEntries(repoRoot, sid);
    assert.ok(result);
    assert.equal(result.entries.length, 2);
    const ids = result.entries.map((e) => e.id);
    assert.ok(ids.includes(e1.id));
    assert.ok(ids.includes(e2.id));
  });

  it("lazily closes a stale open session (> 1 hour)", async () => {
    const sid = randomUUID();
    const staleStart = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await writeSession(repoRoot, {
      id: sid,
      startedAt: staleStart,
      entries: [],
      aggregatedRisk: "low",
      filesChanged: [],
    });
    const result = await getSessionEntries(repoRoot, sid);
    assert.ok(result);
    assert.ok(result.session.endedAt, "stale session should be closed lazily");
  });

  it("does not close a fresh open session", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);
    const result = await getSessionEntries(repoRoot, sid);
    assert.ok(result);
    assert.equal(result.session.endedAt, undefined);
  });
});

// ---------------------------------------------------------------------------
// Session metadata mutators (intent/actor/annotation/git)
// ---------------------------------------------------------------------------

describe("session metadata mutators", () => {
  let repoRoot: string;
  before(async () => { repoRoot = await makeTmpRepo(); });
  after(async () => { await fs.rm(repoRoot, { recursive: true, force: true }); });

  it("merges intent patches and stamps updatedAt", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);

    await updateSessionIntent(repoRoot, sid, {
      userPrompt: "stabilize vscode session capture",
      source: "vscode-chat-participant",
      confidence: 0.82,
    });

    const session = await readSession(repoRoot, sid);
    assert.ok(session);
    assert.equal(session.intent?.userPrompt, "stabilize vscode session capture");
    assert.equal(session.intent?.source, "vscode-chat-participant");
    assert.equal(session.intent?.confidence, 0.82);
    assert.ok(session.intent?.updatedAt);
  });

  it("merges actor and annotation patches", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);

    await updateSessionActor(repoRoot, sid, {
      tool: "vscode-copilot",
      model: "gpt-4o",
      author: "alice",
    });

    await updateSessionAnnotation(repoRoot, sid, {
      reasoning: "Captured assistant response preview",
      source: "vscode-chat-participant",
    });

    const session = await readSession(repoRoot, sid);
    assert.ok(session);
    assert.equal(session.actor?.tool, "vscode-copilot");
    assert.equal(session.actor?.model, "gpt-4o");
    assert.equal(session.annotation?.source, "vscode-chat-participant");
    assert.ok(session.annotation?.reasoning?.includes("assistant response"));
  });

  it("writes git start/end snapshots", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);

    await updateSessionGitSnapshot(repoRoot, sid, "start", {
      branch: "feature/session-capture",
      headCommit: "abc123",
      author: "alice",
      capturedAt: new Date().toISOString(),
    });

    await updateSessionGitSnapshot(repoRoot, sid, "end", {
      branch: "feature/session-capture",
      headCommit: "def456",
      author: "alice",
      filesChanged: ["lib/vscode/src/extension.ts"],
      diffStats: { workingTree: 1, index: 0, merge: 0, total: 1 },
      capturedAt: new Date().toISOString(),
    });

    const session = await readSession(repoRoot, sid);
    assert.ok(session);
    assert.equal(session.git?.start?.headCommit, "abc123");
    assert.equal(session.git?.end?.headCommit, "def456");
    assert.deepEqual(session.git?.end?.filesChanged, ["lib/vscode/src/extension.ts"]);
    assert.deepEqual(session.filesChanged, ["lib/vscode/src/extension.ts"]);
    assert.equal(session.git?.end?.diffStats?.total, 1);
  });
});

// ---------------------------------------------------------------------------
// Session timeline (persistent chronological event stream)
// ---------------------------------------------------------------------------

describe("session timeline events", () => {
  let repoRoot: string;
  before(async () => { repoRoot = await makeTmpRepo(); });
  after(async () => { await fs.rm(repoRoot, { recursive: true, force: true }); });

  it("appends and reads explicit timeline events", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid);

    await appendSessionTimelineEvent(repoRoot, sid, {
      type: "custom-checkpoint",
      source: "unit-test",
      message: "checkpoint reached",
      data: { checkpoint: 1 },
    });

    const events = await readSessionTimeline(repoRoot, sid);
    assert.ok(events.length >= 2, "expected start event + custom event");
    const custom = events.find((e) => e.type === "custom-checkpoint");
    assert.ok(custom);
    assert.equal(custom.source, "unit-test");
    assert.equal(custom.message, "checkpoint reached");
    assert.equal(custom.data?.checkpoint, 1);
  });

  it("records timeline events from session mutators", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid, { model: "gpt-4o" });

    await updateSessionGoal(repoRoot, sid, "capture VS Code intent timeline");
    await updateSessionIntent(repoRoot, sid, {
      userPrompt: "track session reasoning over time",
      source: "vscode-chat-participant",
      confidence: 0.82,
    });
    await updateSessionAnnotation(repoRoot, sid, {
      reasoning: "Assistant explained the implementation approach.",
      source: "vscode-chat-participant",
    });
    await updateSessionGitSnapshot(repoRoot, sid, "start", {
      branch: "feature/timeline",
      headCommit: "abc123",
      capturedAt: new Date().toISOString(),
    });
    await closeSession(repoRoot, sid);

    const events = await readSessionTimeline(repoRoot, sid);
    const types = new Set(events.map((e) => e.type));

    assert.ok(types.has("session-started"));
    assert.ok(types.has("goal-updated"));
    assert.ok(types.has("intent-updated"));
    assert.ok(types.has("annotation-updated"));
    assert.ok(types.has("git-snapshot-captured"));
    assert.ok(types.has("session-closed"));
  });

  it("persists user and assistant turns with prompt linkage", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid, { model: "gpt-4o" });

    const userTurn = await appendUserTurn(
      repoRoot,
      sid,
      "Capture request and response details for continuous handoff.",
      { source: "unit-test" },
    );
    assert.ok(userTurn);

    const assistantTurn = await appendAssistantTurn(
      repoRoot,
      sid,
      "Implemented durable turn storage and response linkage.",
      { source: "unit-test", promptId: userTurn!.id },
    );
    assert.ok(assistantTurn);

    const turns = await readSessionTurns(repoRoot, sid);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]!.role, "user");
    assert.equal(turns[1]!.role, "assistant");
    assert.equal(turns[0]!.seq, 1);
    assert.equal(turns[1]!.seq, 2);
    assert.equal(turns[1]!.promptId, turns[0]!.id);

    const events = await readSessionTimeline(repoRoot, sid);
    const types = new Set(events.map((e) => e.type));
    assert.ok(types.has("user-turn-captured"));
    assert.ok(types.has("assistant-turn-captured"));
  });
});

// ---------------------------------------------------------------------------
// Session summary sidecar
// ---------------------------------------------------------------------------

describe("session summary sidecar", () => {
  let repoRoot: string;
  before(async () => { repoRoot = await makeTmpRepo(); });
  after(async () => { await fs.rm(repoRoot, { recursive: true, force: true }); });

  it("returns null when session does not exist", async () => {
    const result = await synthesiseAndWriteSessionSummary(repoRoot, randomUUID());
    assert.equal(result, null);
  });

  it("writes .summary.json and emits session-summary-written timeline event", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid, { model: "gpt-4o" });

    await appendAssistantTurn(
      repoRoot,
      sid,
      "Implemented restart-safe session timeline continuity and resume checkpoints for VS Code capture.",
    );
    await closeSession(repoRoot, sid);

    const summary = await synthesiseAndWriteSessionSummary(repoRoot, sid);
    assert.ok(summary);
    assert.equal(summary.intentSource, "assistant-response");
    assert.equal(summary.assistantTurnCount, 1);
    assert.ok(summary.memory);
    assert.ok(summary.memory?.whatChanged.length);
    assert.ok(summary.memory?.whyItMatters.length);
    assert.ok(summary.memory?.validationContext.length);
    assert.ok(summary.memory?.nextActions.length);

    const summaryPath = path.join(repoRoot, ".kodela", "sessions", `${sid}.summary.json`);
    const raw = await fs.readFile(summaryPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      sessionId: string;
      intentSource: string;
    };
    assert.equal(parsed.sessionId, sid);
    assert.equal(parsed.intentSource, "assistant-response");

    const events = await readSessionTimeline(repoRoot, sid);
    assert.ok(events.some((e) => e.type === "session-summary-written"));

    const session = await readSession(repoRoot, sid);
    assert.ok(session);
    assert.equal(session.actor?.tool, "unknown");
    assert.ok(session.intent?.synthesised?.length, "session intent should be snapshot-synthesised");
    assert.ok(session.intent?.aiReasoning?.length, "session aiReasoning should be snapshot-synthesised");
    assert.equal(session.risk, session.aggregatedRisk);
    assert.ok(session.changes?.files.length !== undefined, "session changes snapshot should be present");
    assert.ok(typeof session.duration === "number", "session duration should be present");
    assert.ok((session.handoffSummary ?? "").length > 0, "session handoffSummary should be present");
  });

  it("extracts semantic intent from diff text when watcher summaries are identifier-heavy", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid, { model: "gpt-4o" });

    const now = new Date().toISOString();
    const entry: ContextEntry = {
      schemaVersion: "1.1.0",
      id: randomUUID(),
      sessionId: sid,
      filePath: "artifacts/api-server/src/routes/context-query.test.ts",
      astAnchor: null,
      contentHash: randomUUID(),
      lineRange: { start: 1, end: 120 },
      note: "Auto-annotated: unknown agent change — 1 hunk, 139 lines",
      author: "watcher",
      createdAt: now,
      updatedAt: now,
      severity: "low",
      tags: ["ai", "auto"],
      source: "ai",
      confidence: 0.7,
      attributionConfidence: 0.7,
      status: "mapped",
      reviewRequired: false,
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

    await writeContextEntry(repoRoot, entry);
    await linkEntryToSession(repoRoot, sid, entry.id, entry.filePath);
    await closeSession(repoRoot, sid);

    const summary = await synthesiseAndWriteSessionSummary(repoRoot, sid);
    assert.ok(summary);
    assert.equal(summary.intentSource, "summary-aggregate");
    assert.ok(
      summary.intent.includes("Implemented watcher session summary parity"),
      "diff-derived semantic phrase should be preferred over identifier-only short summary",
    );
    assert.ok(
      !summary.intent.includes("makeEntry, tmpDir"),
      "identifier-heavy placeholder should not be used as session intent",
    );
    assert.ok(
      summary.reasoning.length > 0,
      "reasoning should be populated from semantic candidates",
    );
    assert.ok(summary.memory, "memory payload should be present");
    assert.ok(
      summary.memory?.whatChanged.some((line) => line.includes("Changed 1 file")),
      "memory payload should include session scope change stats",
    );
    assert.ok(
      summary.memory?.validationContext.length,
      "memory payload should include validation context",
    );
  });

  it("rejects quoted code fragments when selecting session intent and reasoning", async () => {
    const sid = randomUUID();
    await startSession(repoRoot, sid, { model: "gpt-4o" });

    const now = new Date().toISOString();
    const entry: ContextEntry = {
      schemaVersion: "1.1.0",
      id: randomUUID(),
      sessionId: sid,
      filePath: "lib/dashboard/src/pages/ContextHistory.tsx",
      astAnchor: null,
      contentHash: randomUUID(),
      lineRange: { start: 1, end: 140 },
      note: "Auto-annotated: unknown agent change — 12 hunks, 210 lines",
      author: "watcher",
      createdAt: now,
      updatedAt: now,
      severity: "low",
      tags: ["ai", "auto"],
      source: "ai",
      confidence: 0.72,
      attributionConfidence: 0.72,
      status: "mapped",
      reviewRequired: false,
      summary: {
        intent: "Added ContextHistory.tsx",
        shortSummary: "Added ContextHistory.tsx",
        changeType: "addition",
        risk: "low",
      },
      rawContext: {
        linesAdded: 210,
        linesRemoved: 10,
        fileCount: 1,
        diff: [
          '+ return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });',
          '+ if (risk === "high") return fallback; if (risk === "medium") return "warn";',
        ].join("\n"),
      },
    };

    await writeContextEntry(repoRoot, entry);
    await linkEntryToSession(repoRoot, sid, entry.id, entry.filePath);
    await closeSession(repoRoot, sid);

    const summary = await synthesiseAndWriteSessionSummary(repoRoot, sid);
    assert.ok(summary);
    assert.equal(summary.intentSource, "summary-aggregate");
    assert.ok(
      summary.intent.includes("Added ContextHistory.tsx"),
      "session intent should prefer stable entry summary text",
    );
    assert.ok(
      !summary.intent.toLowerCase().includes("minute:"),
      "session intent should not contain extracted locale-format code fragments",
    );
    assert.ok(
      !summary.intent.toLowerCase().includes("return"),
      "session intent should not contain extracted control-flow fragments",
    );
    assert.ok(
      !summary.reasoning.toLowerCase().includes("minute:"),
      "reasoning should not be built from quoted code fragments",
    );
    assert.ok(
      !summary.reasoning.toLowerCase().includes("return fallback"),
      "reasoning should ignore return-chain snippets",
    );
  });
});
