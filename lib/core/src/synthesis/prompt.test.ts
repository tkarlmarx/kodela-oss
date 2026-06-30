// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 2 — prompt rendering + output parsing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildSynthesisPrompt,
  parseSynthesisOutput,
  SYNTHESIS_TEMPLATE_VERSION,
  SynthesisOutputSchema,
  synthesisSystemPrompt,
} from "./prompt.js";

describe("synthesis prompt v1", () => {
  test("SYNTHESIS_TEMPLATE_VERSION is the pinned 'v1'", () => {
    assert.equal(SYNTHESIS_TEMPLATE_VERSION, "v1");
  });

  test("systemPrompt instructs honest confidence + JSON-only output", () => {
    const sys = synthesisSystemPrompt();
    assert.match(sys, /\"whyChanged\"/);
    assert.match(sys, /\"confidence\"/);
    assert.match(sys, /no prose around it/i);
  });

  test("buildSynthesisPrompt includes the file path and the inputs it was given", () => {
    const out = buildSynthesisPrompt({
      filePath: "src/auth/session.ts",
      sessionGoal: "Refresh-token rotation hardening",
      commitMessage: "fix(auth): invalidate previous token on refresh",
      transcript: "[user] I want to invalidate the old token on refresh.",
      diff: "@@ -1 +1,4 @@\n+ const id = randomUUID();",
    });
    assert.match(out, /src\/auth\/session\.ts/);
    assert.match(out, /Refresh-token rotation hardening/);
    assert.match(out, /invalidate previous token on refresh/);
    assert.match(out, /\[user\]/);
    assert.match(out, /randomUUID/);
  });

  test("buildSynthesisPrompt truncates long inputs to stay within budget", () => {
    const longDiff = "+ line\n".repeat(5000);
    const out = buildSynthesisPrompt({ filePath: "x.ts", diff: longDiff });
    assert.ok(out.length < 6000, `expected truncation; got ${out.length}`);
  });

  test("parseSynthesisOutput accepts a bare JSON object", () => {
    const raw = JSON.stringify({
      whyChanged: "Added a null guard so the parser does not crash on empty input.",
      problemSolved: "Without the guard the parser threw on empty bodies in production.",
      aiReasoning: "Chose explicit guard over a try/catch to keep the call stack flat.",
      risk: "low",
      confidence: "medium",
    });
    const parsed = parseSynthesisOutput(raw);
    assert.equal(parsed.risk, "low");
    assert.equal(parsed.confidence, "medium");
  });

  test("parseSynthesisOutput tolerates ```json fences and leading prose", () => {
    const raw =
      "Here is the JSON you asked for:\n\n```json\n" +
      JSON.stringify({
        whyChanged: "Added a guard for empty-body branch handling.",
        problemSolved: "The parser threw on the empty body in production.",
        risk: "low",
        confidence: "low",
      }) +
      "\n```\n\nLet me know if you need anything else.";
    const parsed = parseSynthesisOutput(raw);
    assert.equal(parsed.confidence, "low");
  });

  test("parseSynthesisOutput throws when the model returned no JSON", () => {
    assert.throws(
      () => parseSynthesisOutput("Sorry, I cannot synthesize that."),
      /JSON object/,
    );
  });

  test("SynthesisOutputSchema rejects whyChanged shorter than 10 chars", () => {
    assert.throws(
      () => SynthesisOutputSchema.parse({
        whyChanged: "short",
        problemSolved: "Real problem statement that meets the minimum length.",
        risk: "low",
        confidence: "low",
      }),
      /whyChanged/,
    );
  });
});
