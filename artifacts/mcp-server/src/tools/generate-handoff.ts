// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela_generate_handoff` MCP tool (07 §3.13).
 *
 * Reshapes the persisted session envelope (`.kodela/sessions/<id>.mcp.json`,
 * written at kodela_session_end) into an audience-tailored handoff. Three
 * audiences produce genuinely distinct shapes — not a label swap:
 *
 *   - reviewer        → risk posture first; review-required files lead;
 *                       what_was_done ordered by risk (critical → low).
 *   - ai-agent        → "continue from here" framing; followups (next steps)
 *                       lead; per-file whyChanged kept for context.
 *   - human-engineer  → narrative summary; readable change list; lighter flags.
 *
 * Deferred (flagged in meta, never faked):
 *   - open_questions  → no native source in the envelope; returned as [].
 *   - dna_excerpt     → needs kodela_get_project_dna (Phase 3); omitted when
 *                       include_dna is requested, with a meta note.
 */

import { z } from "zod";
import { readMCPEnvelope, type MCPContextEnvelope } from "@kodela/core/sessions";

// ── Input schema ─────────────────────────────────────────────────────────────

export const GenerateHandoffInputSchema = z.object({
  session_id: z.string().min(1),
  audience: z
    .enum(["ai-agent", "human-engineer", "reviewer"])
    .default("ai-agent")
    .describe("Tailors the handoff shape and emphasis"),
  include_dna: z.boolean().default(true),
  include_open_questions: z.boolean().default(true),
  token_budget: z.number().int().positive().default(10000),
});

export type GenerateHandoffToolInput = z.infer<typeof GenerateHandoffInputSchema>;

// ── Output ───────────────────────────────────────────────────────────────────

interface WhatWasDone {
  file: string;
  summary: string;
  risk: string;
}

export interface GenerateHandoffResult {
  ok: boolean;
  handoff?: {
    summary: string;
    what_was_done: WhatWasDone[];
    open_questions: string[];
    followups: string[];
    dna_excerpt?: string;
    meta: {
      audience: string;
      tokens_estimated: number;
      truncated: boolean;
      notes: string[];
    };
  };
  error?: string;
}

const RISK_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function estimateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

/** Per-file change → a one-line "what was done", best available text. */
function fileSummary(f: MCPContextEnvelope["changes"]["files"][number]): WhatWasDone {
  const summary =
    f.whyChanged?.trim() ||
    f.problemSolved?.trim() ||
    f.intent?.trim() ||
    `${f.linesAdded}+/${f.linesRemoved}- changed`;
  return { file: f.path, summary, risk: f.risk };
}

export async function generateHandoffForMcp(
  repoRoot: string,
  input: GenerateHandoffToolInput,
): Promise<GenerateHandoffResult> {
  let envelope: MCPContextEnvelope | null;
  try {
    envelope = await readMCPEnvelope(repoRoot, input.session_id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!envelope) {
    return {
      ok: false,
      error:
        `No handoff envelope for session ${input.session_id}. The session must be ` +
        `closed with kodela_session_end before a handoff can be generated.`,
    };
  }

  const notes: string[] = [];
  const files = envelope.changes.files;
  const reviewFiles = files.filter((f) => f.reviewRequired);

  // ── Audience-specific shaping ───────────────────────────────────────────────
  let whatWasDone: WhatWasDone[];
  let followups: string[];
  let summary: string;

  switch (input.audience) {
    case "reviewer": {
      // Risk first: order changes critical → low; followups are the review queue.
      whatWasDone = [...files]
        .sort((a, b) => (RISK_ORDER[a.risk] ?? 9) - (RISK_ORDER[b.risk] ?? 9))
        .map(fileSummary);
      followups = (reviewFiles.length > 0 ? reviewFiles : []).map(
        (f) => `Review ${f.path} (risk: ${f.risk})`,
      );
      summary =
        `[risk: ${envelope.risk}${envelope.reviewRequired ? ", review required" : ""}] ` +
        envelope.handoffSummary;
      break;
    }
    case "human-engineer": {
      // Narrative: changes in capture order, lighter on flags.
      whatWasDone = files.map(fileSummary);
      followups = reviewFiles.map((f) => `Double-check ${f.path}`);
      summary = envelope.handoffSummary;
      break;
    }
    case "ai-agent":
    default: {
      // Continue-from framing: next steps lead, per-file context retained.
      whatWasDone = files.map(fileSummary);
      followups = reviewFiles.map(
        (f) => `Verify ${f.path} — flagged review-required (risk: ${f.risk})`,
      );
      summary = `Continuing from: ${envelope.handoffSummary}`;
      break;
    }
  }

  // open_questions: no durable source in the envelope. Return [] rather than
  // invent. (include_open_questions is honored only insofar as we'd populate it
  // if a source existed.)
  const open_questions: string[] = [];
  if (input.include_open_questions) {
    notes.push("open_questions has no envelope source yet — returned empty.");
  }

  // dna_excerpt: pending kodela_get_project_dna (Phase 3).
  if (input.include_dna) {
    notes.push("dna_excerpt pending kodela_get_project_dna (Phase 3) — omitted.");
  }

  // ── Token budget — truncate what_was_done if over, flag it ──────────────────
  let truncated = false;
  const buildPayload = (wwd: WhatWasDone[]) => ({
    summary,
    what_was_done: wwd,
    open_questions,
    followups,
  });
  while (
    whatWasDone.length > 1 &&
    estimateTokens(buildPayload(whatWasDone)) > input.token_budget
  ) {
    whatWasDone = whatWasDone.slice(0, Math.ceil(whatWasDone.length / 2));
    truncated = true;
  }
  if (truncated) {
    notes.push(
      `what_was_done truncated to ${whatWasDone.length} of ${files.length} files to fit token_budget.`,
    );
  }

  const handoff = {
    summary,
    what_was_done: whatWasDone,
    open_questions,
    followups,
    meta: {
      audience: input.audience,
      tokens_estimated: 0,
      truncated,
      notes,
    },
  };
  handoff.meta.tokens_estimated = estimateTokens(handoff);

  return { ok: true, handoff };
}

// ── Response formatter ───────────────────────────────────────────────────────

export function formatGenerateHandoffResponse(result: GenerateHandoffResult): string {
  if (!result.ok) {
    return JSON.stringify({ ok: false, error: result.error }, null, 2);
  }
  return JSON.stringify(
    {
      ok: true,
      type: "kodela.handoff",
      version: "1.0",
      ...result.handoff,
    },
    null,
    2,
  );
}
