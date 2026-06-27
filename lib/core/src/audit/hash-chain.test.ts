// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  appendEntry,
  readChain,
  verifyChain,
  verifyChainAt,
  createEntry,
  hashPayload,
  type AuditEntry,
  type AuditPayload,
} from "./hash-chain.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kodela-audit-"));
}

function basePayload(kind: AuditPayload["kind"], data: Record<string, unknown> = {}): AuditPayload {
  return { kind, actor: "org_test", data };
}

test("genesis entry: prevHash is 64 zeros, seq is 1", async () => {
  const dir = await tmpDir();
  try {
    const chain = path.join(dir, "chain.jsonl");
    const entry = await appendEntry(chain, basePayload("test_event", { i: 1 }), { timestamp: "2026-06-25T00:00:00.000Z" });
    assert.equal(entry.prevHash, "0".repeat(64));
    assert.equal(entry.seq, 1);
    assert.match(entry.entryHash, /^[0-9a-f]{64}$/);
    assert.equal(entry.payloadHash, hashPayload(entry.payload));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("each new entry links to the previous via prevHash", async () => {
  const dir = await tmpDir();
  try {
    const chain = path.join(dir, "chain.jsonl");
    const a = await appendEntry(chain, basePayload("test_event", { i: 1 }), { timestamp: "2026-06-25T00:00:00.000Z" });
    const b = await appendEntry(chain, basePayload("test_event", { i: 2 }), { timestamp: "2026-06-25T00:00:01.000Z" });
    const c = await appendEntry(chain, basePayload("test_event", { i: 3 }), { timestamp: "2026-06-25T00:00:02.000Z" });
    assert.equal(b.prevHash, a.entryHash);
    assert.equal(c.prevHash, b.entryHash);
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.equal(c.seq, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("verifyChainAt: clean chain passes", async () => {
  const dir = await tmpDir();
  try {
    const chain = path.join(dir, "chain.jsonl");
    for (let i = 1; i <= 5; i++) {
      await appendEntry(chain, basePayload("annotate_file", { i }), { timestamp: `2026-06-25T00:00:0${i - 1}.000Z` });
    }
    const result = await verifyChainAt(chain);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.entryCount, 5);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("verifyChainAt: empty file passes with entryCount 0", async () => {
  const dir = await tmpDir();
  try {
    const chain = path.join(dir, "chain.jsonl");
    const r = await verifyChainAt(chain);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.entryCount, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("verifyChain detects payload tampering (payloadHash mismatch)", async () => {
  const dir = await tmpDir();
  try {
    const chain = path.join(dir, "chain.jsonl");
    await appendEntry(chain, basePayload("test_event", { i: 1 }), { timestamp: "2026-06-25T00:00:00.000Z" });
    await appendEntry(chain, basePayload("test_event", { i: 2 }), { timestamp: "2026-06-25T00:00:01.000Z" });
    await appendEntry(chain, basePayload("test_event", { i: 3 }), { timestamp: "2026-06-25T00:00:02.000Z" });

    // Tamper: modify the middle entry's payload in place without recomputing its hash.
    const raw = await fs.readFile(chain, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l) as AuditEntry);
    parsed[1]!.payload = { ...parsed[1]!.payload, data: { tampered: true } };
    await fs.writeFile(chain, parsed.map((p) => JSON.stringify(p)).join("\n") + "\n");

    const r = await verifyChainAt(chain);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.brokenAtSeq, 2);
      assert.match(r.reason, /payload tampered/i);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("verifyChain detects entry hash tampering", async () => {
  const dir = await tmpDir();
  try {
    const chain = path.join(dir, "chain.jsonl");
    await appendEntry(chain, basePayload("test_event", { i: 1 }), { timestamp: "2026-06-25T00:00:00.000Z" });
    const e2 = await appendEntry(chain, basePayload("test_event", { i: 2 }), { timestamp: "2026-06-25T00:00:01.000Z" });

    const raw = await fs.readFile(chain, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l) as AuditEntry);
    // Replace e2's entryHash with garbage but leave payload alone.
    parsed[1]!.entryHash = "f".repeat(64);
    void e2;
    await fs.writeFile(chain, parsed.map((p) => JSON.stringify(p)).join("\n") + "\n");

    const r = await verifyChainAt(chain);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.brokenAtSeq, 2);
      assert.match(r.reason, /entryHash tampered/i);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("verifyChain detects deleted (missing seq) entry", async () => {
  const dir = await tmpDir();
  try {
    const chain = path.join(dir, "chain.jsonl");
    await appendEntry(chain, basePayload("test_event", { i: 1 }), { timestamp: "2026-06-25T00:00:00.000Z" });
    await appendEntry(chain, basePayload("test_event", { i: 2 }), { timestamp: "2026-06-25T00:00:01.000Z" });
    await appendEntry(chain, basePayload("test_event", { i: 3 }), { timestamp: "2026-06-25T00:00:02.000Z" });

    // Drop the middle entry.
    const raw = await fs.readFile(chain, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const remaining = [lines[0]!, lines[2]!];
    await fs.writeFile(chain, remaining.join("\n") + "\n");

    const r = await verifyChainAt(chain);
    assert.equal(r.ok, false);
    if (!r.ok) {
      // seq 1 still passes; seq 3 fails because expected seq was 2.
      assert.equal(r.brokenAtSeq, 3);
      assert.match(r.reason, /seq gap/i);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("hashPayload is deterministic and key-order-independent", () => {
  const p1 = { kind: "test_event" as const, actor: "org_a", data: { a: 1, b: 2 } };
  const p2 = { kind: "test_event" as const, actor: "org_a", data: { b: 2, a: 1 } };
  assert.equal(hashPayload(p1), hashPayload(p2));
});

test("createEntry pure helper produces same hash as appendEntry", async () => {
  const dir = await tmpDir();
  try {
    const chain = path.join(dir, "chain.jsonl");
    const ts = "2026-06-25T00:00:00.000Z";
    const id = "11111111-1111-1111-1111-111111111111";
    const appended = await appendEntry(chain, basePayload("test_event", { i: 1 }), { timestamp: ts, id });
    const pure = createEntry({ prevEntry: null, payload: basePayload("test_event", { i: 1 }), timestamp: ts, id });
    assert.deepEqual(appended, pure);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readChain returns [] for a missing file (no error)", async () => {
  const dir = await tmpDir();
  try {
    const r = await readChain(path.join(dir, "does-not-exist.jsonl"));
    assert.deepEqual(r, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
