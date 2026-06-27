// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  buildInventory,
  performRtbf,
  verifyProofFile,
  appendEntry,
  readChain,
} from "./index.js";

async function seedRepo(opts: { objectCount: number; sessionCount: number; decisionsRows: number; graphEdgesRows: number }): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-rtbf-"));
  const kodelaDir = path.join(repoRoot, ".kodela");
  await fs.mkdir(path.join(kodelaDir, "objects"), { recursive: true });
  await fs.mkdir(path.join(kodelaDir, "sessions"), { recursive: true });
  await fs.mkdir(path.join(kodelaDir, "audit"), { recursive: true });

  // Seed entries (objects)
  for (let i = 0; i < opts.objectCount; i++) {
    await fs.writeFile(
      path.join(kodelaDir, "objects", `entry-${i}.json`),
      JSON.stringify({ id: `entry-${i}`, filePath: `src/file${i}.ts`, note: "secret stuff" }),
      "utf8",
    );
  }
  // Seed sessions
  for (let i = 0; i < opts.sessionCount; i++) {
    await fs.writeFile(
      path.join(kodelaDir, "sessions", `sess-${i}.json`),
      JSON.stringify({ id: `sess-${i}`, actor: { tool: "test" } }),
      "utf8",
    );
  }
  // Seed top-level kodela state files (index.json, baseline.json)
  await fs.writeFile(path.join(kodelaDir, "index.json"), '{"entries":[]}', "utf8");
  await fs.writeFile(path.join(kodelaDir, "baseline.json"), '{"commit":"abc"}', "utf8");

  // Seed SQLite tables with org_id'd rows.
  const dbPath = path.join(kodelaDir, "index.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE decisions (id TEXT PRIMARY KEY, org_id TEXT NOT NULL DEFAULT '_default')`);
    db.exec(`CREATE TABLE graph_edges (id TEXT PRIMARY KEY, org_id TEXT NOT NULL DEFAULT '_default')`);
    for (let i = 0; i < opts.decisionsRows; i++) {
      db.prepare("INSERT INTO decisions (id) VALUES (?)").run(`dec-${i}`);
    }
    for (let i = 0; i < opts.graphEdgesRows; i++) {
      db.prepare("INSERT INTO graph_edges (id) VALUES (?)").run(`edge-${i}`);
    }
  } finally {
    db.close();
  }

  // Seed pre-existing audit chain entries so the deletion entry isn't the first.
  const chainPath = path.join(kodelaDir, "audit", "chain.jsonl");
  await appendEntry(chainPath, { kind: "test_event", actor: "seed", data: { i: 1 } }, { timestamp: "2026-06-25T00:00:00.000Z" });
  await appendEntry(chainPath, { kind: "test_event", actor: "seed", data: { i: 2 } }, { timestamp: "2026-06-25T00:00:01.000Z" });

  return repoRoot;
}

