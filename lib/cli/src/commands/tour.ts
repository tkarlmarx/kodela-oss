// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela tour` (Phase 2 — P2.2 guided tours).
 *
 * Generates a dependency-ordered onboarding walkthrough that weaves in the
 * captured why: it takes the comprehension graph (descriptions + fused
 * whys/decisions per file) and the repo dependency graph (how many files import
 * each module) and produces an ordered, narrated tour — foundational modules
 * first, each stop explaining *why it's here* and hanging the recorded
 * decisions/risk off it. Offline; no API key.
 */
import { buildGraph } from "@kodela/core";
import { buildTour, formatTourMarkdown, type TourCandidate, type Tour } from "@kodela/core/tour";
import type { Language } from "@kodela/core/i18n";
import { runComprehend } from "./comprehend.js";

export interface TourOptions {
  repoRoot: string;
  /** Restrict the tour to files whose path includes this substring. */
  filter?: string;
  maxStops?: number;
  documentedOnly?: boolean;
  projectName?: string;
  /** Language for the generated scaffolding (e.g. "es", "fr"). Default "en". */
  language?: string;
}

export interface TourResult {
  tour: Tour;
  projectName?: string;
  language?: string;
}

/** inbound dependency counts keyed by repo-relative file path. */
async function inboundCounts(repoRoot: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const graph = await buildGraph(repoRoot);
    for (const edge of graph.edges) {
      if (edge.kind !== "dependency") continue;
      // Dependency edge `to` is a file node id: `file:<path>`.
      const to = edge.to.startsWith("file:") ? edge.to.slice("file:".length) : edge.to;
      counts.set(to, (counts.get(to) ?? 0) + 1);
    }
  } catch {
    // No graph (e.g. no entries yet) — every module just gets inbound 0.
  }
  return counts;
}

export async function runTour(opts: TourOptions): Promise<TourResult> {
  const [{ graph }, inbound] = await Promise.all([
    runComprehend({ repoRoot: opts.repoRoot, filter: opts.filter }),
    inboundCounts(opts.repoRoot),
  ]);

  const candidates: TourCandidate[] = graph.nodes
    .filter((n) => n.kind === "file")
    .map((n) => ({
      filePath: n.filePath,
      description: n.description,
      whys: n.whys,
      decisions: n.decisions,
      riskLevel: n.riskLevel,
      inboundCount: inbound.get(n.filePath) ?? 0,
    }));

  const tour = buildTour(candidates, {
    maxStops: opts.maxStops,
    documentedOnly: opts.documentedOnly,
    language: opts.language as Language | undefined,
  });
  return { tour, projectName: opts.projectName, language: opts.language };
}

export function formatTourResult(result: TourResult, output: "text" | "json"): string {
  if (output === "json") {
    return JSON.stringify(result.tour, null, 2);
  }
  return formatTourMarkdown(result.tour, {
    projectName: result.projectName,
    language: result.language as Language | undefined,
  });
}
