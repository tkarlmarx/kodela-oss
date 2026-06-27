// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveProvider, resolveApiKey } from "./router.js";
import { DEFAULT_CONFIG, DEFAULT_PROVIDERS } from "../config/defaults.js";
import type { ProxyConfig, ProviderConfig } from "../config/loader.js";

function configWith(providers: ProviderConfig[]): ProxyConfig {
  return { ...DEFAULT_CONFIG, providers };
}

describe("resolveProvider", () => {
  test("matches a model to the provider whose prefix it starts with", () => {
    const provider = resolveProvider("claude-3-5-sonnet", DEFAULT_CONFIG);
    assert.equal(provider.name, "anthropic");
  });

  test("matches OpenAI models by the gpt- prefix", () => {
    assert.equal(resolveProvider("gpt-4o", DEFAULT_CONFIG).name, "openai");
    assert.equal(resolveProvider("o3-mini", DEFAULT_CONFIG).name, "openai");
    assert.equal(
      resolveProvider("text-embedding-3-small", DEFAULT_CONFIG).name,
      "openai",
    );
  });

  test("falls back to the first provider when no prefix matches", () => {
    const provider = resolveProvider("some-unknown-model", DEFAULT_CONFIG);
    assert.equal(provider.name, DEFAULT_CONFIG.providers[0]!.name);
  });

  test("uses DEFAULT_PROVIDERS when the config has an empty provider list", () => {
    const provider = resolveProvider("claude-3", configWith([]));
    assert.equal(provider.name, "anthropic");
    assert.deepEqual(
      DEFAULT_PROVIDERS.map((p) => p.name),
      ["openai", "anthropic"],
    );
  });

  test("respects custom provider ordering for the fallback", () => {
    const custom: ProviderConfig = {
      name: "custom",
      baseUrl: "https://example.test",
      apiKeyEnvVar: "CUSTOM_KEY",
      models: ["myorg-"],
    };
    const provider = resolveProvider("nonmatching", configWith([custom]));
    assert.equal(provider.name, "custom");
  });

  test("prefers the earliest matching provider when prefixes could overlap", () => {
    const a: ProviderConfig = { name: "openai", baseUrl: "a", apiKeyEnvVar: "A", models: ["m-"] };
    const b: ProviderConfig = { name: "anthropic", baseUrl: "b", apiKeyEnvVar: "B", models: ["m-"] };
    assert.equal(resolveProvider("m-1", configWith([a, b])).name, "openai");
  });
});

describe("resolveApiKey", () => {
  test("reads the key from the provider's configured env var", () => {
    const provider: ProviderConfig = {
      name: "custom",
      baseUrl: "https://example.test",
      apiKeyEnvVar: "KODELA_TEST_PROXY_KEY",
      models: ["x-"],
    };
    const prev = process.env["KODELA_TEST_PROXY_KEY"];
    process.env["KODELA_TEST_PROXY_KEY"] = "secret-123";
    try {
      assert.equal(resolveApiKey(provider), "secret-123");
    } finally {
      if (prev === undefined) delete process.env["KODELA_TEST_PROXY_KEY"];
      else process.env["KODELA_TEST_PROXY_KEY"] = prev;
    }
  });

  test("returns an empty string when the env var is unset", () => {
    const provider: ProviderConfig = {
      name: "custom",
      baseUrl: "https://example.test",
      apiKeyEnvVar: "KODELA_DEFINITELY_UNSET_KEY_42",
      models: ["x-"],
    };
    delete process.env["KODELA_DEFINITELY_UNSET_KEY_42"];
    assert.equal(resolveApiKey(provider), "");
  });
});
