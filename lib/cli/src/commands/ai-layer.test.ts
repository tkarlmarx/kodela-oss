// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveProvider, runAiLayer } from "./ai-layer.js";
import type { AiLayerConfig } from "./ai-layer.js";

// ---------------------------------------------------------------------------
// Helpers — mock fetch
// ---------------------------------------------------------------------------

type FetchArgs = { url: string; init: RequestInit };

function installFetchMock(
  handler: (url: string, init: RequestInit) => Response,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    return handler(String(url), init ?? {});
  };
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(message, { status });
}

// ---------------------------------------------------------------------------
// resolveProvider — configuration and validation
// ---------------------------------------------------------------------------

describe("resolveProvider — missing API key", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installFetchMock(() => jsonResponse({}));
    delete process.env["KODELA_AI_API_KEY"];
    delete process.env["KODELA_AI_PROVIDER"];
    delete process.env["KODELA_AI_MODEL"];
    delete process.env["KODELA_AI_BASE_URL"];
  });

  afterEach(() => restore());

  test("throws when no API key is present in config or env", () => {
    assert.throws(
      () => resolveProvider({}),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("No API key configured"),
          `Expected 'No API key configured' in: ${err.message}`,
        );
        return true;
      },
    );
  });

  test("throws with provider name in error message", () => {
    assert.throws(
      () => resolveProvider({ provider: "anthropic" }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("anthropic"), `Expected 'anthropic' in: ${err.message}`);
        return true;
      },
    );
  });

  test("throws for unknown provider name from env", () => {
    process.env["KODELA_AI_PROVIDER"] = "unknown-llm";
    assert.throws(
      () => resolveProvider({}),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes("unknown"),
          `Expected 'unknown' in: ${err.message}`,
        );
        return true;
      },
    );
  });
});

describe("resolveProvider — provider selection", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installFetchMock(() => jsonResponse({}));
    delete process.env["KODELA_AI_PROVIDER"];
    delete process.env["KODELA_AI_API_KEY"];
    delete process.env["KODELA_AI_MODEL"];
    delete process.env["KODELA_AI_BASE_URL"];
  });

  afterEach(() => restore());

  test("defaults to openai when no provider configured", () => {
    const provider = resolveProvider({ apiKey: "sk-test" });
    assert.equal(provider.name, "openai");
  });

  test("selects anthropic when configured in config", () => {
    const provider = resolveProvider({ provider: "anthropic", apiKey: "ant-test" });
    assert.equal(provider.name, "anthropic");
  });

  test("reads provider from KODELA_AI_PROVIDER env var", () => {
    process.env["KODELA_AI_PROVIDER"] = "anthropic";
    const provider = resolveProvider({ apiKey: "ant-test" });
    assert.equal(provider.name, "anthropic");
  });

  test("reads API key from KODELA_AI_API_KEY env var", () => {
    process.env["KODELA_AI_API_KEY"] = "sk-from-env";
    const provider = resolveProvider({});
    assert.equal(provider.name, "openai");
  });

  test("config API key takes precedence over env var", () => {
    process.env["KODELA_AI_API_KEY"] = "sk-from-env";
    const provider = resolveProvider({ apiKey: "sk-from-config" });
    assert.ok(provider);
    assert.equal(provider.name, "openai");
  });

  test("config provider takes precedence over env var", () => {
    process.env["KODELA_AI_PROVIDER"] = "anthropic";
    const provider = resolveProvider({ provider: "openai", apiKey: "sk-test" });
    assert.equal(provider.name, "openai");
  });
});

// ---------------------------------------------------------------------------
// OpenAI provider — HTTP round-trip
// ---------------------------------------------------------------------------

