// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Comprehension graph types (Phase 2 — P2.1).
 *
 * The comprehension graph is Kodela's answer to "help me understand this
 * codebase" — a file / class / function node graph with plain-English
 * descriptions, *fused with the decision layer*. Structure alone is what
 * competitors show; Kodela's edge is structure **plus the captured why**, so a
 * node can carry not just "what this function is" but "and here's the decision
 * that shaped it and the risk on it".
 *
 * These types are deliberately serialisable (no class instances) so the same
 * graph flows from `@kodela/core` → CLI text/JSON → api-server → dashboard
 * unchanged.
 */

export type ComprehensionNodeKind = "file" | "class" | "function" | "method";

/** A captured-why link hanging off a comprehension node. */
export interface WhyLink {
  /** The context-entry id this why came from. */
  entryId: string;
  /** The note / reason text (already trimmed for display). */
  note: string;
  severity: "critical" | "high" | "medium" | "low";
  tags: string[];
}

/** A decision hanging off a comprehension node (the fusion with the WHY layer). */
export interface DecisionLink {
  decisionId: string;
  title: string;
  status: string;
}

export interface ComprehensionNode {
  /** Stable id: `<filePath>` for files, `<filePath>#<kind>:<name>` otherwise. */
  id: string;
  kind: ComprehensionNodeKind;
  /** Display name (function/class name, or the file's basename for files). */
  name: string;
  filePath: string;
  /** 1-based inclusive line range; absent for file nodes. */
  lineRange?: { start: number; end: number };
  /** Containing class for methods, or the file id for top-level nodes. */
  parentId?: string;
  language?: string;
  /** Plain-English description (heuristic offline, or AI-authored). */
  description: string;
  /** How the description was produced — so the UI can label AI vs heuristic. */
  descriptionSource: "heuristic" | "ai" | "note";
  /** Captured why fused onto this node (may be empty). */
  whys: WhyLink[];
  /** Decisions fused onto this node (may be empty). */
  decisions: DecisionLink[];
  /** Highest severity among this node's whys, for ranking/colouring. */
  riskLevel: "critical" | "high" | "medium" | "low" | "none";
}

export type ComprehensionEdgeKind = "contains" | "method-of";

export interface ComprehensionEdge {
  from: string;
  to: string;
  kind: ComprehensionEdgeKind;
}

export interface ComprehensionGraph {
  nodes: ComprehensionNode[];
  edges: ComprehensionEdge[];
  stats: {
    files: number;
    classes: number;
    functions: number;
    /** Nodes that carry at least one why or decision (the fused ones). */
    documented: number;
    /** Share of nodes with fused why/decision, 0–1. */
    coverage: number;
  };
}
