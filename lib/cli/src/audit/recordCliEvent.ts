// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { loadLicense, licenseHasFeature } from "@kodela/core";

export interface CliEventOptions {
  eventType: "context_added" | "context_updated" | "context_archived" | "exception_approved";
  actor: string;
  orgId: string;
  filePath?: string;
  entryId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Records a context mutation event to the remote audit log.
 * Only fires when:
 *   - The license has the audit_logs feature
 *   - KODELA_API_URL environment variable is set
 * Sends X-Kodela-Org-Id and, when present, an Authorization: Bearer header
 * derived from the license apiSecret for server-side request verification.
 * Failures are non-fatal — errors are silently swallowed so they never
 * block the primary CLI operation.
 */
export async function recordCliEvent(opts: CliEventOptions, repoRoot?: string): Promise<void> {
  const apiUrl = process.env["KODELA_API_URL"];
  if (!apiUrl) return;

  try {
    const license = await loadLicense(repoRoot);
    if (!licenseHasFeature(license, "audit_logs")) return;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Kodela-Org-Id": opts.orgId,
    };

    if (license?.apiSecret) {
      headers["Authorization"] = `Bearer ${license.apiSecret}`;
    }

    await fetch(`${apiUrl}/api/dashboard/audit/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        eventType: opts.eventType,
        actor: opts.actor,
        filePath: opts.filePath,
        entryId: opts.entryId,
        metadata: opts.metadata,
      }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // non-fatal — audit recording failure never blocks CLI operations
  }
}
