// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * @kodela/core/synthesis — Phase 2 async LLM synthesis primitives.
 *
 * Re-exports the queue + prompt API the synthesis worker imports from
 * lib/core. Consumers should import from `@kodela/core/synthesis` not the
 * individual files so the public surface stays stable across refactors.
 */

export {
  SYNTHESIS_TEMPLATE_VERSION,
  SynthesisOutputSchema,
  buildSynthesisPrompt,
  synthesisSystemPrompt,
  parseSynthesisOutput,
  type SynthesisOutput,
  type SynthesisPromptInputs,
} from "./prompt.js";

export {
  SynthesisEventSchema,
  CompletedEventSchema,
  eventIdFor,
  enqueueSynthesisEvent,
  listPendingEvents,
  claimPendingEvent,
  completeSynthesisEvent,
  failSynthesisEvent,
  requeueInflightEvent,
  rescueExpiredLeases,
  type SynthesisEvent,
  type CompletedEvent,
} from "./queue.js";
