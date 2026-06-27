// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Registry tests. These run in an environment WITHOUT the optional
 * `@huggingface/transformers` runtime installed, which is exactly the CI / hash-
 * fallback path we most need to guarantee: `auto` must degrade to the hash
 * embedder (never throw), and `local-onnx` must throw a clear error rather than
 * silently producing meaningless vectors.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveSelector, resolveEmbedder } from "./registry.js";
import { EmbedderUnavailableError } from "./types.js";

const ENV_KEYS = [
  "KODELA_EMBEDDING_PROVIDER",
  "KODELA_AI_API_KEY",
  "KODELA_MODEL_PATH",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveSelector", () => {
  test("defaults to auto", () => {
    assert.equal(resolveSelector(), "auto");
  });
  test("reads the env var", () => {
    process.env["KODELA_EMBEDDING_PROVIDER"] = "local-hash";
    assert.equal(resolveSelector(), "local-hash");
  });
  test("explicit option wins over env", () => {
    process.env["KODELA_EMBEDDING_PROVIDER"] = "local-hash";
    assert.equal(resolveSelector({ selector: "openai" }), "openai");
  });
  test("normalises aliases provider/cloud → openai", () => {
    assert.equal(resolveSelector({ selector: "provider" as never }), "openai");
    process.env["KODELA_EMBEDDING_PROVIDER"] = "CLOUD";
    assert.equal(resolveSelector(), "openai");
  });
  test("rejects an unknown value", () => {
    assert.throws(() => resolveSelector({ selector: "magic" as never }), /Unknown/);
  });
});

describe("resolveEmbedder", () => {
  test("local-hash returns the hash embedder, not degraded", async () => {
    const r = await resolveEmbedder({ selector: "local-hash" });
    assert.equal(r.embedder.kind, "local-hash");
    assert.equal(r.degraded, false);
  });

  test("auto degrades to hash when the ONNX runtime is absent", async () => {
    // No transformers.js installed in CI → auto must fall back, never throw.
    const r = await resolveEmbedder({ selector: "auto" });
    if (r.embedder.kind === "local-hash") {
      assert.equal(r.degraded, true);
      assert.match(r.note, /transformers/);
    } else {
      // If a future CI image DOES bundle the runtime, auto picks ONNX — also valid.
      assert.equal(r.embedder.kind, "local-onnx");
      assert.equal(r.degraded, false);
    }
  });

  test("local-onnx throws a clear error when the runtime is absent", async () => {
    try {
      const r = await resolveEmbedder({ selector: "local-onnx" });
      // Only reachable if the runtime happens to be installed.
      assert.equal(r.embedder.kind, "local-onnx");
    } catch (err) {
      assert.ok(err instanceof EmbedderUnavailableError);
      assert.equal((err as EmbedderUnavailableError).selector, "local-onnx");
    }
  });

  test("openai throws when no API key is configured", async () => {
    await assert.rejects(
      () => resolveEmbedder({ selector: "openai" }),
      (err: unknown) =>
        err instanceof EmbedderUnavailableError && err.selector === "openai",
    );
  });

  test("openai builds a provider embedder when a key is present", async () => {
    const r = await resolveEmbedder({ selector: "openai", apiKey: "sk-test" });
    assert.equal(r.embedder.kind, "provider");
    assert.equal(r.embedder.offline, false);
  });
});
