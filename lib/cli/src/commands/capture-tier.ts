// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * kodela capture-tier — read or set how strictly Kodela enforces per-file
 * context before a session can close.
 *
 *   kodela capture-tier            → print the active tier + what it means
 *   kodela capture-tier ambient    → set the tier (writes .kodela/config.json)
 *
 * Tiers: enforced (default, blocks close) · assisted (close + flag) ·
 * ambient (close immediately, fill async). Single-sourced via @kodela/core.
 */
import {
  CAPTURE_TIERS,
  DEFAULT_CAPTURE_TIER,
  readCaptureTier,
  writeCaptureTier,
  type CaptureTier,
} from "@kodela/core";

const BLURB: Record<CaptureTier, string> = {
  enforced: "a session cannot close until every touched file has context (default, highest assurance)",
  assisted: "close is allowed; missing files are queued for async synthesis and flagged for review",
  ambient: "close always succeeds immediately; missing files are filled asynchronously — install, do nothing, get populated",
};

export interface CaptureTierResult {
  tier: CaptureTier;
  changed: boolean;
  previous: CaptureTier;
}

export async function runCaptureTier(opts: {
  repoRoot: string;
  tier?: string;
}): Promise<CaptureTierResult> {
  const previous = readCaptureTier(opts.repoRoot);
  if (opts.tier === undefined) {
    return { tier: previous, changed: false, previous };
  }
  const next = opts.tier.toLowerCase();
  if (!(CAPTURE_TIERS as readonly string[]).includes(next)) {
    throw new Error(
      `Unknown capture tier "${opts.tier}". Choose one of: ${CAPTURE_TIERS.join(", ")}.`,
    );
  }
  const tier = next as CaptureTier;
  writeCaptureTier(opts.repoRoot, tier);
  return { tier, changed: tier !== previous, previous };
}

export function formatCaptureTierResult(result: CaptureTierResult, output: "text" | "json"): string {
  if (output === "json") return JSON.stringify(result, null, 2);
  const lines: string[] = [];
  if (result.changed) {
    lines.push(`Capture tier set to "${result.tier}" (was "${result.previous}").`);
  } else if (result.tier === result.previous && result.previous !== DEFAULT_CAPTURE_TIER) {
    lines.push(`Capture tier is "${result.tier}".`);
  } else {
    lines.push(`Capture tier is "${result.tier}".`);
  }
  lines.push(`  → ${BLURB[result.tier]}`);
  lines.push("");
  lines.push("Tiers:");
  for (const t of CAPTURE_TIERS) {
    const mark = t === result.tier ? "●" : "○";
    lines.push(`  ${mark} ${t} — ${BLURB[t]}`);
  }
  return lines.join("\n");
}
