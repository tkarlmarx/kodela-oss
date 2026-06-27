// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  writeSession,
  readSession,
  appendEntryToSession,
  closeSession,
  listSessions,
} from "./storage.js";
import type { KodelaSession } from "../schema/index.js";

const UUID_A = "00000000-0000-4000-a000-000000000001";
const UUID_B = "00000000-0000-4000-a000-000000000002";
const UUID_C = "00000000-0000-4000-a000-000000000003";

function makeSession(overrides: Partial<KodelaSession> = {}): KodelaSession {
  return {
    id: "test-session-123",
    startedAt: "2025-01-01T00:00:00.000Z",
    entries: [],
    aggregatedRisk: "low",
    filesChanged: [],
    ...overrides,
  };
}

let tmpRoot: string;

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-session-test-"));
  await fs.mkdir(path.join(tmpRoot, ".kodela", "sessions"), { recursive: true });
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("writeSession / readSession", () => {
  it("writes and reads back a minimal session", async () => {
    const session = makeSession({ id: "ws-read-test" });
    await writeSession(tmpRoot, session);
    const result = await readSession(tmpRoot, "ws-read-test");
    assert.ok(result);
    assert.equal(result.id, "ws-read-test");
    assert.equal(result.aggregatedRisk, "low");
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.filesChanged, []);
  });

  it("returns null for a non-existent session", async () => {
    const result = await readSession(tmpRoot, "does-not-exist");
    assert.equal(result, null);
  });

  it("writes a session with all optional fields", async () => {
    const session = makeSession({
      id: "ws-full-test",
      endedAt: "2025-01-01T01:00:00.000Z",
      model: "claude-opus-4",
      entries: [UUID_A, UUID_B],
      goal: "Refactor auth middleware",
      aggregatedRisk: "high",
      filesChanged: ["src/auth.ts", "src/middleware.ts"],
      actor: {
        tool: "vscode-copilot",
        model: "gpt-4o",
        author: "alice",
      },
      intent: {
        userPrompt: "stabilize session capture",
        synthesised: "Developer implemented VS Code participant capture flow",
        source: "copilot-lm-api",
        confidence: 0.88,
        updatedAt: "2025-01-01T01:00:00.000Z",
      },
      annotation: {
        reasoning: "Captured first 500 chars of assistant response",
        source: "vscode-chat-participant",
        updatedAt: "2025-01-01T00:30:00.000Z",
      },
      git: {
        start: {
          branch: "feature/capture",
          headCommit: "abc123",
          author: "alice",
          capturedAt: "2025-01-01T00:00:00.000Z",
        },
        end: {
          branch: "feature/capture",
          headCommit: "def456",
          author: "alice",
          filesChanged: ["src/auth.ts"],
          diffStats: { workingTree: 1, index: 0, merge: 0, total: 1 },
          capturedAt: "2025-01-01T01:00:00.000Z",
        },
      },
    });
    await writeSession(tmpRoot, session);
    const result = await readSession(tmpRoot, "ws-full-test");
    assert.ok(result);
    assert.equal(result.model, "claude-opus-4");
    assert.equal(result.goal, "Refactor auth middleware");
    assert.equal(result.aggregatedRisk, "high");
    assert.deepEqual(result.entries, [UUID_A, UUID_B]);
    assert.deepEqual(result.filesChanged, ["src/auth.ts", "src/middleware.ts"]);
    assert.equal(result.actor?.tool, "vscode-copilot");
    assert.equal(result.intent?.source, "copilot-lm-api");
    assert.equal(result.intent?.confidence, 0.88);
    assert.equal(result.annotation?.source, "vscode-chat-participant");
    assert.equal(result.git?.start?.headCommit, "abc123");
    assert.equal(result.git?.end?.diffStats?.total, 1);
  });

  it("overwrites an existing session on repeated write", async () => {
    const s1 = makeSession({ id: "ws-overwrite", aggregatedRisk: "low" });
    await writeSession(tmpRoot, s1);
    const s2 = makeSession({ id: "ws-overwrite", aggregatedRisk: "critical" });
    await writeSession(tmpRoot, s2);
    const result = await readSession(tmpRoot, "ws-overwrite");
    assert.ok(result);
    assert.equal(result.aggregatedRisk, "critical");
  });
});

