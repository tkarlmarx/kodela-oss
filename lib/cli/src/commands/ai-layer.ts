// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * AI Enhancement Layer for `kodela export --ai`
 *
 * Design constraints (from Gap 12 ticket):
 *   - Pluggable providers: swapping backends requires no core CLI code changes.
 *   - Fully optional: no hard dependency on any AI SDK package; implemented
 *     using the Node.js built-in `fetch` API (Node 18+). Zero extra imports
 *     at startup when `--ai` is not used.
 *   - No AI calls in default (non-`--ai`) mode.
 *
 * Provider resolution order (first non-empty value wins):
 *   1. `kodela.config.json` → `ai_provider.*` fields
 *   2. Environment variables: KODELA_AI_PROVIDER, KODELA_AI_API_KEY,
 *      KODELA_AI_MODEL, KODELA_AI_BASE_URL
 *   3. Built-in defaults (provider: "openai", model: "gpt-4o-mini")
 */

export type AiProviderName = "openai" | "anthropic";

/**
 * Pluggable AI provider interface.
 * Implement this to add a new backend without touching any other CLI code.
 */
export interface AiProvider {
  readonly name: AiProviderName;
  /**
   * Summarise or compress `text`.
   * @param text   The deterministic export output to enhance.
   * @param maxTokens  Optional upper bound on the response length (in tokens).
   *                   Providers map this to their native parameter.
   */
  summarise(text: string, maxTokens?: number): Promise<string>;
}

/**
 * Configuration for the AI layer.
 * All fields are optional — see module-level doc for resolution order.
 */
export type AiLayerConfig = {
  provider?: AiProviderName;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
};

export type AiLayerOptions = {
  config: AiLayerConfig;
  maxTokens?: number;
};

const SYSTEM_PROMPT =
  "You are a code-context summariser. The user will provide structured Kodela " +
  "context annotations exported from a repository. Produce a concise, readable " +
  "summary that preserves ALL high-risk, critical, and review-required entries in " +
  "full. Reduce verbosity only for low-severity entries. Keep the output suitable " +
  "for pasting directly into an AI prompt. Return only the summarised text — no " +
  "preamble, no commentary, no markdown fences.";

const DEFAULT_MODEL: Record<AiProviderName, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-20241022",
};

const DEFAULT_BASE_URL: Record<AiProviderName, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
};

// ---------------------------------------------------------------------------
// Concrete provider implementations
// ---------------------------------------------------------------------------

class OpenAiProvider implements AiProvider {
  readonly name = "openai" as const;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string,
  ) {}

  async summarise(text: string, maxTokens?: number): Promise<string> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    };
    if (maxTokens !== undefined) body["max_tokens"] = maxTokens;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`OpenAI API error ${resp.status}: ${errText}`);
    }

    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices[0]?.message.content;
    if (!content) throw new Error("OpenAI returned an empty response.");
    return content;
  }
}

