// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Synthesis prompt template v1.
 *
 * Phase 2 of the project design docs
 *
 * The worker asks the model to produce a four-field JSON object that maps
 * directly onto FileChangeContext: whyChanged, problemSolved, aiReasoning,
 * and a risk level. The model is instructed to be honest about uncertainty
 * — when the diff is too small / too generic to support a real answer it
 * should mark confidence "low" so the chip in the dashboard renders the
 * Low pill instead of a confident-but-fabricated Medium/High.
 */

import { z } from "zod";

export const SYNTHESIS_TEMPLATE_VERSION = "v1" as const;

/** Shape the model is required to return. */
export const SynthesisOutputSchema = z.object({
  whyChanged: z
    .string()
    .min(10, "whyChanged must explain why THIS file needed to change (min 10 chars)"),
  problemSolved: z
    .string()
    .min(10, "problemSolved must describe what problem this change fixes/enables (min 10 chars)"),
  aiReasoning: z.string().optional(),
  risk: z.enum(["low", "medium", "high", "critical"]).default("low"),
  /**
   * Model's own honesty about its synthesis quality. The dashboard maps this
   * to the categorical chip via levelForConfidence; "low" results in a Low
   * pill regardless of how confident the prose sounds.
   */
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
});

export type SynthesisOutput = z.infer<typeof SynthesisOutputSchema>;

export interface SynthesisPromptInputs {
  filePath: string;
  /** Unified diff for this file's change. */
  diff?: string;
  /** Short excerpts from the chat transcript that touched this file. */
  transcript?: string;
  /** Commit message if the session closed alongside a commit. */
  commitMessage?: string;
  /** Optional session goal — the user's opening prompt for the session. */
  sessionGoal?: string;
}

const SYSTEM_INSTRUCTIONS = `
You are Kodela's synthesis pass. Your job is to read (diff + chat transcript + commit message) for a single file changed in an AI-assisted coding session, and produce a JSON object describing why the change was made — not what changed (the diff says that).

Be honest:
- If the diff is too small or too generic to support a real reason, mark confidence "low" and write a brief observational sentence rather than inventing intent.
- Never claim alternatives were considered if no evidence appears in the transcript.
- Pick a risk level conservatively: "low" by default, "medium" only when the file is in auth/db/payments/policy areas, "high" or "critical" only when the diff shows a removed safety check, a credential change, or a schema migration.

Output a single JSON object — no prose around it, no markdown fences — matching:

{
  "whyChanged":   "<one or two sentences explaining why THIS file needed to change>",
  "problemSolved":"<one or two sentences on what problem this change fixes or enables>",
  "aiReasoning":  "<one sentence on the approach chosen, if observable>",
  "risk":         "low" | "medium" | "high" | "critical",
  "confidence":   "low" | "medium" | "high"
}
`.trim();

/** Build the user message the worker sends to the model. */
export function buildSynthesisPrompt(inputs: SynthesisPromptInputs): string {
  const sections: string[] = [];
  sections.push(`File: ${inputs.filePath}`);
  if (inputs.sessionGoal) {
    sections.push(`\nSession goal (user's opening prompt):\n${truncate(inputs.sessionGoal, 800)}`);
  }
  if (inputs.commitMessage) {
    sections.push(`\nCommit message:\n${truncate(inputs.commitMessage, 600)}`);
  }
  if (inputs.transcript) {
    sections.push(`\nRelevant chat-transcript excerpts:\n${truncate(inputs.transcript, 2000)}`);
  }
  if (inputs.diff) {
    sections.push(`\nUnified diff for this file:\n\`\`\`diff\n${truncate(inputs.diff, 4000)}\n\`\`\``);
  }
  sections.push(`\nReturn only the JSON object specified in the system instructions.`);
  return sections.join("\n");
}

/** Public so the worker can include it as the system message. */
export function synthesisSystemPrompt(): string {
  return SYSTEM_INSTRUCTIONS;
}

/**
 * Parse the model's raw text response into a validated SynthesisOutput.
 * Tolerates ```json fences and leading/trailing prose by extracting the
 * first balanced JSON object. Throws when nothing parseable is found.
 */
export function parseSynthesisOutput(raw: string): SynthesisOutput {
  const json = extractJsonObject(raw);
  if (!json) {
    throw new Error("Synthesis output did not contain a JSON object");
  }
  return SynthesisOutputSchema.parse(JSON.parse(json));
}

// ── Internal ────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Scan for the first `{ ... }` block with balanced braces and return it. */
function extractJsonObject(s: string): string | null {
  const trimmed = s.trim();
  // Strip ```json fences if present.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]!.trim() : trimmed;

  const start = body.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return body.slice(start, i + 1);
      }
    }
  }
  return null;
}