describe("OpenAiProvider — summarise", () => {
  let restore: () => void;
  let lastRequest: FetchArgs | null = null;

  const BASE_CONFIG: AiLayerConfig = {
    provider: "openai",
    apiKey: "sk-test-key",
  };

  beforeEach(() => {
    lastRequest = null;
    delete process.env["KODELA_AI_PROVIDER"];
    delete process.env["KODELA_AI_API_KEY"];
    delete process.env["KODELA_AI_MODEL"];
    delete process.env["KODELA_AI_BASE_URL"];
  });

  afterEach(() => restore());

  test("sends POST to /v1/chat/completions with correct headers", async () => {
    restore = installFetchMock((url, init) => {
      lastRequest = { url, init };
      return jsonResponse({
        choices: [{ message: { content: "Summary text" } }],
      });
    });

    await runAiLayer("input text", { config: BASE_CONFIG });

    assert.ok(lastRequest, "fetch was not called");
    assert.ok(lastRequest!.url.includes("/v1/chat/completions"), "wrong endpoint");
    const headers = lastRequest!.init.headers as Record<string, string>;
    assert.ok(headers["Authorization"]?.startsWith("Bearer "), "missing Bearer auth");
    assert.equal(headers["Content-Type"], "application/json");
  });

  test("returns the content from the first choice", async () => {
    restore = installFetchMock(() =>
      jsonResponse({ choices: [{ message: { content: "AI enhanced summary" } }] }),
    );

    const result = await runAiLayer("some annotations", { config: BASE_CONFIG });
    assert.equal(result, "AI enhanced summary");
  });

  test("includes max_tokens in body when provided", async () => {
    let requestBody: Record<string, unknown> = {};
    restore = installFetchMock((_, init) => {
      requestBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });

    await runAiLayer("text", { config: BASE_CONFIG, maxTokens: 512 });
    assert.equal(requestBody["max_tokens"], 512);
  });

  test("omits max_tokens when not provided", async () => {
    let requestBody: Record<string, unknown> = {};
    restore = installFetchMock((_, init) => {
      requestBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });

    await runAiLayer("text", { config: BASE_CONFIG });
    assert.ok(!("max_tokens" in requestBody), "max_tokens should not be present");
  });

  test("throws on non-OK HTTP response", async () => {
    restore = installFetchMock(() => errorResponse(429, "Rate limit exceeded"));

    await assert.rejects(
      () => runAiLayer("text", { config: BASE_CONFIG }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("429"), `Expected 429 in: ${err.message}`);
        return true;
      },
    );
  });

  test("throws when choices array is empty", async () => {
    restore = installFetchMock(() => jsonResponse({ choices: [] }));

    await assert.rejects(
      () => runAiLayer("text", { config: BASE_CONFIG }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.toLowerCase().includes("empty"), `Expected 'empty' in: ${err.message}`);
        return true;
      },
    );
  });

  test("uses custom baseUrl when provided", async () => {
    let calledUrl = "";
    restore = installFetchMock((url) => {
      calledUrl = url;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });

    await runAiLayer("text", {
      config: { ...BASE_CONFIG, baseUrl: "https://my-proxy.example.com" },
    });
    assert.ok(
      calledUrl.startsWith("https://my-proxy.example.com"),
      `Expected custom baseUrl, got: ${calledUrl}`,
    );
  });

  test("uses model from config in request body", async () => {
    let requestBody: Record<string, unknown> = {};
    restore = installFetchMock((_, init) => {
      requestBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });

    await runAiLayer("text", { config: { ...BASE_CONFIG, model: "gpt-4o" } });
    assert.equal(requestBody["model"], "gpt-4o");
  });
});

// ---------------------------------------------------------------------------
// Anthropic provider — HTTP round-trip
// ---------------------------------------------------------------------------