class AnthropicProvider implements AiProvider {
  readonly name = "anthropic" as const;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string,
  ) {}

  async summarise(text: string, maxTokens?: number): Promise<string> {
    const url = `${this.baseUrl}/v1/messages`;
    const body = {
      model: this.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
      max_tokens: maxTokens ?? 4096,
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
    }

    const data = (await resp.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    const block = data.content.find((b) => b.type === "text");
    if (!block) throw new Error("Anthropic returned an empty response.");
    return block.text;
  }
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/**
 * Build a concrete `AiProvider` from the merged config + environment.
 *
 * Resolution order (first non-empty wins):
 *   config field → environment variable → built-in default
 *
 * Throws if no API key is available — callers should surface this as a
 * user-facing error before invoking `runAiLayer`.
 */
export function resolveProvider(config: AiLayerConfig): AiProvider {
  const providerName: AiProviderName =
    config.provider ??
    (process.env["KODELA_AI_PROVIDER"] as AiProviderName | undefined) ??
    "openai";

  if (providerName !== "openai" && providerName !== "anthropic") {
    throw new Error(
      `Unknown AI provider: "${providerName}". Supported providers: openai, anthropic.`,
    );
  }

  const apiKey =
    config.apiKey ?? process.env["KODELA_AI_API_KEY"] ?? "";

  if (!apiKey) {
    throw new Error(
      `No API key configured for AI provider "${providerName}". ` +
        `Set the KODELA_AI_API_KEY environment variable or add ` +
        `"ai_provider": { "api_key": "..." } to kodela.config.json.`,
    );
  }

  const model =
    config.model ??
    process.env["KODELA_AI_MODEL"] ??
    DEFAULT_MODEL[providerName];

  const baseUrl =
    config.baseUrl ??
    process.env["KODELA_AI_BASE_URL"] ??
    DEFAULT_BASE_URL[providerName];

  if (providerName === "anthropic") {
    return new AnthropicProvider(apiKey, model, baseUrl);
  }
  return new OpenAiProvider(apiKey, model, baseUrl);
}

// ---------------------------------------------------------------------------
// Public entry point — export summarisation
// ---------------------------------------------------------------------------

/**
 * Pass `text` through the configured AI provider for summarisation.
 *
 * This is only called when the user passes `--ai` to `kodela export`.
 * It is never invoked at module load time, so it introduces zero overhead
 * when the AI layer is not used.
 */
export async function runAiLayer(
  text: string,
  options: AiLayerOptions,
): Promise<string> {
  const provider = resolveProvider(options.config);
  return provider.summarise(text, options.maxTokens);
}

// ---------------------------------------------------------------------------
// Gap 47 — Embedding generation for semantic search
// ---------------------------------------------------------------------------

/**
 * Options for the embedding endpoint.
 * Mirrors `AiLayerConfig` but is kept separate so callers can use it without
 * constructing a full provider.
 */
export type EmbeddingOptions = {
  /** AI API key.  Falls back to KODELA_AI_API_KEY env var. */
  apiKey?: string;
  /** Base URL for the embedding endpoint.  Defaults to OpenAI. */
  baseUrl?: string;
  /**
   * Embedding model name.
   * Default: "text-embedding-3-small" (1536-dimensional, OpenAI).
   */
  model?: string;
};

/**
 * Call the OpenAI-compatible embeddings endpoint and return a float32 vector
 * for `text`.
 *
 * Only OpenAI-compatible providers are supported for embeddings (Anthropic
 * does not expose a public embeddings endpoint).  When the user has configured
 * `provider: "anthropic"` the embed call still goes to the OpenAI endpoint —
 * the caller should check and warn accordingly.
 *
 * Throws when no API key is available or the API returns an error.
 */
export async function generateEmbedding(
  text: string,
  opts: EmbeddingOptions = {},
): Promise<number[]> {
  const apiKey =
    opts.apiKey ??
    process.env["KODELA_AI_API_KEY"] ??
    "";

  if (!apiKey) {
    throw new Error(
      "No API key available for embedding generation. " +
        'Set KODELA_AI_API_KEY or add "ai_provider": { "api_key": "..." } to kodela.config.json.',
    );
  }

  const baseUrl = opts.baseUrl ?? "https://api.openai.com";
  const model = opts.model ?? "text-embedding-3-small";

  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: text }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Embedding API returned ${response.status}: ${body.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  const embedding = data.data[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("Embedding API returned no vector.");
  }

  return embedding;
}

// ---------------------------------------------------------------------------
// Gap 46 — Annotation proposal (bidirectional AI annotation loop)
// ---------------------------------------------------------------------------

/**
 * Confidence level the AI self-reports for a proposed annotation.
 *   high   — clear function name, sufficient context, obvious purpose.
 *   medium — some ambiguity about purpose or surrounding context.
 *   low    — very little context, generic code, or unusual patterns.
 */
export type ProposalConfidence = "high" | "medium" | "low";

/** The structured response returned by `callForProposal`. */
export type ProposalResponse = {
  note: string;
  confidence: ProposalConfidence;
};

const PROPOSAL_SYSTEM_PROMPT =
  "You are a code annotation assistant for Kodela. Given a code snippet, " +
  "produce a concise annotation note (1–2 paragraphs, under 150 words) that " +
  "explains what this code does, why it exists, what risks it carries, and any " +
  "important context a future maintainer would need. Be specific — avoid " +
  "generic phrases like 'this function handles X'. After writing the note, " +
  "self-assess how confident you are given the context you had.\n\n" +
  "Respond with ONLY valid JSON in this exact shape:\n" +
  '{"note":"<annotation note>","confidence":"high"|"medium"|"low"}\n' +
  "No preamble, no markdown, no extra keys.";

/**
 * Call the configured AI provider to draft an annotation note for a code
 * snippet.  Returns a structured `ProposalResponse` with the note text and a
 * self-assessed confidence level.
 *
 * If the AI response cannot be parsed as valid JSON the entire text is used
 * as the note and confidence defaults to "low".
 */
export async function callForProposal(
  codeText: string,
  opts: {
    config: AiLayerConfig;
    fnName?: string;
    filePath?: string;
  },
): Promise<ProposalResponse> {
  const provider = resolveProvider(opts.config);

  const context = [
    opts.filePath ? `File: ${opts.filePath}` : null,
    opts.fnName ? `Function: ${opts.fnName}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const userMessage =
    (context ? `${context}\n\n` : "") +
    "Code:\n```\n" +
    codeText +
    "\n```";

  // We borrow the `summarise` method by swapping the system prompt.
  // Both built-in providers accept a system-prompt override via the same
  // chat-completions / messages API; we achieve this by sub-classing the
  // provider call through a thin wrapper that replaces SYSTEM_PROMPT with
  // PROPOSAL_SYSTEM_PROMPT at call time.
  const wrappedProvider: AiProvider = {
    name: provider.name,
    async summarise(_text: string, _maxTokens?: number): Promise<string> {
      // Call the underlying fetch directly via the same logic, substituting
      // the proposal prompt.  We call the real provider's summarise method
      // with a specially-prefixed message that causes it to read the system
      // prompt from our prefix rather than the hardcoded one.
      // Strategy: reconstruct the request ourselves using the resolved
      // provider's config fields, which are exposed via the `name` property.
      return provider.summarise(
        `__KODELA_PROPOSAL_PROMPT__\n${PROPOSAL_SYSTEM_PROMPT}\n__END_PROMPT__\n${userMessage}`,
        300,
      );
    },
  };

  // Instead of the above complexity, call the real provider with its
  // summarise method but pass a user message that includes the proposal
  // system prompt inline (works well with OpenAI's chat completions, where
  // a leading system-prompt-like paragraph influences the response).
  //
  // Simpler approach: call summarise with the full prompt embedded in the
  // user turn, preceded by an inline instruction override that both OpenAI
  // and Anthropic models respect when the system prompt is generic.
  void wrappedProvider; // unused — keeping the explanation above for clarity

  const fullPrompt =
    `[SYSTEM INSTRUCTION]\n${PROPOSAL_SYSTEM_PROMPT}\n[END INSTRUCTION]\n\n${userMessage}`;

  let raw: string;
  try {
    raw = await provider.summarise(fullPrompt, 300);
  } catch (err) {
    throw new Error(
      `AI provider call failed during proposal: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Parse the JSON response.  Many models wrap JSON in markdown fences —
  // strip those before parsing.
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  try {
    const parsed = JSON.parse(stripped) as {
      note?: unknown;
      confidence?: unknown;
    };
    const note =
      typeof parsed.note === "string" && parsed.note.trim()
        ? parsed.note.trim()
        : raw.trim();
    const confidence: ProposalConfidence =
      parsed.confidence === "high" ||
      parsed.confidence === "medium" ||
      parsed.confidence === "low"
        ? parsed.confidence
        : "low";
    return { note, confidence };
  } catch {
    // Fall back: treat the whole response as the note
    return { note: raw.trim(), confidence: "low" };
  }
}
