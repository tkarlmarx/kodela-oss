// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHashEmbedder, HASH_DIM } from "./hash.js";

describe("createHashEmbedder", () => {
  test("produces an L2-normalised vector of the configured dim", async () => {
    const e = createHashEmbedder();
    assert.equal(e.dim, HASH_DIM);
    assert.equal(e.kind, "local-hash");
    assert.equal(e.offline, true);

    const v = await e.embed("session token rotation");
    assert.equal(v.length, HASH_DIM);
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(mag - 1) < 1e-6, "vector is unit length");
  });

  test("is deterministic — same text → same vector", async () => {
    const e = createHashEmbedder();
    const a = await e.embed("hello world");
    const b = await e.embed("hello world");
    assert.deepEqual(a, b);
  });

  test("shared vocabulary scores higher than disjoint vocabulary", async () => {
    const e = createHashEmbedder();
    const dot = (x: number[], y: number[]) => x.reduce((s, xi, i) => s + xi * (y[i] ?? 0), 0);
    const base = await e.embed("database migration schema");
    const near = await e.embed("schema migration plan");
    const far = await e.embed("frontend button colour");
    assert.ok(dot(base, near) > dot(base, far));
  });

  test("embedBatch matches per-item embed", async () => {
    const e = createHashEmbedder();
    const texts = ["alpha beta", "gamma delta"];
    const batch = await e.embedBatch!(texts);
    for (let i = 0; i < texts.length; i++) {
      assert.deepEqual(batch[i], await e.embed(texts[i]!));
    }
  });

  test("honours a custom dimension", async () => {
    const e = createHashEmbedder(64);
    assert.equal(e.dim, 64);
    assert.equal((await e.embed("x y z")).length, 64);
  });
});