describe("AnthropicProvider — summarise", () => {
  let restore: () => void;
  let lastRequest: FetchArgs | null = null;

  const BASE_CONFIG: AiLayerConfig = {
    provider: "anthropic",
    apiKey: "ant-test-key",
  };

  beforeEach(() => {
    lastRequest = null;
    delete process.env["KODELA_AI_PROVIDER"];
    delete process.env["KODELA_AI_API_KEY"];
    delete process.env["KODELA_AI_MODEL"];
    delete process.env["KODELA_AI_BASE_URL"];
  });

  afterEach(() => restore());

  test("sends POST to /v1/messages with correct headers", async () => {
    restore = installFetchMock((url, init) => {
      lastRequest = { url, init };
      return jsonResponse({
        content: [{ type: "text", text: "Summary" }],
      });
    });

    await runAiLayer("input text", { config: BASE_CONFIG });

    assert.ok(lastRequest, "fetch was not called");
    assert.ok(lastRequest!.url.includes("/v1/messages"), "wrong endpoint");
    const headers = lastRequest!.init.headers as Record<string, string>;
    assert.ok(headers["x-api-key"], "missing x-api-key header");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    assert.equal(headers["Content-Type"], "application/json");
  });

  test("returns text from first text content block", async () => {
    restore = installFetchMock(() =>
      jsonResponse({ content: [{ type: "text", text: "Enhanced output" }] }),
    );

    const result = await runAiLayer("annotations", { config: BASE_CONFIG });
    assert.equal(result, "Enhanced output");
  });

  test("uses provided max_tokens in request body", async () => {
    let requestBody: Record<string, unknown> = {};
    restore = installFetchMock((_, init) => {
      requestBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return jsonResponse({ content: [{ type: "text", text: "ok" }] });
    });

    await runAiLayer("text", { config: BASE_CONFIG, maxTokens: 256 });
    assert.equal(requestBody["max_tokens"], 256);
  });

  test("uses default max_tokens (4096) when not provided", async () => {
    let requestBody: Record<string, unknown> = {};
    restore = installFetchMock((_, init) => {
      requestBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return jsonResponse({ content: [{ type: "text", text: "ok" }] });
    });

    await runAiLayer("text", { config: BASE_CONFIG });
    assert.equal(requestBody["max_tokens"], 4096);
  });

  test("throws on non-OK HTTP response", async () => {
    restore = installFetchMock(() => errorResponse(401, "Invalid API key"));

    await assert.rejects(
      () => runAiLayer("text", { config: BASE_CONFIG }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("401"), `Expected 401 in: ${err.message}`);
        return true;
      },
    );
  });

  test("throws when content array has no text block", async () => {
    restore = installFetchMock(() => jsonResponse({ content: [{ type: "tool_use", id: "x" }] }));

    await assert.rejects(
      () => runAiLayer("text", { config: BASE_CONFIG }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.toLowerCase().includes("empty"), `Expected 'empty' in: ${err.message}`);
        return true;
      },
    );
  });

  test("uses custom baseUrl when provided", async () => {
    let calledUrl = "";
    restore = installFetchMock((url) => {
      calledUrl = url;
      return jsonResponse({ content: [{ type: "text", text: "ok" }] });
    });

    await runAiLayer("text", {
      config: { ...BASE_CONFIG, baseUrl: "https://local-proxy.example.com" },
    });
    assert.ok(
      calledUrl.startsWith("https://local-proxy.example.com"),
      `Expected custom baseUrl, got: ${calledUrl}`,
    );
  });
});

// ---------------------------------------------------------------------------
// runAiLayer — environment variable resolution
// ---------------------------------------------------------------------------

describe("runAiLayer — env var resolution", () => {
  let restore: () => void;

  beforeEach(() => {
    delete process.env["KODELA_AI_PROVIDER"];
    delete process.env["KODELA_AI_API_KEY"];
    delete process.env["KODELA_AI_MODEL"];
    delete process.env["KODELA_AI_BASE_URL"];
  });

  afterEach(() => restore());

  test("reads API key from KODELA_AI_API_KEY when config is empty", async () => {
    process.env["KODELA_AI_API_KEY"] = "sk-from-env";
    let calledModel = "";
    restore = installFetchMock((_, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      calledModel = String(body["model"]);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });

    const result = await runAiLayer("text", { config: {} });
    assert.equal(result, "ok");
    assert.equal(calledModel, "gpt-4o-mini");
  });

  test("reads model from KODELA_AI_MODEL env var", async () => {
    process.env["KODELA_AI_API_KEY"] = "sk-from-env";
    process.env["KODELA_AI_MODEL"] = "gpt-4-turbo";
    let calledModel = "";
    restore = installFetchMock((_, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      calledModel = String(body["model"]);
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });

    await runAiLayer("text", { config: {} });
    assert.equal(calledModel, "gpt-4-turbo");
  });

  test("reads base URL from KODELA_AI_BASE_URL env var", async () => {
    process.env["KODELA_AI_API_KEY"] = "sk-from-env";
    process.env["KODELA_AI_BASE_URL"] = "https://env-proxy.example.com";
    let calledUrl = "";
    restore = installFetchMock((url) => {
      calledUrl = url;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });

    await runAiLayer("text", { config: {} });
    assert.ok(
      calledUrl.startsWith("https://env-proxy.example.com"),
      `Expected env proxy URL, got: ${calledUrl}`,
    );
  });
});
