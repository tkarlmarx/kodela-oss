// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { logCaptureDenial, readChain, verifyChain } from "./index.js";
import type { CaptureDecision } from "../policy/capture-policy.js";

async function tmpRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kodela-capture-deny-"));
}

const DENIAL_PATH: CaptureDecision = { allow: false, reason: "path_excluded", detail: "path matches an excluded glob" };
const DENIAL_AGENT: CaptureDecision = { allow: false, reason: "agent_denied", detail: "tool 'evil' is in deny list" };
const ALLOW: CaptureDecision = { allow: true };

test("logCaptureDenial writes a capture_denied entry to the chain", async () => {
  const repoRoot = await tmpRepo();
  try {
    await logCaptureDenial({
      repoRoot,
      decision: DENIAL_PATH,
      context: {
        actor: "org_test",
        sessionId: "sess-1",
        filePath: "secrets/foo.txt",
        agentTool: "claude-code",
      },
    });
    const chain = await readChain(path.join(repoRoot, ".kodela/audit/chain.jsonl"));
    assert.equal(chain.length, 1);
    assert.equal(chain[0]!.payload.kind, "capture_denied");
    assert.equal(chain[0]!.payload.actor, "org_test");
    assert.equal(chain[0]!.payload.data.reason, "path_excluded");
    assert.equal(chain[0]!.payload.data.filePath, "secrets/foo.txt");
    assert.equal(chain[0]!.payload.data.agentTool, "claude-code");
    assert.equal(chain[0]!.payload.data.sessionId, "sess-1");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("logCaptureDenial is a no-op for allow decisions (defensive guard)", async () => {
  const repoRoot = await tmpRepo();
  try {
    await logCaptureDenial({ repoRoot, decision: ALLOW, context: {} });
    let chain;
    try {
      chain = await readChain(path.join(repoRoot, ".kodela/audit/chain.jsonl"));
    } catch {
      chain = [];
    }
    assert.equal(chain.length, 0, "allow decisions must never produce a chain entry");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("logCaptureDenial defaults missing fields to 'unknown' / null", async () => {
  const repoRoot = await tmpRepo();
  try {
    await logCaptureDenial({ repoRoot, decision: DENIAL_AGENT, context: {} });
    const chain = await readChain(path.join(repoRoot, ".kodela/audit/chain.jsonl"));
    assert.equal(chain.length, 1);
    assert.equal(chain[0]!.payload.actor, "unknown");
    assert.equal(chain[0]!.payload.data.sessionId, null);
    assert.equal(chain[0]!.payload.data.filePath, null);
    assert.equal(chain[0]!.payload.data.agentTool, null);
    assert.equal(chain[0]!.payload.data.reason, "agent_denied");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("multiple capture_denied entries chain correctly + verifyChain passes", async () => {
  const repoRoot = await tmpRepo();
  try {
    await logCaptureDenial({ repoRoot, decision: DENIAL_PATH, context: { filePath: "secrets/a.txt" } });
    await logCaptureDenial({ repoRoot, decision: DENIAL_AGENT, context: { agentTool: "evil" } });
    await logCaptureDenial({ repoRoot, decision: DENIAL_PATH, context: { filePath: "secrets/b.txt" } });
    const chain = await readChain(path.join(repoRoot, ".kodela/audit/chain.jsonl"));
    assert.equal(chain.length, 3);
    const verdict = verifyChain(chain);
    assert.equal(verdict.ok, true);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("logCaptureDenial captures extra forensics fields", async () => {
  const repoRoot = await tmpRepo();
  try {
    await logCaptureDenial({
      repoRoot,
      decision: DENIAL_PATH,
      context: {
        filePath: "secrets/x",
        extra: { requestId: "req-99", remoteAddr: "10.0.0.1" },
      },
    });
    const chain = await readChain(path.join(repoRoot, ".kodela/audit/chain.jsonl"));
    assert.equal(chain[0]!.payload.data.requestId, "req-99");
    assert.equal(chain[0]!.payload.data.remoteAddr, "10.0.0.1");
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("logCaptureDenial swallows errors silently (best-effort write)", async () => {
  // Pass a repoRoot under a file (not a dir) — fs.mkdir errors fast with
  // ENOTDIR. logCaptureDenial must not propagate; the surrounding handler
  // relies on this best-effort contract.
  const tmpRoot = await tmpRepo();
  try {
    const filePath = path.join(tmpRoot, "not-a-dir");
    await fs.writeFile(filePath, "i am a file", "utf8");
    // Try to use the file as if it were a repo root — mkdir under it fails.
    await assert.doesNotReject(
      logCaptureDenial({
        repoRoot: filePath,
        decision: DENIAL_PATH,
        context: { filePath: "anywhere" },
      }),
    );
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