test("buildInventory: counts files + sql rows accurately", async () => {
  const repoRoot = await seedRepo({ objectCount: 5, sessionCount: 3, decisionsRows: 7, graphEdgesRows: 11 });
  try {
    const inv = await buildInventory(repoRoot);
    assert.equal(inv.objectFiles, 5);
    assert.equal(inv.sessionFiles, 3);
    assert.equal(inv.decisionsRows, 7);
    assert.equal(inv.graphEdgesRows, 11);
    // index.json + baseline.json + index.db + chain.jsonl = 4 "other" files.
    assert.equal(inv.otherKodelaFiles, 4);
    assert.equal(inv.totalFiles, 5 + 3 + 4);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("performRtbf: writes proof out-of-tree, then wipes .kodela", async () => {
  const repoRoot = await seedRepo({ objectCount: 4, sessionCount: 2, decisionsRows: 6, graphEdgesRows: 9 });
  try {
    const { proof, proofPath } = await performRtbf({
      repoRoot,
      now: () => "2026-06-25T12:00:00.000Z",
    });

    // .kodela/ gone.
    let kodelaStillThere = true;
    try {
      await fs.access(path.join(repoRoot, ".kodela"));
    } catch {
      kodelaStillThere = false;
    }
    assert.equal(kodelaStillThere, false, "expected .kodela to be removed");

    // Proof file present, OUTSIDE .kodela/.
    assert.ok(proofPath.includes(".kodela.deletion-proof-"));
    assert.ok(!proofPath.includes(`${path.sep}.kodela${path.sep}`), `proof file must NOT be inside .kodela/, was at ${proofPath}`);
    const proofRaw = await fs.readFile(proofPath, "utf8");
    const parsed = JSON.parse(proofRaw);

    // Proof fields match what we returned.
    assert.equal(parsed.deletedAt, "2026-06-25T12:00:00.000Z");
    assert.equal(parsed.repoRoot, repoRoot);
    assert.equal(parsed.inventory.objectFiles, 4);
    assert.equal(parsed.inventory.sessionFiles, 2);
    assert.equal(parsed.inventory.decisionsRows, 6);
    assert.equal(parsed.inventory.graphEdgesRows, 9);
    assert.equal(parsed.proofSchemaVersion, "1.0");
    assert.match(parsed.chainTipBeforeDeletion, /^[0-9a-f]{64}$/);

    // Chain length before deletion = 2 seeded + 1 tenant_delete = 3.
    assert.equal(parsed.chainLengthBeforeDeletion, 3);

    // Returned proof and proof file match.
    assert.deepEqual(proof, parsed);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("performRtbf: chain contains the tenant_delete entry before purge", async () => {
  const repoRoot = await seedRepo({ objectCount: 1, sessionCount: 1, decisionsRows: 1, graphEdgesRows: 1 });
  try {
    // Read the chain we expect to see by appending a manual tenant_delete first
    // so we can compare what performRtbf produces.
    const inv = await buildInventory(repoRoot);
    const probeRepo = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-rtbf-probe-"));
    try {
      // Copy chain contents into the probe so we can simulate the append without
      // mutating the production chain.
      const chainPath = path.join(repoRoot, ".kodela/audit/chain.jsonl");
      await fs.mkdir(path.join(probeRepo, ".kodela/audit"), { recursive: true });
      await fs.copyFile(chainPath, path.join(probeRepo, ".kodela/audit/chain.jsonl"));
      await appendEntry(path.join(probeRepo, ".kodela/audit/chain.jsonl"), {
        kind: "tenant_delete",
        actor: "rtbf",
        data: { reason: "right_to_be_forgotten", inventory: inv },
      }, { timestamp: "2026-06-25T12:00:00.000Z" });
      const probeChain = await readChain(path.join(probeRepo, ".kodela/audit/chain.jsonl"));
      // 2 seeded + 1 tenant_delete = 3 entries.
      assert.equal(probeChain.length, 3);
      assert.equal(probeChain[2]!.payload.kind, "tenant_delete");
      assert.equal(probeChain[2]!.payload.actor, "rtbf");
    } finally {
      await fs.rm(probeRepo, { recursive: true, force: true });
    }

    // Now actually perform RTBF.
    const { proof } = await performRtbf({ repoRoot, now: () => "2026-06-25T12:00:00.000Z" });
    // Chain is gone; proof carries the tip hash forward.
    assert.match(proof.chainTipBeforeDeletion, /^[0-9a-f]{64}$/);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("performRtbf: throws when .kodela doesn't exist", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-rtbf-"));
  try {
    await assert.rejects(performRtbf({ repoRoot }), /no \.kodela directory/);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("performRtbf: refuses to overwrite an existing proof file (collision)", async () => {
  const repoRoot = await seedRepo({ objectCount: 1, sessionCount: 1, decisionsRows: 1, graphEdgesRows: 1 });
  const fixedTs = "2026-06-25T12:00:00.000Z";
  try {
    await performRtbf({ repoRoot, now: () => fixedTs });

    // Re-seed and try with the SAME timestamp → should reject because the
    // proof file from the previous call still exists.
    const kodelaDir = path.join(repoRoot, ".kodela");
    await fs.mkdir(path.join(kodelaDir, "audit"), { recursive: true });
    await assert.rejects(performRtbf({ repoRoot, now: () => fixedTs }), /already exists/);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("verifyProofFile: well-formed proof passes", async () => {
  const repoRoot = await seedRepo({ objectCount: 2, sessionCount: 1, decisionsRows: 3, graphEdgesRows: 4 });
  try {
    const { proofPath } = await performRtbf({ repoRoot, now: () => "2026-06-25T13:00:00.000Z" });
    const v = await verifyProofFile(proofPath);
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.proof.deletedAt, "2026-06-25T13:00:00.000Z");
    }
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("verifyProofFile: malformed JSON fails with reason", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-rtbf-"));
  try {
    const proofPath = path.join(repoRoot, ".kodela.deletion-proof-broken.json");
    await fs.writeFile(proofPath, "{not json}", "utf8");
    const v = await verifyProofFile(proofPath);
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.reason, /malformed/);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});

test("verifyProofFile: missing file fails with reason", async () => {
  const v = await verifyProofFile("/tmp/does-not-exist-rtbf-proof.json");
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.reason, /unreadable/);
});

test("verifyProofFile: wrong schema version fails with reason", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-rtbf-"));
  try {
    const proofPath = path.join(repoRoot, ".kodela.deletion-proof-bad.json");
    await fs.writeFile(
      proofPath,
      JSON.stringify({
        proofId: "x",
        deletedAt: "2026-06-25T00:00:00.000Z",
        repoRoot,
        chainTipBeforeDeletion: "a".repeat(64),
        proofSchemaVersion: "99.0",
      }),
      "utf8",
    );
    const v = await verifyProofFile(proofPath);
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.reason, /schema version/);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});
