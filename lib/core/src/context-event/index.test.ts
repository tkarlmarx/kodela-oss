// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  confidenceToTrustLevel,
  normalizeContext,
  createObjectEntry,
  type ContextEvent,
  type NormalizedContextEvent,
} from "./index.js";
import { ATTRIBUTION_CONFIDENCE } from "../attribution/index.js";

// ---------------------------------------------------------------------------
// Helper — minimal ContextEvent
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<ContextEvent> = {}): ContextEvent {
  return {
    tool: "replit-agent",
    source: "env",
    attributionConfidence: 1.0,
    canUpgradeAttribution: false,
    filePath: "src/foo.ts",
    linesAdded: 10,
    ubaScore: 0.85,
    ubaSignals: { editPattern: 0.9, temporalSignature: 0.8 },
    ubaSource: "ai",
    sessionId: "sess-abc-123",
    model: "claude-3-5-sonnet",
    ...overrides,
  };
}

const defaultOpts = {
  lineRange: [10, 25] as [number, number],
  contentHash: "deadbeef01234567",
  author: "test-author",
  fallbackNote: "Auto-annotated: replit-agent change — 2 hunks, 15 lines",
  source: "ai" as const,
  confidence: 0.87,
  status: "uncertain" as const,
  reviewRequired: true,
};

// ---------------------------------------------------------------------------
// confidenceToTrustLevel
// ---------------------------------------------------------------------------

describe("confidenceToTrustLevel", () => {
  it("returns 'confirmed' at KODELA_AGENT_ENV confidence (1.0)", () => {
    assert.equal(confidenceToTrustLevel(ATTRIBUTION_CONFIDENCE.KODELA_AGENT_ENV), "confirmed");
  });

  it("returns 'confirmed' at SIDECAR confidence (0.95)", () => {
    assert.equal(confidenceToTrustLevel(ATTRIBUTION_CONFIDENCE.SIDECAR), "confirmed");
  });

  it("returns 'confirmed' at VSCODE_COMMAND confidence (0.9)", () => {
    assert.equal(confidenceToTrustLevel(ATTRIBUTION_CONFIDENCE.VSCODE_COMMAND), "confirmed");
  });

  it("returns 'uncertain' at KNOWN_AGENT_ENV confidence (0.50)", () => {
    assert.equal(confidenceToTrustLevel(ATTRIBUTION_CONFIDENCE.KNOWN_AGENT_ENV), "uncertain");
  });

  it("returns 'uncertain' at GIT_TRAILER confidence (0.75)", () => {
    assert.equal(confidenceToTrustLevel(ATTRIBUTION_CONFIDENCE.GIT_TRAILER), "uncertain");
  });

  it("returns 'uncertain' at PROCESS_ANCESTRY confidence (0.70)", () => {
    assert.equal(confidenceToTrustLevel(ATTRIBUTION_CONFIDENCE.PROCESS_ANCESTRY), "uncertain");
  });

  it("returns 'uncertain' at HEURISTIC confidence (0.50)", () => {
    assert.equal(confidenceToTrustLevel(ATTRIBUTION_CONFIDENCE.HEURISTIC), "uncertain");
  });

  it("returns 'none' at NONE confidence (0.0)", () => {
    assert.equal(confidenceToTrustLevel(ATTRIBUTION_CONFIDENCE.NONE), "none");
  });

  it("returns 'none' for sub-heuristic confidence (0.3)", () => {
    assert.equal(confidenceToTrustLevel(0.3), "none");
  });

  it("returns 'confirmed' at exactly the 0.9 boundary", () => {
    assert.equal(confidenceToTrustLevel(0.9), "confirmed");
  });

  it("returns 'uncertain' just below the 0.9 boundary (0.89)", () => {
    assert.equal(confidenceToTrustLevel(0.89), "uncertain");
  });
});

// ---------------------------------------------------------------------------
// normalizeContext
// ---------------------------------------------------------------------------

describe("normalizeContext", () => {
  it("sets trustLevel to 'confirmed' when attributionConfidence = 1.0", () => {
    const result = normalizeContext(makeEvent({ attributionConfidence: 1.0 }));
    assert.equal(result.trustLevel, "confirmed");
  });

  it("sets trustLevel to 'uncertain' when attributionConfidence = 0.5", () => {
    const result = normalizeContext(makeEvent({ attributionConfidence: 0.5, source: "known-env" }));
    assert.equal(result.trustLevel, "uncertain");
  });

  it("sets trustLevel to 'none' when attributionConfidence = 0.0", () => {
    const result = normalizeContext(makeEvent({ attributionConfidence: 0.0, source: "none", tool: null }));
    assert.equal(result.trustLevel, "none");
  });

  it("builds originBlock with tool, model, sessionId when tool is set", () => {
    const result = normalizeContext(makeEvent({
      tool: "cursor",
      model: "gpt-4o",
      sessionId: "s-xyz",
    }));
    assert.ok(result.originBlock, "originBlock should be defined");
    assert.equal(result.originBlock?.type, "ai");
    assert.equal(result.originBlock?.tool, "cursor");
    assert.equal(result.originBlock?.model, "gpt-4o");
    assert.equal(result.originBlock?.sessionId, "s-xyz");
  });

  it("sets originBlock to undefined when tool is null", () => {
    const result = normalizeContext(makeEvent({ tool: null, attributionConfidence: 0.0, source: "none" }));
    assert.equal(result.originBlock, undefined);
  });

  it("carries through the summary field from the raw event", () => {
    const result = normalizeContext(makeEvent({ summary: "Implemented OAuth flow." }));
    assert.equal(result.originBlock?.summary, "Implemented OAuth flow.");
  });

  it("passes all original event fields through unchanged", () => {
    const event = makeEvent({ filePath: "lib/utils/hash.ts", linesAdded: 42 });
    const result = normalizeContext(event);
    assert.equal(result.filePath, "lib/utils/hash.ts");
    assert.equal(result.linesAdded, 42);
    assert.equal(result.ubaScore, event.ubaScore);
    assert.deepEqual(result.ubaSignals, event.ubaSignals);
  });

  it("aiNote is undefined after normalizeContext (set externally by CLI layer)", () => {
    const result = normalizeContext(makeEvent());
    assert.equal(result.aiNote, undefined);
  });
});

