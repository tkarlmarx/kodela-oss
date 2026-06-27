// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 53 — Reasoning Extraction Engine
 *
 * Converts AI activity (a diff, an existing entry, a hook transcript) into a
 * typed `ReasoningObject`: structured intent, decision logic, considered
 * alternatives, and a confidence score.
 *
 * Three extraction paths:
 *   1. "hook"          — PostToolUse payload with rawDiff present
 *   2. "prompt"        — explicit call with a diff or existing entry
 *   3. "diff-inference" — deterministic fallback; no AI call required
 *
 * Pure functions where possible; side effects (AI calls) isolated in
 * `extractReasoning` and clearly annotated.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ReasoningConfidenceSchema = z.enum(["high", "medium", "low"]);
export type ReasoningConfidence = z.infer<typeof ReasoningConfidenceSchema>;

export const ExtractionMethodSchema = z.enum([
  "hook",
  "prompt",
  "diff-inference",
  "manual",
  "mcp",
]);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

/**
 * Gap 127 — Distinguishes how this reasoning object was produced.
 *   "ai"       — an LLM call succeeded and the JSON was parsed correctly.
 *   "heuristic" — no AI key was available; deterministic fallback was used.
 *   "mcp"      — reasoning was self-reported by an AI tool via kodela_annotate.
 */
export const ReasoningSourceSchema = z.enum(["ai", "heuristic", "mcp"]);
export type ReasoningSource = z.infer<typeof ReasoningSourceSchema>;

/**
 * Gap 53 — Typed reasoning artefact attached to a ContextEntry.
 *
 * All fields except `intent`, `confidence`, `extractedAt`, and
 * `extractionMethod` are optional so that the fallback path can produce a
 * minimal valid object without hallucinating content.
 */
export const ReasoningObjectSchema = z.object({
  /**
   * One sentence: why was this code written / what was the intent?
   * Always present — even the fallback path constructs this from the file
   * path and note.
   */
  intent: z.string().min(1),
  /**
   * 2–4 sentences: decision logic and tradeoffs.
   * Empty string when the fallback path is used (no hallucination).
   */
  reasoning: z.string(),
  /**
   * Other approaches the AI considered. May be empty.
   */
  alternatives: z.array(z.string()),
  /**
   * AI's self-assessed reliability of this explanation.
   */
  confidence: ReasoningConfidenceSchema,
  /**
   * ISO-8601 timestamp of when extraction ran.
   */
  extractedAt: z.string().datetime(),
  /**
   * Which extraction path produced this object.
   */
  extractionMethod: ExtractionMethodSchema,
  /**
   * The full AI response before parsing — stored for debugging / manual review.
   * Absent when the fallback inference path was used.
   */
  raw: z.string().optional(),
  /**
   * Gap 127 — How this reasoning object was produced.
   * "ai"        — LLM call succeeded.
   * "heuristic" — no API key; deterministic fallback used.
   * "mcp"       — self-reported via kodela_annotate MCP tool.
   * Optional for backward compatibility with existing entries.
   */
  source: ReasoningSourceSchema.optional(),
});

export type ReasoningObject = z.infer<typeof ReasoningObjectSchema>;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_INSTRUCTION =
  "You are a code-reasoning extractor for Kodela. " +
  "Given information about a code change, produce a structured JSON explanation. " +
  "Be concise and specific — avoid generic phrases. " +
  "Respond ONLY with valid JSON and no other text. No markdown fences.\n\n" +
  "Required JSON shape:\n" +
  '{"intent":"<one sentence: why was this written>","reasoning":"<2-4 sentences: decision logic>","alternatives":["<other approach considered>"],"confidence":"high"|"medium"|"low"}\n\n' +
  "Rules:\n" +
  "- intent: 1 sentence, active voice, no filler words.\n" +
  "- reasoning: 2–4 sentences covering tradeoffs; empty string if unknown.\n" +
  "- alternatives: array of strings, may be empty []\n" +
  "- confidence: high = clear purpose; medium = some ambiguity; low = very little context.";