describe("appendEntryToSession", () => {
  it("creates a new session when one does not exist", async () => {
    await appendEntryToSession(tmpRoot, "append-new-sess", UUID_A, "src/foo.ts");
    const result = await readSession(tmpRoot, "append-new-sess");
    assert.ok(result);
    assert.deepEqual(result.entries, [UUID_A]);
    assert.deepEqual(result.filesChanged, ["src/foo.ts"]);
  });

  it("appends entry and file to existing session", async () => {
    await writeSession(tmpRoot, makeSession({ id: "append-existing", entries: [UUID_A], filesChanged: ["src/a.ts"] }));
    await appendEntryToSession(tmpRoot, "append-existing", UUID_B, "src/b.ts");
    const result = await readSession(tmpRoot, "append-existing");
    assert.ok(result);
    assert.deepEqual(result.entries, [UUID_A, UUID_B]);
    assert.deepEqual(result.filesChanged, ["src/a.ts", "src/b.ts"]);
  });

  it("deduplicates entry UUID on repeated calls", async () => {
    await appendEntryToSession(tmpRoot, "append-dedup-entry", UUID_A, "src/x.ts");
    await appendEntryToSession(tmpRoot, "append-dedup-entry", UUID_A, "src/x.ts");
    const result = await readSession(tmpRoot, "append-dedup-entry");
    assert.ok(result);
    assert.equal(result.entries.length, 1);
    assert.equal(result.filesChanged.length, 1);
  });

  it("deduplicates filePath but allows new entry UUID", async () => {
    await appendEntryToSession(tmpRoot, "append-dedup-fp", UUID_A, "src/shared.ts");
    await appendEntryToSession(tmpRoot, "append-dedup-fp", UUID_B, "src/shared.ts");
    const result = await readSession(tmpRoot, "append-dedup-fp");
    assert.ok(result);
    assert.equal(result.entries.length, 2);
    assert.equal(result.filesChanged.length, 1);
  });

  it("handles session IDs with hyphens and underscores", async () => {
    await appendEntryToSession(tmpRoot, "my_session-2025", UUID_C, "src/bar.ts");
    const result = await readSession(tmpRoot, "my_session-2025");
    assert.ok(result);
    assert.deepEqual(result.entries, [UUID_C]);
  });
});

describe("closeSession", () => {
  it("stamps endedAt on an open session", async () => {
    await writeSession(tmpRoot, makeSession({ id: "close-test-basic" }));
    const before = Date.now();
    const result = await closeSession(tmpRoot, "close-test-basic");
    const after = Date.now();
    assert.ok(result);
    assert.ok(result.endedAt);
    const ts = new Date(result.endedAt).getTime();
    assert.ok(ts >= before && ts <= after);
  });

  it("overrides aggregatedRisk when provided", async () => {
    await writeSession(tmpRoot, makeSession({ id: "close-risk-override" }));
    const result = await closeSession(tmpRoot, "close-risk-override", { aggregatedRisk: "critical" });
    assert.ok(result);
    assert.equal(result.aggregatedRisk, "critical");
  });

  it("sets goal when provided", async () => {
    await writeSession(tmpRoot, makeSession({ id: "close-goal-test" }));
    const result = await closeSession(tmpRoot, "close-goal-test", { goal: "Add payment retry logic" });
    assert.ok(result);
    assert.equal(result.goal, "Add payment retry logic");
  });

  it("returns null for non-existent session", async () => {
    const result = await closeSession(tmpRoot, "close-no-session");
    assert.equal(result, null);
  });

  it("persists the closed state to disk", async () => {
    await writeSession(tmpRoot, makeSession({ id: "close-persist-test" }));
    await closeSession(tmpRoot, "close-persist-test", { aggregatedRisk: "medium" });
    const disk = await readSession(tmpRoot, "close-persist-test");
    assert.ok(disk);
    assert.ok(disk.endedAt);
    assert.equal(disk.aggregatedRisk, "medium");
  });
});

describe("listSessions", () => {
  let listRoot: string;

  before(async () => {
    listRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-list-sessions-"));
    await fs.mkdir(path.join(listRoot, ".kodela", "sessions"), { recursive: true });
  });

  after(async () => {
    await fs.rm(listRoot, { recursive: true, force: true });
  });

  it("returns empty array when sessions directory does not exist", async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-empty-"));
    try {
      const result = await listSessions(emptyRoot);
      assert.deepEqual(result, []);
    } finally {
      await fs.rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it("returns all written sessions sorted by startedAt", async () => {
    await writeSession(listRoot, makeSession({ id: "list-s2", startedAt: "2025-02-01T00:00:00.000Z" }));
    await writeSession(listRoot, makeSession({ id: "list-s1", startedAt: "2025-01-01T00:00:00.000Z" }));
    await writeSession(listRoot, makeSession({ id: "list-s3", startedAt: "2025-03-01T00:00:00.000Z" }));
    const result = await listSessions(listRoot);
    assert.equal(result.length, 3);
    assert.equal(result[0].id, "list-s1");
    assert.equal(result[1].id, "list-s2");
    assert.equal(result[2].id, "list-s3");
  });

  it("skips non-JSON files in the sessions directory", async () => {
    await fs.writeFile(path.join(listRoot, ".kodela", "sessions", "README.txt"), "ignore me");
    const result = await listSessions(listRoot);
    assert.equal(result.filter(s => s.id.startsWith("list-")).length, 3);
  });

  it("skips malformed JSON files without throwing", async () => {
    await fs.writeFile(path.join(listRoot, ".kodela", "sessions", "corrupt.json"), "{ invalid");
    const result = await listSessions(listRoot);
    assert.ok(Array.isArray(result));
    assert.equal(result.find(s => s.id === "corrupt"), undefined);
  });
});
