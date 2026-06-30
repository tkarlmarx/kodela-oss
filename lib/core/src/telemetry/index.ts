// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export {
  TELEMETRY_SCHEMA_VERSION,
  TelemetryEventSchema,
  AnnotationAddedEventSchema,
  HoverViewedEventSchema,
  PromptDismissedEventSchema,
  NagIgnoredEventSchema,
  ProposalAcceptedEventSchema,
  ProposalRejectedEventSchema,
} from "./telemetry-schema.js";

export type {
  TelemetryEvent,
  TelemetryEventType,
  AnnotationAddedEvent,
  HoverViewedEvent,
  PromptDismissedEvent,
  NagIgnoredEvent,
  ProposalAcceptedEvent,
  ProposalRejectedEvent,
} from "./telemetry-schema.js";

export {
  appendTelemetryEvent,
  readTelemetryEvents,
  countTelemetryLines,
} from "./telemetry-storage.js";

export type { ReadTelemetryOptions } from "./telemetry-storage.js";