// ---------------------------------------------------------------------------
// createObjectEntry
// ---------------------------------------------------------------------------

describe("createObjectEntry", () => {
  it("uses aiNote as the entry note when provided", () => {
    const normalized: NormalizedContextEvent = {
      ...normalizeContext(makeEvent()),
      aiNote: "Implements JWT refresh token rotation with a 15-minute expiry.",
    };
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.equal(entry.note, "Implements JWT refresh token rotation with a 15-minute expiry.");
  });

  it("falls back to fallbackNote when aiNote is absent", () => {
    const normalized = normalizeContext(makeEvent());
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.equal(entry.note, defaultOpts.fallbackNote);
  });

  it("falls back to fallbackNote when aiNote is empty string", () => {
    const normalized: NormalizedContextEvent = {
      ...normalizeContext(makeEvent()),
      aiNote: "   ",
    };
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.equal(entry.note, defaultOpts.fallbackNote);
  });

  it("forces reviewRequired=false when trustLevel is 'confirmed'", () => {
    const normalized = normalizeContext(makeEvent({ attributionConfidence: 1.0 }));
    const entry = createObjectEntry(normalized, { ...defaultOpts, reviewRequired: true });
    assert.equal(entry.reviewRequired, false);
  });

  it("preserves caller's reviewRequired when trustLevel is 'uncertain'", () => {
    const normalized = normalizeContext(makeEvent({ attributionConfidence: 0.5, source: "known-env" }));
    const entry = createObjectEntry(normalized, { ...defaultOpts, reviewRequired: true });
    assert.equal(entry.reviewRequired, true);
  });

  it("adds 'confirmed' tag when trustLevel is 'confirmed'", () => {
    const normalized = normalizeContext(makeEvent({ attributionConfidence: 1.0 }));
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.ok(entry.tags.includes("confirmed"), "should have 'confirmed' tag");
    assert.ok(entry.tags.includes("ai"), "should have 'ai' tag");
    assert.ok(entry.tags.includes("auto"), "should have 'auto' tag");
  });

  it("does not add 'confirmed' tag when trustLevel is 'uncertain'", () => {
    const normalized = normalizeContext(makeEvent({ attributionConfidence: 0.5, source: "known-env" }));
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.ok(!entry.tags.includes("confirmed"), "should not have 'confirmed' tag");
  });

  it("sets canUpgradeAttribution=false when trustLevel is 'confirmed'", () => {
    const normalized = normalizeContext(makeEvent({ attributionConfidence: 1.0, canUpgradeAttribution: true }));
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.equal(entry.canUpgradeAttribution, false);
  });

  it("preserves canUpgradeAttribution from event when trustLevel is 'uncertain'", () => {
    const normalized = normalizeContext(makeEvent({ attributionConfidence: 0.5, canUpgradeAttribution: true, source: "known-env" }));
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.equal(entry.canUpgradeAttribution, true);
  });

  it("sets aiTool from normalized.tool", () => {
    const normalized = normalizeContext(makeEvent({ tool: "replit-agent" }));
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.equal(entry.aiTool, "replit-agent");
  });

  it("omits aiTool when tool is null", () => {
    const normalized = normalizeContext(makeEvent({ tool: null, attributionConfidence: 0.0, source: "none" }));
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.equal(entry.aiTool, undefined);
  });

  it("sets origin.summary to first sentence of aiNote", () => {
    const normalized: NormalizedContextEvent = {
      ...normalizeContext(makeEvent({ tool: "cursor", sessionId: "sess-1" })),
      aiNote: "Implements JWT rotation. Also adds refresh endpoint.",
    };
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.equal(entry.origin?.summary, "Implements JWT rotation.");
  });

  it("assigns a valid UUID as entry id", () => {
    const normalized = normalizeContext(makeEvent());
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.match(entry.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("sets lineRange correctly from opts", () => {
    const normalized = normalizeContext(makeEvent());
    const entry = createObjectEntry(normalized, { ...defaultOpts, lineRange: [5, 30] });
    assert.equal(entry.lineRange.start, 5);
    assert.equal(entry.lineRange.end, 30);
  });

  it("sets classificationScore and classificationSignals from normalized ubaScore/ubaSignals", () => {
    const normalized = normalizeContext(makeEvent({ ubaScore: 0.77, ubaSignals: { editPattern: 0.6 } }));
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.equal(entry.classificationScore, 0.77);
    assert.deepEqual(entry.classificationSignals, { editPattern: 0.6 });
  });

  it("sets sessionId on entry when present in normalized event", () => {
    const normalized = normalizeContext(makeEvent({ sessionId: "sess-xyz-789" }));
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.equal(entry.sessionId, "sess-xyz-789");
  });

  it("omits sessionId when not in normalized event", () => {
    const normalized = normalizeContext(makeEvent({ sessionId: undefined }));
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.equal(entry.sessionId, undefined);
  });

  it("has schemaVersion set correctly", () => {
    const normalized = normalizeContext(makeEvent());
    const entry = createObjectEntry(normalized, defaultOpts);
    assert.equal(entry.schemaVersion, "1.1.0");
  });
});