/**
 * Build the extraction prompt for the hook path (diff available).
 */
export function buildExtractionPrompt(
  filePath: string,
  diff?: string,
  note?: string,
): string {
  const parts: string[] = [
    `[SYSTEM INSTRUCTION]\n${EXTRACTION_SYSTEM_INSTRUCTION}\n[END INSTRUCTION]`,
    "",
    `File: ${filePath}`,
  ];

  if (note) {
    parts.push(`Existing annotation note: ${note}`);
  }

  if (diff) {
    const diffPreview =
      diff.length > 3000 ? diff.slice(0, 3000) + "\n... (truncated)" : diff;
    parts.push(`\nDiff:\n\`\`\`diff\n${diffPreview}\n\`\`\``);
  }

  parts.push(
    "\nBased on the above, produce the JSON reasoning object as instructed.",
  );

  return parts.join("\n");
}

/**
 * Retry prompt used when the first AI response fails JSON validation.
 * More constrained to reduce hallucination risk.
 */
export function buildRetryPrompt(filePath: string, note?: string): string {
  return (
    `[SYSTEM INSTRUCTION]\n${EXTRACTION_SYSTEM_INSTRUCTION}\n[END INSTRUCTION]\n\n` +
    `File: ${filePath}\n` +
    (note ? `Note: ${note}\n` : "") +
    "\nRespond ONLY with valid JSON. No prose, no markdown, no explanation outside the JSON object."
  );
}

// ---------------------------------------------------------------------------
// Fallback inference (no AI call)
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic `ReasoningObject` from file path + note without
 * any AI call. Used when:
 *   - `KODELA_AI_API_KEY` is not set
 *   - Two consecutive AI calls both failed to return valid JSON
 *   - The caller explicitly requests the fallback
 *
 * Never returns an empty `intent` — always constructs something meaningful
 * from the available context. Never hallucinates `reasoning` or
 * `alternatives` (both left explicitly empty).
 */
