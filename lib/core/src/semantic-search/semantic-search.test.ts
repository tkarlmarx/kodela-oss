// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  cosineSimilarity,
  hashNote,
  readEmbeddingStore,
  upsertEmbeddingRecord,
  deleteEmbeddingRecord,
  semanticSearch,
  embedTextLocal,
  buildEmbeddingIndex,
  EMBEDDINGS_FILE,
} from "./index.js";
import type { EmbeddingRecord } from "./index.js";

// ---------------------------------------------------------------------------
// Offline generation: embedTextLocal + buildEmbeddingIndex + semanticSearch
// ---------------------------------------------------------------------------

describe("offline embedding generation", () => {
  test("local embedder is deterministic, L2-normalised, and vocab-sensitive", () => {
    const a = embedTextLocal("rotate the session token on refresh");
    const a2 = embedTextLocal("rotate the session token on refresh");
    const b = embedTextLocal("render the dashboard bar chart component");
    assert.deepEqual(a, a2, "deterministic");
    assert.ok(Math.abs(Math.sqrt(a.reduce((s, x) => s + x * x, 0)) - 1) < 1e-9, "unit length");
    // Shared vocabulary → higher similarity than unrelated text.
    const aClose = embedTextLocal("refresh the session token rotation");
    assert.ok(cosineSimilarity(a, aClose) > cosineSimilarity(a, b));
  });

  test("buildEmbeddingIndex generates a searchable store; relevant entry ranks top", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-embed-"));
    try {
      const items = [
        { entryId: "e1", note: "rotate the session token on refresh to prevent replay attacks" },
        { entryId: "e2", note: "render the dashboard chart with a reusable bar component" },
        { entryId: "e3", note: "validate billing amount rounding rules at the aggregator" },
      ];
      const res = await buildEmbeddingIndex(root, items, (t) => embedTextLocal(t));
      assert.equal(res.embedded, 3);
      assert.equal(res.skipped, 0);

      // Re-run: unchanged notes are skipped (freshness via noteHash).
      const res2 = await buildEmbeddingIndex(root, items, (t) => embedTextLocal(t));
      assert.equal(res2.skipped, 3);
      assert.equal(res2.embedded, 0);

      const store = await readEmbeddingStore(root);
      assert.equal(store.length, 3);
      const hits = semanticSearch(embedTextLocal("session token refresh replay protection"), store, 3);
      assert.equal(hits[0]!.entryId, "e1", "the token/replay entry should rank first");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe("cosineSimilarity", () => {
  test("identical unit vectors return 1", () => {
    const v = [1, 0, 0];
    assert.equal(cosineSimilarity(v, v), 1);
  });

  test("orthogonal vectors return 0", () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  test("opposite unit vectors return -1", () => {
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  });

  test("zero vector returns 0", () => {
    assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  });

  test("empty arrays return 0", () => {
    assert.equal(cosineSimilarity([], []), 0);
  });

  test("mismatched lengths return 0", () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
  });

  test("similar vectors score close to 1", () => {
    const a = [0.9, 0.1];
    const b = [0.85, 0.15];
    const sim = cosineSimilarity(a, b);
    assert.ok(sim > 0.99, `expected >0.99 but got ${sim}`);
  });

  test("non-unit vectors produce same result as normalised versions", () => {
    const a = [3, 4];
    const b = [6, 8];
    const sim = cosineSimilarity(a, b);
    assert.ok(Math.abs(sim - 1) < 1e-9, `expected ~1 but got ${sim}`);
  });
});

// ---------------------------------------------------------------------------
// hashNote
// ---------------------------------------------------------------------------

describe("hashNote", () => {
  test("returns 16 hex chars", () => {
    const h = hashNote("hello");
    assert.equal(h.length, 16);
    assert.match(h, /^[0-9a-f]{16}$/);
  });

  test("same text produces same hash", () => {
    assert.equal(hashNote("abc"), hashNote("abc"));
  });

  test("different text produces different hash", () => {
    assert.notEqual(hashNote("abc"), hashNote("def"));
  });
});

// ---------------------------------------------------------------------------
// Embedding store I/O
// ---------------------------------------------------------------------------

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-sem-test-"));
  await fs.mkdir(path.join(dir, ".kodela"), { recursive: true });
  return dir;
}

describe("readEmbeddingStore", () => {
  test("returns empty array when file does not exist", async () => {
    const root = await makeTempRepo();
    const store = await readEmbeddingStore(root);
    assert.deepEqual(store, []);
  });

  test("reads back written records", async () => {
    const root = await makeTempRepo();
    const rec: EmbeddingRecord = {
      entryId: "00000000-0000-0000-0000-000000000001",
      noteHash: "abcdef1234567890",
      embedding: [0.1, 0.2, 0.3],
    };
    await fs.writeFile(
      path.join(root, EMBEDDINGS_FILE),
      JSON.stringify(rec) + "\n",
      "utf-8",
    );
    const store = await readEmbeddingStore(root);
    assert.equal(store.length, 1);
    assert.deepEqual(store[0], rec);
  });
});

describe("upsertEmbeddingRecord", () => {
  test("inserts a new record", async () => {
    const root = await makeTempRepo();
    const rec: EmbeddingRecord = {
      entryId: "00000000-0000-0000-0000-000000000001",
      noteHash: "aaaaaaaaaaaaaaaa",
      embedding: [1, 0],
    };
    await upsertEmbeddingRecord(root, rec);
    const store = await readEmbeddingStore(root);
    assert.equal(store.length, 1);
    assert.deepEqual(store[0], rec);
  });

  test("replaces an existing record with the same entryId", async () => {
    const root = await makeTempRepo();
    const id = "00000000-0000-0000-0000-000000000001";
    await upsertEmbeddingRecord(root, {
      entryId: id,
      noteHash: "old",
      embedding: [1, 0],
    });
    await upsertEmbeddingRecord(root, {
      entryId: id,
      noteHash: "new",
      embedding: [0, 1],
    });
    const store = await readEmbeddingStore(root);
    assert.equal(store.length, 1);
    assert.equal(store[0]!.noteHash, "new");
  });

  test("preserves other records when upserting one", async () => {
    const root = await makeTempRepo();
    const id1 = "00000000-0000-0000-0000-000000000001";
    const id2 = "00000000-0000-0000-0000-000000000002";
    await upsertEmbeddingRecord(root, { entryId: id1, noteHash: "h1", embedding: [1, 0] });
    await upsertEmbeddingRecord(root, { entryId: id2, noteHash: "h2", embedding: [0, 1] });
    const store = await readEmbeddingStore(root);
    assert.equal(store.length, 2);
  });
});

describe("deleteEmbeddingRecord", () => {
  test("removes the specified entry", async () => {
    const root = await makeTempRepo();
    const id = "00000000-0000-0000-0000-000000000001";
    await upsertEmbeddingRecord(root, { entryId: id, noteHash: "h1", embedding: [1, 0] });
    await deleteEmbeddingRecord(root, id);
    const store = await readEmbeddingStore(root);
    assert.equal(store.length, 0);
  });

  test("is a no-op when entry is not present", async () => {
    const root = await makeTempRepo();
    const id1 = "00000000-0000-0000-0000-000000000001";
    const id2 = "00000000-0000-0000-0000-000000000002";
    await upsertEmbeddingRecord(root, { entryId: id1, noteHash: "h1", embedding: [1, 0] });
    await deleteEmbeddingRecord(root, id2);
    const store = await readEmbeddingStore(root);
    assert.equal(store.length, 1);
  });

  test("is a no-op when store is empty", async () => {
    const root = await makeTempRepo();
    await assert.doesNotReject(
      deleteEmbeddingRecord(root, "00000000-0000-0000-0000-000000000001"),
    );
  });
});

// ---------------------------------------------------------------------------
// semanticSearch
// ---------------------------------------------------------------------------

describe("semanticSearch", () => {
  test("returns empty array for empty store", () => {
    assert.deepEqual(semanticSearch([1, 0], [], 5), []);
  });

  test("returns empty array for empty query embedding", () => {
    const rec: EmbeddingRecord = {
      entryId: "00000000-0000-0000-0000-000000000001",
      noteHash: "h1",
      embedding: [1, 0],
    };
    assert.deepEqual(semanticSearch([], [rec], 5), []);
  });

  test("ranks by cosine similarity descending", () => {
    const query = [1, 0];
    const store: EmbeddingRecord[] = [
      { entryId: "id-a", noteHash: "h1", embedding: [0, 1] },
      { entryId: "id-b", noteHash: "h2", embedding: [1, 0] },
      { entryId: "id-c", noteHash: "h3", embedding: [0.7, 0.3] },
    ];
    const hits = semanticSearch(query, store, 10);
    assert.equal(hits[0]!.entryId, "id-b");
    assert.ok(hits[0]!.similarity > hits[1]!.similarity);
  });

  test("respects topK limit", () => {
    const query = [1, 0];
    const store: EmbeddingRecord[] = Array.from({ length: 10 }, (_, i) => ({
      entryId: `id-${i}`,
      noteHash: `h${i}`,
      embedding: [Math.random(), Math.random()],
    }));
    const hits = semanticSearch(query, store, 3);
    assert.equal(hits.length, 3);
  });

  test("similarity scores are in [-1, 1]", () => {
    const query = [1, 0];
    const store: EmbeddingRecord[] = [
      { entryId: "id-a", noteHash: "h1", embedding: [0.5, 0.5] },
      { entryId: "id-b", noteHash: "h2", embedding: [-1, 0] },
    ];
    for (const hit of semanticSearch(query, store, 10)) {
      assert.ok(hit.similarity >= -1 && hit.similarity <= 1);
    }
  });

  test("identical query and stored vector yields similarity 1", () => {
    const vec = [0.6, 0.8];
    const store: EmbeddingRecord[] = [
      { entryId: "id-a", noteHash: "h1", embedding: vec },
    ];
    const hits = semanticSearch(vec, store, 1);
    assert.ok(Math.abs(hits[0]!.similarity - 1) < 1e-9);
  });
});
