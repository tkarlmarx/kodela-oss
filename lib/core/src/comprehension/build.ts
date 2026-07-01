// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Comprehension graph builder (Phase 2 — P2.1).
 *
 * Pure and deterministic: it takes already-parsed files (function nodes from the
 * tree-sitter layer) plus the captured context entries and an optional
 * entry→decision map, and assembles a {@link ComprehensionGraph} with
 * plain-English descriptions and the *why/decision fusion* that is Kodela's
 * differentiator. No I/O here — the CLI/api layer does the parsing and the
 * decision lookup, so this stays trivially testable.
 */

import type { CodeGraphFunction } from "../code-graph/types.js";
import type { ContextEntry } from "../schema/index.js";
import type {
  ComprehensionGraph,
  ComprehensionNode,
  ComprehensionEdge,
  DecisionLink,
  WhyLink,
} from "./types.js";
import {
  heuristicFunctionDescription,
  heuristicFileDescription,
  bestDescription,
} from "./describe.js";

export interface ComprehensionFileInput {
  filePath: string;
  functions: CodeGraphFunction[];
}

export interface BuildComprehensionOptions {
  /** Live context entries — fused onto nodes by file + line-range overlap. */
  entries?: readonly ContextEntry[];
  /** entryId → decisions, so decisions fuse onto whichever node owns the entry. */
  decisionsByEntryId?: Map<string, DecisionLink[]>;
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

function rangesOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function riskFrom(whys: readonly WhyLink[]): ComprehensionNode["riskLevel"] {
  let best = 0;
  let level: ComprehensionNode["riskLevel"] = "none";
  for (const w of whys) {
    const r = SEVERITY_RANK[w.severity] ?? 0;
    if (r > best) {
      best = r;
      level = w.severity;
    }
  }
  return level;
}

export function buildComprehension(
  files: readonly ComprehensionFileInput[],
  opts: BuildComprehensionOptions = {},
): ComprehensionGraph {
  const entries = opts.entries ?? [];
  const decisionsByEntryId = opts.decisionsByEntryId ?? new Map<string, DecisionLink[]>();

  // Index entries by file for a cheap per-file overlap scan.
  const entriesByFile = new Map<string, ContextEntry[]>();
  for (const e of entries) {
    if ((e as { archived?: boolean }).archived === true) continue;
    (entriesByFile.get(e.filePath) ?? entriesByFile.set(e.filePath, []).get(e.filePath)!).push(e);
  }

  const nodes: ComprehensionNode[] = [];
  const edges: ComprehensionEdge[] = [];
  let classCount = 0;
  let functionCount = 0;

  const fuse = (
    filePath: string,
    range: { start: number; end: number } | undefined,
  ): { whys: WhyLink[]; decisions: DecisionLink[] } => {
    const whys: WhyLink[] = [];
    const decisions: DecisionLink[] = [];
    const seenDecision = new Set<string>();
    for (const e of entriesByFile.get(filePath) ?? []) {
      // File nodes (no range) fuse every entry on the file; code nodes fuse only
      // entries whose line range overlaps them.
      if (range && !rangesOverlap(range, e.lineRange)) continue;
      whys.push({
        entryId: e.id,
        note: e.note.length > 200 ? `${e.note.slice(0, 200).trimEnd()}…` : e.note,
        severity: e.severity,
        tags: e.tags,
      });
      for (const d of decisionsByEntryId.get(e.id) ?? []) {
        if (seenDecision.has(d.decisionId)) continue;
        seenDecision.add(d.decisionId);
        decisions.push(d);
      }
    }
    return { whys, decisions };
  };

  for (const file of files) {
    const classNames = file.functions.filter((f) => f.kind === "class").map((f) => f.name);
    const fileFns = file.functions.filter((f) => f.kind !== "class");
    const fileId = file.filePath;

    // ── File node ──────────────────────────────────────────────────────────
    const fileFusion = fuse(file.filePath, undefined);
    const heuristic = heuristicFileDescription(file.filePath, fileFns.length, classNames);
    const fileDesc = bestDescription(heuristic, undefined);
    nodes.push({
      id: fileId,
      kind: "file",
      name: file.filePath.split("/").pop() ?? file.filePath,
      filePath: file.filePath,
      description: fileDesc.description,
      descriptionSource: fileDesc.source,
      whys: fileFusion.whys,
      decisions: fileFusion.decisions,
      riskLevel: riskFrom(fileFusion.whys),
    });

    // ── Class / function / method nodes ──────────────────────────────────────
    const classIdByName = new Map<string, string>();
    for (const fn of file.functions) {
      if (fn.kind === "class") classIdByName.set(fn.name, `${file.filePath}#class:${fn.name}`);
    }

    for (const fn of file.functions) {
      const id = `${file.filePath}#${fn.kind === "method" ? "method" : fn.kind === "class" ? "class" : "function"}:${fn.name}`;
      const range = { start: fn.startLine, end: fn.endLine };
      const fusion = fuse(file.filePath, range);
      // Prefer a captured note as the description when one overlaps this node.
      const topNote = fusion.whys[0]?.note;
      const heuristicDesc = heuristicFunctionDescription(fn);
      const chosen = bestDescription(heuristicDesc, topNote);

      const parentId =
        fn.kind === "method" && fn.parent ? classIdByName.get(fn.parent) ?? fileId : fileId;

      const kind = fn.kind === "class" ? "class" : fn.kind === "method" ? "method" : "function";
      if (kind === "class") classCount++;
      else functionCount++;

      nodes.push({
        id,
        kind,
        name: fn.name,
        filePath: file.filePath,
        lineRange: range,
        parentId,
        language: fn.language,
        description: chosen.description,
        descriptionSource: chosen.source,
        whys: fusion.whys,
        decisions: fusion.decisions,
        riskLevel: riskFrom(fusion.whys),
      });

      edges.push({
        from: parentId,
        to: id,
        kind: fn.kind === "method" ? "method-of" : "contains",
      });
    }
  }

  const documented = nodes.filter((n) => n.whys.length > 0 || n.decisions.length > 0).length;
  return {
    nodes,
    edges,
    stats: {
      files: files.length,
      classes: classCount,
      functions: functionCount,
      documented,
      coverage: nodes.length ? Number((documented / nodes.length).toFixed(3)) : 0,
    },
  };
}