export function buildFallbackReasoning(
  filePath: string,
  note?: string,
): ReasoningObject {
  const intentBase = note
    ? note.length > 120
      ? note.slice(0, 117) + "..."
      : note
    : `Modified ${filePath}`;

  return {
    intent: intentBase,
    reasoning: "",
    alternatives: [],
    confidence: "low",
    extractedAt: new Date().toISOString(),
    extractionMethod: "diff-inference",
    source: "heuristic",
  };
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw AI response string as a `ReasoningObject`.
 *
 * Strips markdown code fences before parsing. Returns `null` if the response
 * does not conform to `ReasoningObjectSchema` (missing `intent`, wrong
 * `confidence` value, etc.).
 */
export function validateReasoningResponse(
  raw: string,
  extractionMethod: ExtractionMethod = "prompt",
): ReasoningObject | null {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;

  const result = ReasoningObjectSchema.safeParse({
    intent:
      typeof obj["intent"] === "string" && obj["intent"].trim()
        ? obj["intent"].trim()
        : undefined,
    reasoning:
      typeof obj["reasoning"] === "string" ? obj["reasoning"].trim() : "",
    alternatives: Array.isArray(obj["alternatives"])
      ? obj["alternatives"].filter((a) => typeof a === "string")
      : [],
    confidence: obj["confidence"],
    extractedAt: new Date().toISOString(),
    extractionMethod,
    raw,
    source: "ai",
  });

  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

/**
 * Derive the AI provider name from a model identifier string.
 *
 * Rules:
 *   - "claude-*"             → "anthropic"   (Claude Code, Anthropic API)
 *   - "gpt-*", "o1*", "o3*" → "openai"      (OpenAI, Codex, Cursor-OpenAI, Windsurf-OpenAI)
 *   - "gemini-*"             → "google"      (Google Gemini)
 *   - Unknown or absent      → undefined
 */
export function inferProviderFromModel(
  model?: string,
): "anthropic" | "openai" | "google" | undefined {
  if (!model) return undefined;
  if (model.startsWith("claude-")) return "anthropic";
  if (
    model.startsWith("gpt-") ||
    model.startsWith("o1") ||
    model.startsWith("o3")
  )
    return "openai";
  if (model.startsWith("gemini-")) return "google";
  return undefined;
}

/**
 * The result of credential resolution — everything `callAiForReasoning`
 * needs, including a human-readable label for debug logging.
 */
export type ResolvedReasoningCredentials = {
  apiKey: string;
  provider: string;
  model?: string;
  baseUrl?: string;
  /** Which source provided the API key (used for debug logging). */
  credentialSource:
    | "explicit-config"
    | "KODELA_AI_API_KEY"
    | "ANTHROPIC_API_KEY"
    | "OPENAI_API_KEY"
    | "GEMINI_API_KEY"
    | "GOOGLE_API_KEY"
    | "none";
};

/**
 * Resolve AI credentials and provider config for reasoning extraction.
 *
 * Priority order (first non-empty apiKey wins):
 *   1. `aiConfig.apiKey`          — explicit caller config
 *   2. `KODELA_AI_API_KEY`        — Kodela-specific env var
 *   3. Native provider env vars   — session hint used as tiebreaker when both
 *      Anthropic and OpenAI keys are present:
 *      a. hint "anthropic"  + `ANTHROPIC_API_KEY`  → use it (Claude Code, Anthropic API)
 *      b. hint "openai"     + `OPENAI_API_KEY`     → use it (OpenAI, Codex, Cursor, Windsurf)
 *      c. hint "google"     + `GEMINI_API_KEY`
 *                           or `GOOGLE_API_KEY`    → use it (Google Gemini)
 *      d. `ANTHROPIC_API_KEY`  (no hint / unmatched hint)
 *      e. `OPENAI_API_KEY`
 *      f. `GEMINI_API_KEY` or `GOOGLE_API_KEY`
 *
 * When native env vars are used, the session model is adopted as the default
 * model (so reasoning extraction reuses the same model the dev was vibe-coding
 * with), unless the caller already supplied an explicit `aiConfig.model`.
 */
export function resolveReasoningCredentials(
  aiConfig?: ExtractReasoningOptions["aiConfig"],
  sessionProviderHint?: string,
  sessionModel?: string,
): ResolvedReasoningCredentials {
  // 1. Explicit config — highest priority
  if (aiConfig?.apiKey) {
    console.debug(
      "[kodela/reasoning] credential source: explicit-config" +
        (aiConfig.provider ? ` (provider: ${aiConfig.provider})` : ""),
    );
    return {
      apiKey: aiConfig.apiKey,
      provider: aiConfig.provider ?? process.env["KODELA_AI_PROVIDER"] ?? "openai",
      model: aiConfig.model ?? process.env["KODELA_AI_MODEL"],
      baseUrl: aiConfig.baseUrl ?? process.env["KODELA_AI_BASE_URL"],
      credentialSource: "explicit-config",
    };
  }

  // 2. KODELA_AI_API_KEY — Kodela-specific override
  const kodelaKey = process.env["KODELA_AI_API_KEY"];
  if (kodelaKey) {
    const provider =
      aiConfig?.provider ??
      process.env["KODELA_AI_PROVIDER"] ??
      "openai";
    console.debug(
      `[kodela/reasoning] credential source: KODELA_AI_API_KEY (provider: ${provider})`,
    );
    return {
      apiKey: kodelaKey,
      provider,
      model: aiConfig?.model ?? process.env["KODELA_AI_MODEL"],
      baseUrl: aiConfig?.baseUrl ?? process.env["KODELA_AI_BASE_URL"],
      credentialSource: "KODELA_AI_API_KEY",
    };
  }

  // 3. Native provider env vars — use session hint as tiebreaker
  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  const openaiKey = process.env["OPENAI_API_KEY"];
  const geminiKey = process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"];
  const geminiSource = process.env["GEMINI_API_KEY"] ? "GEMINI_API_KEY" : "GOOGLE_API_KEY";

  if (sessionProviderHint === "anthropic" && anthropicKey) {
    const model = aiConfig?.model ?? sessionModel;
    console.debug(
      `[kodela/reasoning] credential source: ANTHROPIC_API_KEY (session hint: anthropic${model ? `, model: ${model}` : ""})`,
    );
    return {
      apiKey: anthropicKey,
      provider: "anthropic",
      model,
      baseUrl: aiConfig?.baseUrl ?? process.env["KODELA_AI_BASE_URL"],
      credentialSource: "ANTHROPIC_API_KEY",
    };
  }

  if (sessionProviderHint === "openai" && openaiKey) {
    const model = aiConfig?.model ?? sessionModel;
    console.debug(
      `[kodela/reasoning] credential source: OPENAI_API_KEY (session hint: openai${model ? `, model: ${model}` : ""})`,
    );
    return {
      apiKey: openaiKey,
      provider: "openai",
      model,
      baseUrl: aiConfig?.baseUrl ?? process.env["KODELA_AI_BASE_URL"],
      credentialSource: "OPENAI_API_KEY",
    };
  }

  if (sessionProviderHint === "google" && geminiKey) {
    const model = aiConfig?.model ?? sessionModel;
    console.debug(
      `[kodela/reasoning] credential source: ${geminiSource} (session hint: google${model ? `, model: ${model}` : ""})`,
    );
    return {
      apiKey: geminiKey,
      provider: "google",
      model,
      baseUrl: aiConfig?.baseUrl ?? process.env["KODELA_AI_BASE_URL"],
      credentialSource: geminiSource as "GEMINI_API_KEY" | "GOOGLE_API_KEY",
    };
  }

  // No matching hint or no hint at all — try anthropic, then openai, then google
  if (anthropicKey) {
    const model = aiConfig?.model ?? sessionModel;
    console.debug(
      `[kodela/reasoning] credential source: ANTHROPIC_API_KEY (no session hint${model ? `, model: ${model}` : ""})`,
    );
    return {
      apiKey: anthropicKey,
      provider: "anthropic",
      model,
      baseUrl: aiConfig?.baseUrl ?? process.env["KODELA_AI_BASE_URL"],
      credentialSource: "ANTHROPIC_API_KEY",
    };
  }

  if (openaiKey) {
    const model = aiConfig?.model ?? sessionModel;
    console.debug(
      `[kodela/reasoning] credential source: OPENAI_API_KEY (no session hint${model ? `, model: ${model}` : ""})`,
    );
    return {
      apiKey: openaiKey,
      provider: "openai",
      model,
      baseUrl: aiConfig?.baseUrl ?? process.env["KODELA_AI_BASE_URL"],
      credentialSource: "OPENAI_API_KEY",
    };
  }

  if (geminiKey) {
    const model = aiConfig?.model ?? sessionModel;
    console.debug(
      `[kodela/reasoning] credential source: ${geminiSource} (no session hint${model ? `, model: ${model}` : ""})`,
    );
    return {
      apiKey: geminiKey,
      provider: "google",
      model,
      baseUrl: aiConfig?.baseUrl ?? process.env["KODELA_AI_BASE_URL"],
      credentialSource: geminiSource as "GEMINI_API_KEY" | "GOOGLE_API_KEY",
    };
  }

  // No credentials available — fallback path will run
  console.debug(
    "[kodela/reasoning] credential source: none — deterministic fallback will be used",
  );
  return {
    apiKey: "",
    provider: "openai",
    credentialSource: "none",
  };
}

// ---------------------------------------------------------------------------
// Core extraction function
// ---------------------------------------------------------------------------

export type ExtractReasoningOptions = {
  /**
   * Raw diff text for the hook or prompt path.
   */
  diff?: string;
  /**
   * Existing annotation note, used as context in the prompt.
   */
  note?: string;
  /**
   * Which extraction method to record.
   * "hook" when called from the PostToolUse handler; "prompt" otherwise.
   */
  extractionMethod?: ExtractionMethod;
  /**
   * AI provider configuration.
   * When absent or when no API key resolves, the fallback path runs.
   */
  aiConfig?: {
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /**
   * Provider hint derived from the session model (e.g. "anthropic", "openai").
   * When set, the matching native env var is preferred over the other during
   * fallback credential resolution. Has no effect when an explicit apiKey or
   * KODELA_AI_API_KEY is already available.
   */
  sessionProviderHint?: string;
  /**
   * The model used during the session that triggered this extraction.
   * Used as the default model when no explicit model is configured and the
   * credential source is a native provider env var.
   */
  sessionModel?: string;
  /**
   * If existing `reasoning` is less than this many days old, skip extraction
   * and return the existing object (idempotency guard). Default: 30.
   */
  reextractAfterDays?: number;
  /**
   * Existing reasoning object from the entry — checked for idempotency.
   */
  existingReasoning?: ReasoningObject;
};

/**
 * Extract structured reasoning for a code change.
 *
 * Execution path:
 *   1. Idempotency check — if existing reasoning is fresh, return it.
 *   2. Attempt AI extraction with the configured provider.
 *   3. On parse failure, retry once with a more constrained prompt.
 *   4. On second failure or missing API key, return `buildFallbackReasoning`.
 *
 * This function is pure except for the optional AI network call. It never
 * throws — failures are absorbed and the fallback is returned.
 */
export async function extractReasoning(
  filePath: string,
  opts: ExtractReasoningOptions = {},
): Promise<ReasoningObject> {
  const {
    diff,
    note,
    extractionMethod = "prompt",
    aiConfig,
    sessionProviderHint,
    sessionModel,
    reextractAfterDays = 30,
    existingReasoning,
  } = opts;

  // ── 1. Idempotency guard ──────────────────────────────────────────────────
  if (existingReasoning) {
    const extractedAt = new Date(existingReasoning.extractedAt).getTime();
    const ageMs = Date.now() - extractedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < reextractAfterDays) {
      return existingReasoning;
    }
  }

  // ── 2. Resolve credentials (multi-source with session hint) ──────────────
  const resolved = resolveReasoningCredentials(
    aiConfig,
    sessionProviderHint,
    sessionModel,
  );

  if (!resolved.apiKey) {
    return buildFallbackReasoning(filePath, note);
  }

  // ── 3. AI extraction ─────────────────────────────────────────────────────
  const method = extractionMethod;

  try {
    const prompt = buildExtractionPrompt(filePath, diff, note);
    const raw = await callAiForReasoning(prompt, resolved);

    // First parse attempt
    const result = validateReasoningResponse(raw, method);
    if (result) return result;

    // Retry with a more constrained prompt
    const retryPrompt = buildRetryPrompt(filePath, note);
    const retryRaw = await callAiForReasoning(retryPrompt, resolved);
    const retryResult = validateReasoningResponse(retryRaw, method);
    if (retryResult) return retryResult;

    // Both attempts failed — fall back
    return buildFallbackReasoning(filePath, note);
  } catch {
    return buildFallbackReasoning(filePath, note);
  }
}

// ---------------------------------------------------------------------------
// Internal: AI call (isolated, no imports from CLI layer)
// ---------------------------------------------------------------------------

async function callAiForReasoning(
  prompt: string,
  config: ResolvedReasoningCredentials,
): Promise<string> {
  const providerName = config.provider;
  const isGoogle = providerName === "google";
  const model =
    config.model ??
    (providerName === "anthropic"
      ? "claude-3-5-haiku-20241022"
      : isGoogle
        ? "gemini-2.0-flash"
        : "gpt-4o-mini");
  const baseUrl =
    config.baseUrl ??
    (providerName === "anthropic"
      ? "https://api.anthropic.com"
      : isGoogle
        ? "https://generativelanguage.googleapis.com/v1beta/openai"
        : "https://api.openai.com");

  if (providerName === "anthropic") {
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 512,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Anthropic API ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = (await resp.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    const block = data.content.find((b) => b.type === "text");
    if (!block?.text) throw new Error("Anthropic returned no text block");
    return block.text;
  }

  // OpenAI-compatible
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 512,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI API ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const content = data.choices[0]?.message.content;
  if (!content) throw new Error("OpenAI returned no content");
  return content;
}
