// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Guided tours (Phase 2 — P2.2).
 *
 * A guided tour is a dependency-ordered onboarding walkthrough that **weaves in
 * the captured why**: "here's the auth module — it's imported by 12 others, and
 * *here's the decision* that made it use ed25519." Competitors can order a repo
 * by structure; only Kodela can hang the *reasons* on each stop.
 *
 * Pure and deterministic: callers supply the candidate modules (already carrying
 * descriptions + fused whys/decisions from the comprehension graph, plus an
 * inbound-dependency count from the dependency graph); this module selects,
 * orders, and narrates them. No I/O.
 */

import type { WhyLink, DecisionLink } from "../comprehension/types.js";
import { t, resolveLanguage, type Language } from "../i18n/index.js";

export interface TourCandidate {
  filePath: string;
  /** Plain-English description of the module (from the comprehension graph). */
  description: string;
  whys: WhyLink[];
  decisions: DecisionLink[];
  riskLevel: "critical" | "high" | "medium" | "low" | "none";
  /** How many other files import this one (foundational-ness proxy). */
  inboundCount: number;
}

export interface TourStop {
  order: number;
  filePath: string;
  title: string;
  description: string;
  /** Why this module appears at this point in the tour. */
  rationale: string;
  whys: WhyLink[];
  decisions: DecisionLink[];
  riskLevel: TourCandidate["riskLevel"];
  inboundCount: number;
}

export interface Tour {
  stops: TourStop[];
  stats: {
    candidates: number;
    stops: number;
    /** Stops that carry at least one why or decision. */
    withWhy: number;
  };
}

export interface BuildTourOptions {
  /** Max stops so a tour stays digestible. Default 12. */
  maxStops?: number;
  /**
   * When true, only include modules that carry captured why/decisions — a tour
   * of the *documented* architecture. Default false (include high-impact
   * modules even if undocumented, so gaps are visible).
   */
  documentedOnly?: boolean;
  /** Language for the generated rationale scaffolding. Default "en". */
  language?: Language;
}

const RISK_SCORE: Record<TourCandidate["riskLevel"], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

/**
 * Instructiveness score — how worth-visiting a module is on an onboarding tour.
 * Foundational (imported widely) + documented (has why/decisions) + risky rank
 * highest, because those are the things a newcomer most needs explained.
 */
function score(c: TourCandidate): number {
  const documented = c.whys.length + c.decisions.length;
  return c.inboundCount * 2 + documented * 3 + RISK_SCORE[c.riskLevel] * 2;
}

function rationaleFor(c: TourCandidate, rank: number, lang: Language): string {
  const parts: string[] = [];
  if (rank === 0) parts.push(t(lang, "rationale.startHere"));
  if (c.inboundCount > 0) {
    parts.push(t(lang, "rationale.importedBy", { n: c.inboundCount }));
  }
  if (c.decisions.length > 0) {
    parts.push(t(lang, "rationale.shapedBy", { n: c.decisions.length }));
  }
  if (c.riskLevel === "critical" || c.riskLevel === "high") {
    parts.push(t(lang, "rationale.risk", { risk: c.riskLevel }));
  } else if (c.whys.length > 0) {
    parts.push(t(lang, "rationale.notes", { n: c.whys.length }));
  }
  if (parts.length === 0) parts.push(t(lang, "rationale.foundational"));
  return parts.join("; ") + ".";
}

/** Turn a file path into a readable stop title (basename without extension). */
function titleFor(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  return base.replace(/\.[a-z]+$/i, "");
}

export function buildTour(candidates: readonly TourCandidate[], opts: BuildTourOptions = {}): Tour {
  const maxStops = opts.maxStops ?? 12;
  const lang = resolveLanguage(opts.language);
  let pool = [...candidates];
  if (opts.documentedOnly) {
    pool = pool.filter((c) => c.whys.length > 0 || c.decisions.length > 0);
  }

  // Rank by instructiveness, then present foundational-first (most-imported at
  // the top) so a newcomer learns the modules everything else depends on before
  // the leaves. Ties break by risk then path for determinism.
  const ranked = pool
    .map((c) => ({ c, s: score(c) }))
    .sort((a, b) => {
      if (b.s !== a.s) return b.s - a.s;
      if (b.c.inboundCount !== a.c.inboundCount) return b.c.inboundCount - a.c.inboundCount;
      if (RISK_SCORE[b.c.riskLevel] !== RISK_SCORE[a.c.riskLevel]) {
        return RISK_SCORE[b.c.riskLevel] - RISK_SCORE[a.c.riskLevel];
      }
      return a.c.filePath.localeCompare(b.c.filePath);
    })
    .slice(0, maxStops)
    .map(({ c }) => c);

  const stops: TourStop[] = ranked.map((c, i) => ({
    order: i + 1,
    filePath: c.filePath,
    title: titleFor(c.filePath),
    description: c.description,
    rationale: rationaleFor(c, i, lang),
    whys: c.whys,
    decisions: c.decisions,
    riskLevel: c.riskLevel,
    inboundCount: c.inboundCount,
  }));

  return {
    stops,
    stats: {
      candidates: candidates.length,
      stops: stops.length,
      withWhy: stops.filter((s) => s.whys.length > 0 || s.decisions.length > 0).length,
    },
  };
}

export interface FormatTourOptions {
  projectName?: string;
  /** Language for the generated headings/labels. Default "en". */
  language?: Language;
}

/** Render a tour as a readable, paste-ready markdown walkthrough. */
export function formatTourMarkdown(tour: Tour, opts: FormatTourOptions | string = {}): string {
  // Back-compat: a bare string is treated as the project name.
  const o: FormatTourOptions = typeof opts === "string" ? { projectName: opts } : opts;
  const lang = resolveLanguage(o.language);
  const lines: string[] = [];
  lines.push(`# ${t(lang, "tour.title")}${o.projectName ? ` — ${o.projectName}` : ""}`);
  lines.push("");
  lines.push(t(lang, "tour.summary", { stops: tour.stats.stops, withWhy: tour.stats.withWhy }));
  lines.push("");
  for (const s of tour.stops) {
    lines.push(`## ${s.order}. ${s.title}  \`${s.filePath}\``);
    lines.push("");
    lines.push(`${s.description}`);
    lines.push("");
    lines.push(`*${t(lang, "tour.whyHere")}:* ${s.rationale}`);
    if (s.whys.length > 0) {
      lines.push("");
      lines.push(`**${t(lang, "tour.theWhy")}:**`);
      for (const w of s.whys.slice(0, 3)) {
        lines.push(`- ${w.note}${w.tags.length ? `  _(${w.tags.join(", ")})_` : ""}`);
      }
    }
    if (s.decisions.length > 0) {
      lines.push("");
      lines.push(`**${t(lang, "tour.decisions")}:**`);
      for (const d of s.decisions) lines.push(`- ${d.title} _(${d.status})_`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
