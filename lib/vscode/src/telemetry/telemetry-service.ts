// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 21 — VS Code telemetry service.
 *
 * Wraps `appendTelemetryEvent` from `@kodela/core` and guards every emit
 * behind `isTelemetryEnabled()` — which by default reads
 * `vscode.env.isTelemetryEnabled` — so the user's VS Code telemetry setting
 * is always respected.
 *
 * All parameters are injectable for testing (no real VS Code or FS needed).
 */

import type {
  TelemetryEvent,
  AnnotationAddedEvent,
  HoverViewedEvent,
  PromptDismissedEvent,
  NagIgnoredEvent,
} from "@kodela/core";
import { TELEMETRY_SCHEMA_VERSION } from "@kodela/core";

export type AppendFn = (repoRoot: string, event: TelemetryEvent) => Promise<void>;
export type IsTelemetryEnabledFn = () => boolean;

export class TelemetryService {
  constructor(
    private readonly _repoRoot: string,
    private readonly _appendFn: AppendFn,
    private readonly _isTelemetryEnabled: IsTelemetryEnabledFn,
  ) {}

  /** annotation_added — fired after runAdd() succeeds. */
  async emitAnnotationAdded(
    noteLength: number,
    source: AnnotationAddedEvent["source"],
    aiToolPresent: boolean,
  ): Promise<void> {
    if (!this._isTelemetryEnabled()) return;
    await this._appendFn(this._repoRoot, {
      type: "annotation_added",
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      noteLength,
      source,
      aiToolPresent,
    });
  }

  /** hover_viewed — fired each time a hover card is shown for an annotation. */
  async emitHoverViewed(entryAgeMs: number, hasLink: boolean): Promise<void> {
    if (!this._isTelemetryEnabled()) return;
    await this._appendFn(this._repoRoot, {
      type: "hover_viewed",
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      entryAgeMs,
      hasLink,
    });
  }

  /**
   * prompt_dismissed — fired when the user cancels the annotation dialog
   * before saving.  `stage` identifies which prompt they abandoned.
   */
  async emitPromptDismissed(stage?: string): Promise<void> {
    if (!this._isTelemetryEnabled()) return;
    await this._appendFn(this._repoRoot, {
      type: "prompt_dismissed",
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      ...(stage !== undefined ? { stage } : {}),
    });
  }

  /**
   * nag_ignored — fired when a nudge report was shown but the user/CI chose
   * to ignore it rather than fixing the underlying entries.
   */
  async emitNagIgnored(itemCount: number): Promise<void> {
    if (!this._isTelemetryEnabled()) return;
    await this._appendFn(this._repoRoot, {
      type: "nag_ignored",
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      itemCount,
    });
  }
}

