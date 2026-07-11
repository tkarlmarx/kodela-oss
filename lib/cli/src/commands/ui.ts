// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * kodela ui — a free, local, read-only INTERACTIVE web app for the captured memory.
 *
 * Where `kodela view` writes a static snapshot, `kodela ui` serves a small
 * single-page app on localhost: search across the captured *why*, filter by
 * severity, drill into any file's full history, browse a timeline, and see the
 * "is my agent getting smarter?" metrics. Single-user, local-only, no account,
 * nothing leaves the machine — the open-core counterpart to the commercial
 * dashboard. No build step and no framework: one self-contained HTML page that
 * fetches a single JSON payload from the same process.
 *
 *   kodela ui                 → serve on http://localhost:7420 and open the browser
 *   kodela ui --port 9000     → custom port
 *   kodela ui --no-open       → don't auto-open the browser (CI / remote)
 */
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { importEdges } from "@kodela/core";
import { readAllEntries } from "./status.js";
import { runMetrics } from "./metrics.js";
import { runComprehend } from "./comprehend.js";
import { runTour } from "./tour.js";
import { runArchitecture } from "./architecture.js";

/**
 * The "Understand" payload — comprehension + tour + architecture, all built from
 * the CE engines (offline, no key). This is the *free* visual: the same
 * understanding UA gives away, but with Kodela's captured *why* fused onto every
 * node. Computed lazily (tree-sitter parsing is heavier than the base payload)
 * and trimmed for the browser.
 */
export interface UnderstandData {
  comprehension: {
    stats: { files: number; classes: number; functions: number; documented: number; coverage: number };
    files: Array<{
      filePath: string;
      description: string;
      riskLevel: string;
      whys: Array<{ note: string; severity: string }>;
      children: Array<{ kind: string; name: string; description: string; riskLevel: string; decisions: Array<{ title: string; status: string }> }>;
    }>;
  };
  tour: {
    stats: { stops: number; withWhy: number };
    stops: Array<{ order: number; title: string; filePath: string; description: string; rationale: string; riskLevel: string; inboundCount: number; whys: Array<{ note: string }>; decisions: Array<{ title: string; status: string }> }>;
  };
  architecture: {
    stats: { files: number; layers: number; domains: number };
    layers: Array<{ layer: string; fileCount: number; highestRisk: string }>;
    domains: Array<{ domain: string; fileCount: number }>;
    layerEdges: Array<{ from: string; to: string; weight: number }>;
  };
}

/** Build the free "Understand" payload from the CE engines. Bounded for the browser. */
export async function loadUnderstandData(repoRoot: string): Promise<UnderstandData> {
  const [comp, tour, arch] = await Promise.all([
    runComprehend({ repoRoot, maxFiles: 250 }).catch(() => null),
    runTour({ repoRoot, maxStops: 12 }).catch(() => null),
    runArchitecture({ repoRoot }).catch(() => null),
  ]);

  const childrenByFile = new Map<string, UnderstandData["comprehension"]["files"][number]["children"]>();
  const fileNodes: UnderstandData["comprehension"]["files"] = [];
  if (comp) {
    for (const n of comp.graph.nodes) {
      if (n.kind === "file") continue;
      const list = childrenByFile.get(n.filePath) ?? [];
      list.push({ kind: n.kind, name: n.name, description: n.description, riskLevel: n.riskLevel, decisions: n.decisions.map((d) => ({ title: d.title, status: d.status })) });
      childrenByFile.set(n.filePath, list);
    }
    for (const n of comp.graph.nodes) {
      if (n.kind !== "file") continue;
      const children = childrenByFile.get(n.filePath) ?? [];
      if (children.length === 0 && n.whys.length === 0) continue;
      fileNodes.push({
        filePath: n.filePath,
        description: n.description,
        riskLevel: n.riskLevel,
        whys: n.whys.map((w) => ({ note: w.note, severity: w.severity })),
        children: children.slice(0, 30),
      });
    }
  }

  return {
    comprehension: {
      stats: comp?.graph.stats ?? { files: 0, classes: 0, functions: 0, documented: 0, coverage: 0 },
      files: fileNodes.slice(0, 200),
    },
    tour: {
      stats: tour?.tour.stats ?? { stops: 0, withWhy: 0 },
      stops: (tour?.tour.stops ?? []).map((s) => ({
        order: s.order, title: s.title, filePath: s.filePath, description: s.description,
        rationale: s.rationale, riskLevel: s.riskLevel, inboundCount: s.inboundCount,
        whys: s.whys.slice(0, 2).map((w) => ({ note: w.note })),
        decisions: s.decisions.map((d) => ({ title: d.title, status: d.status })),
      })),
    },
    architecture: {
      stats: arch?.map.stats ?? { files: 0, layers: 0, domains: 0 },
      layers: (arch?.map.layers ?? []).map((l) => ({ layer: l.layer, fileCount: l.fileCount, highestRisk: l.highestRisk })),
      domains: (arch?.map.domains ?? []).slice(0, 12),
      layerEdges: (arch?.map.layerEdges ?? []).slice(0, 18),
    },
  };
}

export type UiOptions = {
  repoRoot: string;
  port?: number;
  open?: boolean;
  /** Interface to bind. Defaults to 127.0.0.1 (local-only). Set 0.0.0.0 to host. */
  host?: string;
};

export const DEFAULT_UI_PORT = 7420;

interface EntryLike {
  filePath: string;
  note: string;
  severity?: string;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
  sessionId?: string;
  lineRange?: { start: number; end: number };
  origin?: { reasoning?: string[]; summary?: string } | null;
}

export interface UiGraphNode {
  id: string;
  label: string;
  count: number;
  source: string;
  /** "file" | "decision" — drives node shape/colour in the radial graph. */
  kind?: string;
}
export interface UiGraphEdge {
  a: string;
  b: string;
  w: number;
  /**
   * "cochange" | "depends" | "implements" —
   *  - cochange:   the two files were captured in the same session (co-occurrence)
   *  - depends:    file `a` imports file `b` (real code-structure edge)
   *  - implements: file `a` implements decision `b` (fused IMPLEMENTS edge)
   */
  kind?: string;
}

export interface UiDecisionOption {
  label: string;
  description: string;
  chosen: boolean;
  rejectionReason: string | null;
}

export interface UiDecision {
  id: string;
  title: string;
  category: string;
  status: string;
  problem: string;
  decision: string;
  reason: string;
  consequences: string | null;
  tradeOffs: string | null;
  outcome: string | null;
  date: string;
  author: string;
  tags: string[];
  options: UiDecisionOption[];
}

export interface UiEntry {
  note: string;
  severity: string;
  source: string;
  date: string;
  lines: string;
  reasoning: string | null;
}

export interface UiFile {
  path: string;
  count: number;
  entries: UiEntry[];
}

export interface UiData {
  project: string;
  purpose: string | null;
  stack: string[];
  stats: { entries: number; files: number; bySource: Record<string, number> };
  files: UiFile[];
  metrics: { memorySize: number; capturesPerSession: number; trendPct: number | null; reusePct: number } | null;
  graph: { nodes: UiGraphNode[]; edges: UiGraphEdge[] };
  decisions: UiDecision[];
  generatedAt: string;
}

/** Dominant capture source for a file (ai | human | mixed | unknown). */
function dominantSource(entries: UiEntry[]): string {
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.source] = (counts[e.source] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
}

/** A file→decision "implements" link, sourced from the fused graph (index.db). */
export interface FusedLink {
  file: string;
  decisionId: string;
}

/**
 * Build the memory graph the radial explorer renders.
 *
 * Two kinds of nodes and two kinds of edges, so the open-core graph shows the
 * *fused* picture — not just which files move together, but which decision each
 * file implements:
 *
 *  - **file** nodes linked by **co-change** (captured in the same session),
 *  - **file** nodes linked by **depends** (file A imports file B — a real
 *    code-structure edge, computed from the source, distinct from co-change), and
 *  - **decision** nodes linked to the files that implement them (**implements**),
 *    sourced from the fused graph's `IMPLEMENTS` edges (file_change -> decision).
 *
 * Single-repo, read-only — the free tier of the graph. (The comprehension /
 * tour / architecture views are also free, on the Understand tab; team hosting,
 * personas, time-travel and path-finding stay in the commercial dashboard.)
 */
function buildGraph(
  files: UiFile[],
  entries: EntryLike[],
  decisions: UiDecision[] = [],
  fusedLinks: FusedLink[] = [],
  sources: Map<string, string> = new Map(),
): { nodes: UiGraphNode[]; edges: UiGraphEdge[] } {
  const topFiles = files.slice(0, 120); // cap for readability + O(n^2) sim cost
  const nodeSet = new Set(topFiles.map((f) => f.path));
  const nodes: UiGraphNode[] = topFiles.map((f) => ({
    id: f.path,
    label: f.path.split("/").pop() ?? f.path,
    count: f.count,
    source: dominantSource(f.entries),
    kind: "file",
  }));

  const bySession = new Map<string, Set<string>>();
  for (const e of entries) {
    if (!e.sessionId) continue;
    const s = bySession.get(e.sessionId) ?? new Set<string>();
    s.add(e.filePath);
    bySession.set(e.sessionId, s);
  }

  const weight = new Map<string, number>();
  // A newline joins the two paths into a Map key: repo-relative paths can never
  // contain one, and it keeps ui.ts plain-text (a NUL separator would make git
  // treat the whole file as binary and hide every diff).
  const SEP = "\n";
  for (const set of bySession.values()) {
    const fileList = [...set].filter((f) => nodeSet.has(f));
    if (fileList.length < 2 || fileList.length > 14) continue; // skip noisy mega-sessions
    fileList.sort();
    for (let i = 0; i < fileList.length; i++) {
      for (let j = i + 1; j < fileList.length; j++) {
        const k = fileList[i] + SEP + fileList[j];
        weight.set(k, (weight.get(k) ?? 0) + 1);
      }
    }
  }
  const edges: UiGraphEdge[] = [...weight.entries()]
    .map(([k, w]) => {
      const [a, b] = k.split(SEP);
      return { a: a!, b: b!, w, kind: "cochange" };
    })
    .sort((x, y) => y.w - x.w)
    .slice(0, 400);

  // Real code-structure edges: file A imports file B. Computed from the actual
  // source of the files on the canvas, so this is genuine import/dependency
  // coupling — not "moved together in a session". A `depends` edge that mirrors
  // an existing `cochange` pair is kept as its own kind so the view can show
  // BOTH "they change together" and "one imports the other".
  const onCanvas = topFiles
    .filter((f) => sources.has(f.path))
    .map((f) => ({ path: f.path, source: sources.get(f.path) ?? "" }));
  for (const dep of importEdges(onCanvas)) {
    if (!nodeSet.has(dep.from) || !nodeSet.has(dep.to)) continue;
    edges.push({ a: dep.from, b: dep.to, w: 2, kind: "depends" });
  }

  // Fuse in the decisions each file implements. A decision node joins the graph
  // only when at least one of its files is on the canvas, so the radial view
  // never sprouts orphan decision nodes.
  const decById = new Map(decisions.map((d) => [d.id, d]));
  const decisionFiles = new Map<string, Set<string>>();
  for (const link of fusedLinks) {
    if (!nodeSet.has(link.file)) continue;
    const s = decisionFiles.get(link.decisionId) ?? new Set<string>();
    s.add(link.file);
    decisionFiles.set(link.decisionId, s);
  }
  for (const [decId, filesForDecision] of decisionFiles) {
    const decNodeId = `decision:${decId}`;
    const meta = decById.get(decId);
    nodes.push({
      id: decNodeId,
      label: meta?.title ?? decId,
      count: filesForDecision.size,
      source: "decision",
      kind: "decision",
    });
    for (const file of filesForDecision) {
      edges.push({ a: file, b: decNodeId, w: 2, kind: "implements" });
    }
  }

  return { nodes, edges };
}

/**
 * Read the on-disk source of the (already size-capped) files that carry captured
 * context, so `buildGraph` can compute real import/dependency edges between them.
 * Best-effort: files that no longer exist (renamed/deleted since capture) or that
 * are too large simply contribute no source and therefore no dependency edges.
 * Only the graph's node set is read — never the whole repo — keeping `kodela ui`
 * single-repo, read-only, and cheap.
 */
async function readSourcesForFiles(
  repoRoot: string,
  files: UiFile[],
): Promise<Map<string, string>> {
  const CAP = 120; // matches buildGraph's topFiles cap — no point reading more
  const MAX_BYTES = 512 * 1024; // skip generated/minified megafiles
  const top = files.slice(0, CAP);
  const out = new Map<string, string>();
  await Promise.allSettled(
    top.map(async (f) => {
      try {
        const abs = path.join(repoRoot, f.path);
        const stat = await fs.stat(abs);
        if (!stat.isFile() || stat.size > MAX_BYTES) return;
        out.set(f.path, await fs.readFile(abs, "utf8"));
      } catch {
        // missing / unreadable — no dependency edges for this file
      }
    }),
  );
  return out;
}

/**
 * Read the fused `IMPLEMENTS` links (file_change -> decision) from the local
 * graph store at `.kodela/index.db`. Open-core, read-only: a plain `node:sqlite`
 * query joined back to `entries` so each edge resolves to a repo-relative path.
 * Returns `[]` whenever the db, the `graph_edges` table, or the edges are absent
 * (older repos, or repos whose annotations never linked a decision) — the graph
 * then simply shows co-change only.
 */
async function readFusedLinks(repoRoot: string): Promise<FusedLink[]> {
  const dbPath = path.join(repoRoot, ".kodela", "index.db");
  try {
    await fs.access(dbPath);
  } catch {
    return [];
  }
  try {
    // node:sqlite is the same engine the core writes the index with; importing
    // it lazily keeps `kodela ui` startup cheap when there is no graph yet.
    const { DatabaseSync } = (await import("node:sqlite")) as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const hasTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type=$t AND name=$n")
        .get({ t: "table", n: "graph_edges" });
      if (!hasTable) return [];
      const rows = db
        .prepare(
          `SELECT e.file_path AS file, ge.target_node_id AS decisionId
             FROM graph_edges ge
             JOIN entries e ON e.id = ge.source_node_id
            WHERE ge.edge_type = 'IMPLEMENTS'
              AND ge.source_node_type = 'FILE_CHANGE'
              AND ge.target_node_type = 'DECISION'
              AND ge.valid_until IS NULL`,
        )
        .all() as Array<{ file: string; decisionId: string }>;
      return rows.filter((r) => r.file && r.decisionId);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** On-disk shape of a `.kodela/decisions/{id}.json` file (the MCP server's grep-able copy). */
interface DecisionFile {
  decision?: {
    id?: string;
    title?: string;
    category?: string;
    status?: string;
    problem?: string;
    decision?: string;
    reason?: string;
    consequences?: string | null;
    trade_offs?: string | null;
    outcome?: string | null;
    author_id?: string;
    tags?: string[];
    decided_at?: string;
  };
  options?: Array<{
    label?: string;
    description?: string;
    was_chosen?: boolean;
    rejection_reason?: string | null;
  }>;
}

/**
 * Read human-authored decisions from the on-disk JSON copies the MCP server
 * persists at `.kodela/decisions/{id}.json`. Open-core, read-only — the CE
 * reads the same files the commercial dashboard does, without importing it.
 * Returns newest-first; an absent directory just means no decisions yet.
 */
async function loadDecisions(repoRoot: string): Promise<UiDecision[]> {
  const dir = path.join(repoRoot, ".kodela", "decisions");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const decisions: UiDecision[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const raw = await readJson<DecisionFile>(path.join(dir, name));
    const d = raw?.decision;
    if (!d || !d.id) continue;
    decisions.push({
      id: d.id,
      title: d.title ?? d.id,
      category: d.category ?? "",
      status: d.status ?? "",
      problem: d.problem ?? "",
      decision: d.decision ?? "",
      reason: d.reason ?? "",
      consequences: d.consequences ?? null,
      tradeOffs: d.trade_offs ?? null,
      outcome: d.outcome ?? null,
      date: (d.decided_at ?? "").slice(0, 10),
      author: d.author_id ?? "",
      tags: Array.isArray(d.tags) ? d.tags : [],
      options: (raw?.options ?? []).map((o) => ({
        label: o.label ?? "",
        description: o.description ?? "",
        chosen: o.was_chosen === true,
        rejectionReason: o.rejection_reason ?? null,
      })),
    });
  }
  decisions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1));
  return decisions;
}

/** Collect the captured memory into the single JSON payload the UI renders. */
export async function loadUiData(repoRoot: string): Promise<UiData> {
  const entries = (await readAllEntries(repoRoot).catch(() => [])) as unknown as EntryLike[];
  const dna = await readJson<{ project?: string; purpose?: string; stack?: string[] }>(
    path.join(repoRoot, ".kodela", "dna", "project.json"),
  );
  const pkg = await readJson<{ name?: string }>(path.join(repoRoot, "package.json"));

  const byFile = new Map<string, UiEntry[]>();
  const bySource: Record<string, number> = {};
  for (const e of entries) {
    const src = e.source ?? "unknown";
    bySource[src] = (bySource[src] ?? 0) + 1;
    const arr = byFile.get(e.filePath) ?? [];
    arr.push({
      note: e.note,
      severity: e.severity ?? "low",
      source: src,
      date: (e.createdAt ?? e.updatedAt ?? "").slice(0, 10),
      lines: e.lineRange ? `L${e.lineRange.start}–${e.lineRange.end}` : "",
      reasoning: e.origin?.reasoning?.length ? e.origin.reasoning.join(" · ") : e.origin?.summary ?? null,
    });
    byFile.set(e.filePath, arr);
  }

  const files: UiFile[] = [...byFile.entries()]
    .map(([p, es]) => ({ path: p, count: es.length, entries: es }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

  const [metrics, decisions, fusedLinks, sources] = await Promise.all([
    runMetrics({ repoRoot })
      .then((m) => ({
        memorySize: m.memorySize,
        capturesPerSession: m.capturesPerSession,
        trendPct: m.trendPct,
        reusePct: m.reusePct,
      }))
      .catch(() => null),
    loadDecisions(repoRoot).catch(() => [] as UiDecision[]),
    readFusedLinks(repoRoot).catch(() => [] as FusedLink[]),
    readSourcesForFiles(repoRoot, files).catch(() => new Map<string, string>()),
  ]);

  return {
    project: dna?.project ?? pkg?.name ?? path.basename(repoRoot),
    purpose: dna?.purpose ?? null,
    stack: dna?.stack ?? [],
    stats: { entries: entries.length, files: byFile.size, bySource },
    files,
    metrics,
    graph: buildGraph(files, entries, decisions, fusedLinks, sources),
    decisions,
    generatedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
  };
}

/** The self-contained interactive page. Pure HTML/CSS/JS — no data inlined, no build. */
export function buildUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kodela memory</title>
<style>
  /* Light theme — aligned with the commercial dashboard for brand cohesion. */
  :root { color-scheme: light; --brand: #cc6a14; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #ffffff; color: #111827; }
  a { color: var(--brand); }
  header { padding: 22px 28px 14px; border-bottom: 1px solid #e5e7eb; background: #fafafa; position: sticky; top: 0; z-index: 5; }
  h1 { margin: 0; font-size: 20px; color: #111827; }
  .read-only { font-size: 11px; font-weight: 700; background: #dcfce7; color: #15803d; border-radius: 999px; padding: 2px 8px; vertical-align: middle; }
  .purpose { color: #6b7280; margin: 8px 0 0; max-width: 80ch; }
  .stack { color: #9ca3af; font-size: 13px; margin-top: 6px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 14px; }
  .tab, .chip { background: #ffffff; border: 1px solid #e5e7eb; color: #374151; border-radius: 8px; padding: 6px 12px; cursor: pointer; font: inherit; font-size: 13px; }
  .tab:hover, .chip:hover { background: #f9fafb; }
  .tab.active { background: var(--brand); border-color: var(--brand); color: #fff; }
  .chip.active { background: #fdebd9; border-color: #f6c89a; color: #b35a0f; }
  #q { background: #ffffff; border: 1px solid #e5e7eb; color: #111827; border-radius: 8px; padding: 7px 11px; min-width: 260px; }
  .stats { display: flex; gap: 18px; color: #6b7280; font-size: 13px; margin-left: auto; }
  main { padding: 16px 28px 64px; }
  .file { margin: 10px 0; border: 1px solid #e5e7eb; border-radius: 10px; background: #ffffff; overflow: hidden; }
  .file > .head { display: flex; align-items: center; gap: 8px; padding: 11px 14px; cursor: pointer; }
  .file > .head:hover { background: #f9fafb; }
  .file .path { font-family: ui-monospace, monospace; color: var(--brand); font-size: 13px; }
  .file .count { color: #9ca3af; font-size: 12px; }
  .file .copy { margin-left: auto; font-size: 12px; }
  .entries { display: none; padding: 4px 14px 12px; }
  .file.open .entries { display: block; }
  .entry { border-left: 3px solid #16a34a; background: #fafafa; border-radius: 8px; padding: 9px 12px; margin: 7px 0; }
  .entry.sev-critical { border-left-color: #dc2626; } .entry.sev-high { border-left-color: #ea580c; }
  .entry.sev-medium { border-left-color: #ca8a04; } .entry.sev-low { border-left-color: #16a34a; }
  .meta { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
  .badge { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; border-radius: 999px; padding: 1px 7px; }
  .badge.sev { background: #f3f4f6; color: #4b5563; } .badge.src { background: #fdebd9; color: #b35a0f; }
  .when { color: #9ca3af; font-size: 12px; margin-left: auto; }
  .note { color: #1f2937; } .reason { color: #6b7280; font-size: 13px; margin-top: 4px; }
  .stat-cards { display: flex; flex-wrap: wrap; gap: 14px; }
  .card { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 14px 18px; min-width: 150px; }
  .card .v { font-size: 24px; font-weight: 700; color: #111827; } .card .l { color: #6b7280; font-size: 12px; }
  .up { color: #16a34a; } .empty { color: #6b7280; padding: 40px 0; }
  button.copy { background: #ffffff; border: 1px solid #e5e7eb; color: #374151; border-radius: 6px; padding: 3px 9px; cursor: pointer; font: inherit; font-size: 12px; }
  /* Graph tab — radial memory map */
  .graphwrap { display: flex; gap: 14px; height: calc(100vh - 230px); min-height: 420px; }
  #gwrap { flex: 1; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden; position: relative;
    background: radial-gradient(120% 90% at 50% 42%, #fff 0%, #fbf7f3 48%, #f4eee8 100%); }
  #gcanvas { width: 100%; height: 100%; display: block; cursor: default; }
  #gcrumb { position: absolute; left: 12px; top: 10px; right: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 2px; z-index: 2; pointer-events: auto; }
  #gcrumb .crumb { font-size: 12px; color: #6b7280; background: rgba(255,255,255,0.85); border: 1px solid #ece6df; border-radius: 7px; padding: 2px 8px; cursor: pointer; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #gcrumb .crumb:hover { color: var(--brand); border-color: #f6c89a; }
  #gcrumb .crumb.cur { color: #b35a0f; background: #fdebd9; border-color: #f6c89a; font-weight: 600; cursor: default; }
  #gcrumb .crumbsep { color: #cbb7a4; font-size: 12px; margin: 0 1px; }
  .glegend { position: absolute; right: 12px; bottom: 10px; display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: #6b7280; background: rgba(255,255,255,0.82); border: 1px solid #ece6df; border-radius: 8px; padding: 5px 9px; pointer-events: none; }
  .glegend span { display: inline-flex; align-items: center; gap: 4px; }
  .glegend .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .glegend .dot.ai { background: #ff8a3d; } .glegend .dot.human { background: #16a34a; } .glegend .dot.mixed { background: #d97706; }
  .glegend .dia { width: 9px; height: 9px; background: #cc6a14; display: inline-block; transform: rotate(45deg); }
  .glegend .spk { width: 14px; height: 0; display: inline-block; }
  .glegend .spk.co { border-top: 2px solid rgba(120,130,150,0.6); }
  .glegend .spk.dep { border-top: 2px solid #2563eb; }
  .glegend .spk.im { border-top: 2px dashed #cc6a14; }
  .ghint { position: absolute; left: 12px; bottom: 10px; max-width: 62%; color: #9ca3af; font-size: 12px; pointer-events: none; }
  #ginfo { width: 340px; border: 1px solid #e5e7eb; border-radius: 12px; padding: 14px; overflow: auto; background: #fff; }
  #ginfo .gp { font-family: ui-monospace, monospace; color: var(--brand); font-size: 13px; word-break: break-all; margin-bottom: 8px; }
  #ginfo .glnk { font-size: 12px; color: #6b7280; margin-bottom: 8px; }
  #ginfo .gdec { color: #b35a0f; margin-right: 6px; white-space: nowrap; }
  #ginfo .gdep { color: #2563eb; margin-right: 6px; white-space: nowrap; }
  /* Decisions tab */
  .dec { border: 1px solid #e5e7eb; border-radius: 12px; background: #fff; padding: 14px 16px; margin: 12px 0; }
  .dec .dhead { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .dec .did { font-family: ui-monospace, monospace; color: #9ca3af; font-size: 12px; }
  .dec .dtitle { font-size: 16px; font-weight: 700; color: #111827; }
  .dec .dwhen { color: #9ca3af; font-size: 12px; margin-left: auto; }
  .badge.cat { background: #fdebd9; color: #b35a0f; } .badge.status { background: #f3f4f6; color: #4b5563; }
  .badge.status-active { background: #dcfce7; color: #15803d; } .badge.status-superseded { background: #fef3c7; color: #92400e; }
  .badge.status-rejected { background: #fee2e2; color: #b91c1c; }
  .dfield { margin-top: 10px; } .dfield .dl { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #9ca3af; }
  .dfield .dv { color: #1f2937; margin-top: 2px; } .dfield .dv.reason { color: #6b7280; font-size: 14px; }
  .opt { border-left: 3px solid #e5e7eb; padding: 4px 10px; margin: 6px 0; background: #fafafa; border-radius: 6px; }
  .opt.chosen { border-left-color: #16a34a; } .opt .ol { font-weight: 600; color: #1f2937; font-size: 13px; }
  .opt .ochosen { color: #15803d; font-size: 11px; font-weight: 700; text-transform: uppercase; margin-left: 6px; }
  .opt .orej { color: #b91c1c; font-size: 12px; margin-top: 2px; } .opt .od { color: #6b7280; font-size: 13px; }
  .dtags { margin-top: 10px; } .dtag { display: inline-block; font-size: 11px; color: #6b7280; background: #f3f4f6; border-radius: 999px; padding: 1px 8px; margin-right: 5px; }
  /* Understand tab — free visual comprehension / tour / architecture */
  .u-sec { max-width: 900px; margin: 0 0 28px; }
  .u-sec h2 { font-size: 17px; color: #111827; margin: 6px 0 12px; }
  .u-sub { font-size: 12px; color: #6b7280; font-weight: 400; }
  .u-file { border: 1px solid #e5e7eb; border-radius: 10px; margin-bottom: 10px; overflow: hidden; background: #fff; }
  .u-fh { padding: 8px 12px; }
  .u-fh code { font-family: ui-monospace, monospace; font-size: 12.5px; color: #b35a0f; }
  .u-desc { color: #4b5563; font-size: 13px; margin: 3px 0; }
  .u-why { color: #3f7d3f; font-size: 12px; margin: 2px 0; }
  .u-dec { color: #b35a0f; font-size: 12px; margin: 1px 0; }
  .u-node { padding: 6px 12px 6px 22px; border-top: 1px solid #f1f5f9; }
  .u-node b { font-size: 13px; color: #111827; } .u-dot { font-size: 11px; }
  .u-stop { padding: 8px 0 10px 12px; margin-bottom: 8px; }
  .u-stop code { font-family: ui-monospace, monospace; font-size: 12px; color: #b35a0f; }
  .u-imp { font-size: 11px; color: #6b7280; } .u-rat { color: #6b7280; font-size: 12px; font-style: italic; margin: 2px 0; }
  .u-bar-row { display: flex; align-items: center; gap: 10px; margin: 5px 0; }
  .u-bar-lbl { width: 180px; font-size: 13px; color: #374151; } .u-bar-n { width: 44px; text-align: right; color: #6b7280; font-size: 12px; }
  .u-bar { flex: 1; height: 8px; background: #eef2f7; border-radius: 4px; overflow: hidden; }
  .u-bar-fill { display: block; height: 100%; }
  .u-edges { margin-top: 12px; font-size: 12px; color: #4b5563; }
  .u-edge { display: inline-block; background: #f3f4f6; border-radius: 6px; padding: 2px 8px; margin: 3px 4px 0 0; } .u-edge i { color: #9ca3af; }
  /* Help tab */
  .help { max-width: 820px; }
  .help h2 { font-size: 16px; color: #111827; margin: 22px 0 8px; }
  .help h2:first-child { margin-top: 4px; }
  .help p { color: #374151; margin: 6px 0; }
  .help ul { margin: 6px 0; padding-left: 0; list-style: none; }
  .help li { margin: 8px 0; color: #374151; }
  .help li b { color: #111827; }
  .help code { font-family: ui-monospace, monospace; font-size: 12.5px; background: #f3f4f6; color: #b35a0f; border-radius: 5px; padding: 1px 6px; }
  .help .tagk { display: inline-block; min-width: 92px; font-weight: 600; color: var(--brand); }
  .help .note { color: #6b7280; font-size: 13px; }
  .help .pills { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 2px; }
  .help .pill { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 12px; font-size: 13px; color: #374151; }
</style>
</head>
<body>
<header>
  <h1><svg viewBox="0 0 56 56" width="22" height="22" aria-hidden="true" style="vertical-align:-4px"><path d="M17,7 L17,49 M17,28 L35,16 M17,28 L35,42" fill="none" stroke="#ff8a3d" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg> <span id="proj">Kodela</span> <span class="read-only">read-only · local</span></h1>
  <p class="purpose" id="purpose"></p>
  <p class="stack" id="stack"></p>
  <div class="controls">
    <button class="tab active" data-tab="files">Files</button>
    <button class="tab" data-tab="understand">Understand</button>
    <button class="tab" data-tab="graph">Graph</button>
    <button class="tab" data-tab="decisions">Decisions</button>
    <button class="tab" data-tab="timeline">Timeline</button>
    <button class="tab" data-tab="health">Memory health</button>
    <button class="tab" data-tab="help">Help</button>
    <input id="q" type="search" placeholder="Search the why — file or text…" aria-label="Search">
    <span id="sev-chips">
      <button class="chip active" data-sev="all">All</button>
      <button class="chip" data-sev="critical">Critical</button>
      <button class="chip" data-sev="high">High</button>
      <button class="chip" data-sev="medium">Medium</button>
      <button class="chip" data-sev="low">Low</button>
    </span>
    <span class="stats" id="stats"></span>
  </div>
</header>
<main id="main"><p class="empty">Loading captured memory…</p></main>
<script>
(function () {
  var DATA = null, tab = "files", sev = "all", term = "", graphRaf = null;
  var UNDERSTAND = null, uLoading = false, uErr = null;
  var esc = function (s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); };
  var RISKC = { critical: "#dc2626", high: "#ea580c", medium: "#d97706", low: "#65a30d", none: "#cbd5e1" };

  function loadUnderstand() {
    uLoading = true; uErr = null;
    fetch("/api/understand").then(function (r) { return r.json(); }).then(function (d) {
      uLoading = false;
      if (d && d.error) { uErr = d.error; } else { UNDERSTAND = d; }
      if (tab === "understand") render();
    }).catch(function (e) { uLoading = false; uErr = String(e); if (tab === "understand") render(); });
  }

  function renderUnderstand() {
    if (uErr) return '<p class="empty">Could not build the understanding view: ' + esc(uErr) + '</p>';
    if (!UNDERSTAND) return '<p class="empty">Building comprehension, tour and architecture from your code — this parses the repo, so it takes a moment…</p>';
    var U = UNDERSTAND, h = "";
    // ── Comprehension ──
    var cs = U.comprehension.stats;
    h += '<div class="u-sec"><h2>Comprehension <span class="u-sub">' + cs.files + ' files · ' + cs.functions + ' functions · ' + Math.round((cs.coverage||0)*100) + '% carry captured why</span></h2>';
    if (!U.comprehension.files.length) h += '<p class="empty">No source parsed yet — capture some context, then reopen.</p>';
    U.comprehension.files.forEach(function (f) {
      h += '<div class="u-file"><div class="u-fh" style="border-left:3px solid ' + (RISKC[f.riskLevel]||RISKC.none) + '"><code>' + esc(f.filePath) + '</code><div class="u-desc">' + esc(f.description) + '</div>';
      f.whys.forEach(function (w) { h += '<div class="u-why">↳ ' + esc(w.note) + '</div>'; });
      h += '</div>';
      f.children.forEach(function (c) {
        h += '<div class="u-node"><span class="u-dot" style="color:' + (RISKC[c.riskLevel]||RISKC.none) + '">●</span> <b>' + esc(c.kind) + ' ' + esc(c.name) + '</b><div class="u-desc">' + esc(c.description) + '</div>';
        c.decisions.forEach(function (d) { h += '<div class="u-dec">◆ ' + esc(d.title) + ' (' + esc(d.status) + ')</div>'; });
        h += '</div>';
      });
      h += '</div>';
    });
    h += '</div>';
    // ── Guided tour ──
    var ts = U.tour.stats;
    h += '<div class="u-sec"><h2>Guided tour <span class="u-sub">' + ts.stops + ' stops · ' + ts.withWhy + ' carry captured why</span></h2>';
    U.tour.stops.forEach(function (s) {
      h += '<div class="u-stop" style="border-left:3px solid ' + (RISKC[s.riskLevel]||RISKC.none) + '"><b>' + s.order + '. ' + esc(s.title) + '</b> <code>' + esc(s.filePath) + '</code>' + (s.inboundCount ? ' <span class="u-imp">← ' + s.inboundCount + ' importers</span>' : '') + '<div class="u-desc">' + esc(s.description) + '</div><div class="u-rat"><i>Why here:</i> ' + esc(s.rationale) + '</div>';
      s.whys.forEach(function (w) { h += '<div class="u-why">↳ ' + esc(w.note) + '</div>'; });
      s.decisions.forEach(function (d) { h += '<div class="u-dec">◆ ' + esc(d.title) + ' (' + esc(d.status) + ')</div>'; });
      h += '</div>';
    });
    h += '</div>';
    // ── Architecture ──
    var as = U.architecture.stats, maxL = 1;
    U.architecture.layers.forEach(function (l) { if (l.fileCount > maxL) maxL = l.fileCount; });
    h += '<div class="u-sec"><h2>Architecture <span class="u-sub">' + as.files + ' files · ' + as.layers + ' layers · ' + as.domains + ' domains</span></h2>';
    U.architecture.layers.forEach(function (l) {
      h += '<div class="u-bar-row"><span class="u-bar-lbl">' + esc(l.layer) + (l.highestRisk !== "none" ? ' <span style="color:' + (RISKC[l.highestRisk]||RISKC.none) + ';font-size:11px">● ' + esc(l.highestRisk) + '</span>' : '') + '</span><span class="u-bar"><span class="u-bar-fill" style="width:' + Math.round((l.fileCount/maxL)*100) + '%;background:' + (RISKC[l.highestRisk] && l.highestRisk !== "none" ? RISKC[l.highestRisk] : "var(--brand)") + '"></span></span><span class="u-bar-n">' + l.fileCount + '</span></div>';
    });
    if (U.architecture.layerEdges.length) {
      h += '<div class="u-edges"><b>Layer dependencies:</b> ';
      U.architecture.layerEdges.forEach(function (e) { h += '<span class="u-edge">' + esc(e.from) + ' → ' + esc(e.to) + ' <i>×' + e.weight + '</i></span>'; });
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  function matchEntry(file, e) {
    if (sev !== "all" && e.severity !== sev) return false;
    if (!term) return true;
    var hay = (file + " " + e.note + " " + (e.reasoning || "")).toLowerCase();
    return hay.indexOf(term) !== -1;
  }
  // Used by the graph to check if a file node has at least one entry matching
  // the active severity filter. Decision nodes always pass (no severity).
  function nodeMatchesSev(nodeId) {
    if (sev === "all") return true;
    var f = DATA && DATA.files.find(function (fl) { return fl.path === nodeId; });
    if (!f) return true; // decision nodes or unknown — don't dim
    return f.entries.some(function (e) { return e.severity === sev; });
  }
  function entryHtml(e) {
    return '<div class="entry sev-' + esc(e.severity) + '">' +
      '<div class="meta"><span class="badge sev">' + esc(e.severity) + '</span>' +
      '<span class="badge src">' + esc(e.source) + '</span>' +
      (e.lines ? '<span class="when">' + esc(e.lines) + '</span>' : '') +
      '<span class="when">' + esc(e.date) + '</span></div>' +
      '<div class="note">' + esc(e.note) + '</div>' +
      (e.reasoning ? '<div class="reason">↳ ' + esc(e.reasoning) + '</div>' : '') + '</div>';
  }
  function shareSnippet(file, entries) {
    var lines = ["## Why this changed — \`" + file + "\`", ""];
    entries.forEach(function (e) {
      lines.push("- (" + e.severity + " · " + e.source + ") — " + e.note.replace(/\\s+/g, " ").trim());
      if (e.reasoning) lines.push("  - " + e.reasoning.replace(/\\s+/g, " ").trim());
    });
    lines.push("", "_Captured with Kodela._");
    return lines.join("\\n");
  }
  function renderFiles() {
    var html = "", shown = 0;
    DATA.files.forEach(function (f, i) {
      var visible = f.entries.filter(function (e) { return matchEntry(f.path, e); });
      if (!visible.length) return;
      shown++;
      html += '<div class="file' + (term ? ' open' : '') + '" data-i="' + i + '">' +
        '<div class="head"><span class="path">' + esc(f.path) + '</span>' +
        '<span class="count">' + visible.length + (visible.length !== f.count ? "/" + f.count : "") + '</span>' +
        '<button class="copy" data-copy="' + i + '">Copy why for PR</button></div>' +
        '<div class="entries">' + visible.map(entryHtml).join("") + '</div></div>';
    });
    return shown ? html : '<p class="empty">No captured context matches.</p>';
  }
  function renderTimeline() {
    var all = [];
    DATA.files.forEach(function (f) { f.entries.forEach(function (e) { if (matchEntry(f.path, e)) all.push({ f: f.path, e: e }); }); });
    all.sort(function (a, b) { return a.e.date < b.e.date ? 1 : -1; });
    if (!all.length) return '<p class="empty">No captured context matches.</p>';
    return all.map(function (x) {
      return '<div class="file open"><div class="head"><span class="path">' + esc(x.f) + '</span></div>' +
        '<div class="entries">' + entryHtml(x.e) + '</div></div>';
    }).join("");
  }
  function renderHealth() {
    var m = DATA.metrics;
    if (!m) return '<p class="empty">No metrics yet.</p>';
    var trend = m.trendPct == null ? "" : '<div class="l ' + (m.trendPct > 0 ? "up" : "") + '">' + (m.trendPct > 0 ? "▲ +" : "") + m.trendPct + '% vs early</div>';
    return '<div class="stat-cards">' +
      '<div class="card"><div class="v">' + m.memorySize + '</div><div class="l">captured changes</div></div>' +
      '<div class="card"><div class="v">' + m.capturesPerSession + '</div><div class="l">captures / session</div>' + trend + '</div>' +
      '<div class="card"><div class="v">' + m.reusePct + '%</div><div class="l">sessions reuse prior context</div></div>' +
      '</div><p class="purpose" style="margin-top:18px">' +
      (m.reusePct >= 50 ? "Most sessions stand on prior memory — the loop is compounding." : "Memory is still building. As reuse climbs, agents start each task with more context.") + '</p>';
  }
  function matchDecision(d) {
    if (!term) return true;
    var hay = (d.id + " " + d.title + " " + d.problem + " " + d.decision + " " + d.reason + " " + (d.tags || []).join(" ")).toLowerCase();
    return hay.indexOf(term) !== -1;
  }
  function optHtml(o) {
    return '<div class="opt' + (o.chosen ? ' chosen' : '') + '">' +
      '<div class="ol">' + esc(o.label) + (o.chosen ? '<span class="ochosen">✓ chosen</span>' : '') + '</div>' +
      (o.description ? '<div class="od">' + esc(o.description) + '</div>' : '') +
      (!o.chosen && o.rejectionReason ? '<div class="orej">✗ ' + esc(o.rejectionReason) + '</div>' : '') + '</div>';
  }
  function field(label, value, cls) {
    if (!value) return '';
    return '<div class="dfield"><div class="dl">' + esc(label) + '</div><div class="dv' + (cls ? ' ' + cls : '') + '">' + esc(value) + '</div></div>';
  }
  function renderDecisions() {
    var decs = (DATA.decisions || []).filter(matchDecision);
    if (!(DATA.decisions || []).length) return '<p class="empty">No decisions captured yet. Decisions are human-authored — record one with the <code>kodela_record_decision</code> MCP tool and it appears here.</p>';
    if (!decs.length) return '<p class="empty">No decisions match.</p>';
    return decs.map(function (d) {
      var st = (d.status || "").toLowerCase();
      return '<div class="dec">' +
        '<div class="dhead"><span class="dtitle">' + esc(d.title) + '</span>' +
        '<span class="did">' + esc(d.id) + '</span>' +
        (d.category ? '<span class="badge cat">' + esc(d.category) + '</span>' : '') +
        (d.status ? '<span class="badge status status-' + esc(st) + '">' + esc(d.status) + '</span>' : '') +
        (d.date ? '<span class="dwhen">' + esc(d.date) + '</span>' : '') + '</div>' +
        field("Problem", d.problem) +
        field("Decision", d.decision) +
        field("Reason", d.reason, "reason") +
        field("Consequences", d.consequences, "reason") +
        field("Trade-offs", d.tradeOffs, "reason") +
        field("Outcome", d.outcome, "reason") +
        (d.options && d.options.length ? '<div class="dfield"><div class="dl">Options considered</div>' + d.options.map(optHtml).join("") + '</div>' : '') +
        (d.tags && d.tags.length ? '<div class="dtags">' + d.tags.map(function (t) { return '<span class="dtag">' + esc(t) + '</span>'; }).join("") + '</div>' : '') +
        '</div>';
    }).join("");
  }
  function renderHelp() {
    return '<div class="help">' +
      '<h2>What is this?</h2>' +
      '<p>Kodela captures the <b>why</b> behind every code change — who changed it (you or which AI tool), the problem it solved, the reasoning, and the alternatives rejected — and keeps it next to the code. This is the free, local, read-only viewer for that captured memory. No account; nothing leaves your machine.</p>' +
      '<h2>The tabs</h2><ul>' +
      '<li><span class="tagk">Files</span> Every file with captured context, most-active first. Click a file to expand its full why-history. <b>Copy why for PR</b> puts a Markdown summary on your clipboard to paste into a pull request.</li>' +
      '<li><span class="tagk">Graph</span> A <b>radial memory map</b>. The centre is your project; the first ring is its most-active files. Click a file to make it the new centre and fan out the files it co-changes with (grey spokes), the files it <b>imports</b> (blue spokes with an arrow — real code structure, not just what moved together), and the <b>decisions it implements</b> (copper diamonds, dashed spokes) — so you see the <i>why</i> and the <i>wiring</i>, not just co-occurrence. Click a decision to see every file that implements it. The breadcrumb climbs back out; <code>+N</code> pages through a crowded ring; scroll to zoom. Node size = activity; colour = who captured it (copper = AI, green = human, amber = mixed).</li>' +
      '<li><span class="tagk">Decisions</span> Human-authored decisions — the problem, the decision, the reasoning, the options considered (chosen vs rejected), and the outcome. Read-only here.</li>' +
      '<li><span class="tagk">Timeline</span> Every captured change, newest first, so you can replay how the reasoning in your codebase evolved.</li>' +
      '<li><span class="tagk">Memory health</span> Whether your agent is getting smarter: memory size, captures per session and its trend, and how often sessions reuse prior context.</li>' +
      '</ul>' +
      '<h2>Search &amp; filter</h2>' +
      '<p>The <b>search box</b> matches file paths and captured text across Files, Graph, Timeline, and Decisions. The <b>severity chips</b> (Critical → Low) narrow Files and Timeline to the risk level you care about.</p>' +
      '<h2>Tips</h2><ul>' +
      '<li>Every view is <b>deep-linkable</b> — the URL carries <code>?tab=</code>, <code>?q=</code>, and <code>?sev=</code>, so you can bookmark or share a specific view (it stays local).</li>' +
      '<li>This viewer is <b>read-only</b>. To capture more context, let Kodela watch your work or have your AI agent record it.</li>' +
      '</ul>' +
      '<h2>Capture more context</h2><div class="pills">' +
      '<span class="pill"><code>kodela connect --apply --npx</code> — wire Kodela into your AI tools</span>' +
      '<span class="pill"><code>kodela watch --auto-annotate</code> — capture as you work</span>' +
      '<span class="pill"><code>kodela pack</code> — one AI-ready file of repo + why</span>' +
      '<span class="pill"><code>kodela metrics</code> — the numbers behind Memory health</span>' +
      '</div>' +
      '<h2>Community Edition</h2>' +
      '<p class="note">This is the free, Apache-2.0 Community Edition — <b>one developer, one repository, entirely on your machine</b> (no account, no cloud). It includes the full memory graph (co-change, imports and function→decision), contradiction checks and risk scoring. Team, Cloud, and Enterprise editions add shared team memory across repos, a collaborative dashboard, decision-integrity governance (scorecard, roles, sign-off, audit) and PR checks, and hosted or air-gapped deployment.</p>' +
      '</div>';
  }
  function srcColor(s) { return s === "ai" ? "#ff8a3d" : s === "human" ? "#16a34a" : s === "mixed" ? "#d97706" : s === "decision" ? "#cc6a14" : s === "root" ? "#FF8A3D" : "#9ca3af"; }
  function renderGraph() {
    var g = DATA.graph || { nodes: [], edges: [] };
    if (!g.nodes.length) return '<p class="empty">No graph yet — capture changes across a few sessions and the radial map fills in here.</p>';
    var files = g.nodes.filter(function (n) { return n.kind !== "decision"; }).length;
    var decs = g.nodes.length - files;
    var impl = g.edges.filter(function (e) { return e.kind === "implements"; }).length;
    var dep = g.edges.filter(function (e) { return e.kind === "depends"; }).length;
    var co = g.edges.length - impl - dep;
    return '<div class="graphwrap"><div id="gwrap">' +
      '<div id="gcrumb"></div>' +
      '<canvas id="gcanvas"></canvas>' +
      '<div class="glegend">' +
        '<span><i class="dot ai"></i>AI</span><span><i class="dot human"></i>human</span>' +
        '<span><i class="dot mixed"></i>mixed</span><span><i class="dia"></i>decision</span>' +
        '<span><i class="spk co"></i>co-change</span><span><i class="spk dep"></i>imports</span><span><i class="spk im"></i>implements</span>' +
      '</div>' +
      '<div class="ghint">' + files + ' files · ' + decs + ' decisions · ' + co + ' co-change · ' + dep + ' imports · ' + impl + ' implements — click the center to expand, a node to dive in, a crumb to go back</div>' +
      '</div>' +
      '<aside id="ginfo"></aside></div>';
  }
  function initGraph() {
    var g = DATA.graph; if (!g || !g.nodes.length) return;
    var canvas = document.getElementById("gcanvas"); if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var dpr = window.devicePixelRatio || 1, W = 0, H = 0, cx = 0, cy = 0;
    function perfNow() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

    // ---- model: nodes + adjacency, plus a synthetic project root ----
    var byId = {}; g.nodes.forEach(function (n) { byId[n.id] = n; });
    var ROOT = "__project__";
    byId[ROOT] = { id: ROOT, label: DATA.project || "Project", kind: "root", count: 0, source: "root" };
    var adj = {};
    function link(a, b, w, kind) { (adj[a] = adj[a] || []).push({ id: b, w: w, kind: kind }); }
    g.edges.forEach(function (e) { if (!byId[e.a] || !byId[e.b]) return; link(e.a, e.b, e.w, e.kind || "cochange"); link(e.b, e.a, e.w, e.kind || "cochange"); });
    adj[ROOT] = g.nodes.filter(function (n) { return n.kind !== "decision"; })
      .sort(function (a, b) { return b.count - a.count; })
      .map(function (n) { return { id: n.id, w: 1, kind: "root" }; });

    function kindOf(id) { return byId[id] ? byId[id].kind : "file"; }
    function childrenOf(id) {
      // Show every neighbour (including the one we arrived from) so a decision
      // fans out ALL the files that implement it; the breadcrumb is the way back.
      var seen = {}, out = [];
      (adj[id] || []).forEach(function (e) {
        if (e.id === id) return;
        if (seen[e.id]) { if (e.w > seen[e.id].w) seen[e.id] = e; return; }
        seen[e.id] = e; out.push(e);
      });
      out.sort(function (a, b) {
        var ad = kindOf(a.id) === "decision" ? 0 : 1, bd = kindOf(b.id) === "decision" ? 0 : 1;
        if (ad !== bd) return ad - bd;
        var ac = byId[a.id] ? byId[a.id].count : 0, bc = byId[b.id] ? byId[b.id].count : 0;
        return (b.w - a.w) || (bc - ac);
      });
      return out;
    }
    function decisionsForFile(id) {
      return (adj[id] || []).filter(function (e) { return kindOf(e.id) === "decision"; })
        .map(function (e) { return byId[e.id] ? byId[e.id].label : e.id; });
    }

    // ---- view state ----
    var CAP = 13, focus = ROOT, parent = null, page = 0;
    var trail = [{ id: ROOT, parent: null }];
    var selected = ROOT, hoverId = null, zoom = 1;
    var pos = {}, view = [];

    function ringRadius() { return Math.max(120, Math.min(W, H) * 0.5 - 96) * zoom; }
    function nodeR(it) {
      if (it.isMore) return 16;
      var nd = it.node; if (!nd) return 9;
      if (it.ring === 0) return nd.kind === "root" ? 30 : 25;
      if (nd.kind === "decision") return 12;
      return 7 + Math.sqrt(nd.count || 1) * 2.2;
    }
    function labelText(nd) { if (!nd) return ""; var l = nd.label || nd.id; return l.length > 24 ? l.slice(0, 23) + "…" : l; }

    function buildView() {
      var kids = childrenOf(focus);
      var pages = Math.ceil(kids.length / CAP) || 1; if (page >= pages) page = 0;
      var slice = kids.slice(page * CAP, page * CAP + CAP);
      var hasMore = kids.length > CAP;
      var n = slice.length + (hasMore ? 1 : 0);
      var R = ringRadius(), a0 = -Math.PI / 2;
      view = [{ id: focus, node: byId[focus], ring: 0, tx: 0, ty: 0, isMore: false }];
      for (var i = 0; i < slice.length; i++) {
        var ang = a0 + i * 2 * Math.PI / Math.max(n, 1);
        view.push({ id: slice[i].id, node: byId[slice[i].id], ring: 1, w: slice[i].w, ekind: slice[i].kind, isMore: false, tx: Math.cos(ang) * R, ty: Math.sin(ang) * R });
      }
      if (hasMore) {
        var ang2 = a0 + (n - 1) * 2 * Math.PI / Math.max(n, 1);
        view.push({ id: "__more__", node: null, ring: 1, isMore: true, more: kids.length - slice.length, tx: Math.cos(ang2) * R, ty: Math.sin(ang2) * R });
      }
      view.forEach(function (it) { if (!pos[it.id]) pos[it.id] = { x: 0, y: 0 }; }); // new nodes bloom from centre
    }

    function colorFor(nd) { if (!nd) return "#9ca3af"; if (nd.kind === "decision") return "#cc6a14"; if (nd.kind === "root") return "#FF8A3D"; return srcColor(nd.source); }
    function drawK(x, y, r) {
      var s = r * 1.7 / 56, ox = x - 26 * s, oy = y - 28 * s;
      ctx.strokeStyle = "#fff"; ctx.lineWidth = Math.max(2, r * 0.13); ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(ox + 17 * s, oy + 7 * s); ctx.lineTo(ox + 17 * s, oy + 49 * s);
      ctx.moveTo(ox + 17 * s, oy + 28 * s); ctx.lineTo(ox + 35 * s, oy + 16 * s);
      ctx.moveTo(ox + 17 * s, oy + 28 * s); ctx.lineTo(ox + 35 * s, oy + 42 * s);
      ctx.stroke();
    }
    function diamond(x, y, r, col, strong) {
      ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
      ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = strong ? "#111827" : "rgba(255,255,255,0.9)"; ctx.lineWidth = strong ? 2.5 : 1.5; ctx.stroke();
    }
    function ease() {
      var moving = false;
      view.forEach(function (it) { var p = pos[it.id]; var dx = it.tx - p.x, dy = it.ty - p.y; p.x += dx * 0.18; p.y += dy * 0.18; if (Math.abs(dx) > 0.4 || Math.abs(dy) > 0.4) moving = true; });
      return moving;
    }
    function draw() {
      ctx.clearRect(0, 0, W, H);
      var now = perfNow(), center = pos[focus], ccx = cx + center.x, ccy = cy + center.y;
      // spokes from the focus to each ring node
      view.forEach(function (it) {
        if (it.ring !== 1) return; var p = pos[it.id];
        // Spoke style by relationship:
        //  - implements (file↔decision): copper + dashed, both directions
        //  - depends (file imports file): solid blue + arrowhead toward the import
        //  - co-change (session co-occurrence): faint grey
        var foc = byId[focus];
        var isImpl = (it.node && it.node.kind === "decision") || (foc && foc.kind === "decision");
        var isDep = !isImpl && it.ekind === "depends";
        ctx.strokeStyle = isImpl ? "rgba(204,106,20,0.55)" : isDep ? "rgba(37,99,235,0.55)" : "rgba(120,130,150,0.30)";
        ctx.lineWidth = isImpl ? 2 : isDep ? 1.8 : 1.2;
        ctx.setLineDash(isImpl ? [5, 4] : []);
        var ex = cx + p.x, ey = cy + p.y;
        ctx.beginPath(); ctx.moveTo(ccx, ccy); ctx.lineTo(ex, ey); ctx.stroke();
        if (isDep) {
          // small arrowhead ~72% along the spoke, pointing at the imported file
          var dx = ex - ccx, dy = ey - ccy, L = Math.sqrt(dx * dx + dy * dy) || 1;
          var ux = dx / L, uy = dy / L, hx = ccx + dx * 0.72, hy = ccy + dy * 0.72, ah = 6;
          ctx.fillStyle = "rgba(37,99,235,0.7)";
          ctx.beginPath();
          ctx.moveTo(hx, hy);
          ctx.lineTo(hx - ux * ah - uy * ah * 0.6, hy - uy * ah + ux * ah * 0.6);
          ctx.lineTo(hx - ux * ah + uy * ah * 0.6, hy - uy * ah - ux * ah * 0.6);
          ctx.closePath(); ctx.fill();
        }
      });
      ctx.setLineDash([]);
      // centre glow + orbit ring — echoes the Kodela loader
      var gp = 0.5 + 0.5 * Math.sin(now / 650);
      var rg = ctx.createRadialGradient(ccx, ccy, 4, ccx, ccy, 56 + gp * 10);
      rg.addColorStop(0, "rgba(255,138,61,0.22)"); rg.addColorStop(1, "rgba(255,138,61,0)");
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(ccx, ccy, 56 + gp * 10, 0, 6.2832); ctx.fill();
      ctx.strokeStyle = "rgba(255,138,61," + (0.22 + gp * 0.22) + ")"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(ccx, ccy, 42 + gp * 4, 0, 6.2832); ctx.stroke();
      // nodes
      view.forEach(function (it) {
        var p = pos[it.id], x = cx + p.x, y = cy + p.y, r = nodeR(it);
        var isSel = selected === it.id, isHover = hoverId === it.id;
        if (it.isMore) {
          ctx.fillStyle = "#fff"; ctx.strokeStyle = "#cc6a14"; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill(); ctx.stroke();
          ctx.fillStyle = "#b35a0f"; ctx.font = "11px ui-sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText("+" + it.more, x, y); ctx.textAlign = "start"; ctx.textBaseline = "alphabetic"; return;
        }
        var nd = it.node, col = colorFor(nd);
        var dimByTerm = term && it.ring === 1 && nd && nd.id.toLowerCase().indexOf(term) === -1 && (nd.label || "").toLowerCase().indexOf(term) === -1;
        var dimBySev = sev !== "all" && it.ring === 1 && nd && !nodeMatchesSev(nd.id);
        var dim = dimByTerm || dimBySev;
        ctx.globalAlpha = dim ? 0.22 : 1;
        if (nd && nd.kind === "decision") { diamond(x, y, r, col, isSel || isHover); }
        else {
          ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fillStyle = col; ctx.fill();
          if (it.ring === 0 && nd && nd.kind === "root") drawK(x, y, r);
          if (isSel || isHover) { ctx.lineWidth = 2.5; ctx.strokeStyle = "#111827"; ctx.beginPath(); ctx.arc(x, y, r + 1, 0, 6.2832); ctx.stroke(); }
        }
        ctx.globalAlpha = 1;
        var showLabel = !it.isMore; // every node carries its name in the radial map
        if (showLabel) {
          ctx.fillStyle = it.ring === 0 ? "#111827" : "#374151"; ctx.font = (it.ring === 0 ? "600 13px " : "11px ") + "ui-sans-serif";
          ctx.textAlign = "center"; ctx.fillText(it.ring === 0 ? (nd ? nd.label : "") : labelText(nd), x, y + r + 13); ctx.textAlign = "start";
        }
      });
    }
    function stale() { return canvas !== document.getElementById("gcanvas"); }
    function frame() { if (stale()) { graphRaf = null; return; } ease(); draw(); graphRaf = requestAnimationFrame(frame); }

    function resize() { W = canvas.clientWidth; H = canvas.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); cx = W / 2; cy = H / 2; }

    function decBrief(d) {
      function row(l, v) { return v ? '<div class="dfield"><div class="dl">' + esc(l) + '</div><div class="dv reason">' + esc(v) + '</div></div>' : ''; }
      return (d.status ? '<span class="badge status status-' + esc((d.status || "").toLowerCase()) + '">' + esc(d.status) + '</span>' : '') +
        row("Problem", d.problem) + row("Decision", d.decision) + row("Reason", d.reason);
    }
    function legendHtml() {
      return '<div class="gp">' + esc(DATA.project || "Project") + '</div>' +
        '<p class="note">The radial memory map. The centre is your project; the first ring is its most-active files. ' +
        'Click a file to make it the centre and fan out the files it co-changes with and the <b>decisions</b> it implements. ' +
        'Click a decision to see every file that implements it. Use the breadcrumb to climb back out.</p>';
    }
    function updateInfo() {
      var info = document.getElementById("ginfo"); if (!info) return;
      var nd = byId[selected];
      if (!nd || nd.kind === "root") { info.innerHTML = legendHtml(); return; }
      if (nd.kind === "decision") {
        var did = nd.id.indexOf("decision:") === 0 ? nd.id.slice(9) : nd.id;
        var d = (DATA.decisions || []).filter(function (x) { return x.id === did; })[0];
        info.innerHTML = '<div class="gp">◆ ' + esc(nd.label) + '</div>' + (d ? decBrief(d) : '<p class="note">Decision ' + esc(did) + '</p>'); return;
      }
      var f = null; for (var i = 0; i < DATA.files.length; i++) { if (DATA.files[i].path === nd.id) { f = DATA.files[i]; break; } }
      var decs = decisionsForFile(nd.id);
      var base = function (p) { return p.split("/").pop() || p; };
      var imports = [], importedBy = [];
      (DATA.graph.edges || []).forEach(function (e) {
        if (e.kind !== "depends") return;
        if (e.a === nd.id) imports.push(e.b);
        else if (e.b === nd.id) importedBy.push(e.a);
      });
      var depHtml = "";
      if (imports.length) depHtml += '<div class="glnk">Imports ' + imports.map(function (x) { return '<span class="gdep">→ ' + esc(base(x)) + '</span>'; }).join(" ") + '</div>';
      if (importedBy.length) depHtml += '<div class="glnk">Imported by ' + importedBy.map(function (x) { return '<span class="gdep">← ' + esc(base(x)) + '</span>'; }).join(" ") + '</div>';
      info.innerHTML = '<div class="gp">' + esc(nd.id) + '</div>' +
        (decs.length ? '<div class="glnk">Implements ' + decs.map(function (x) { return '<span class="gdec">◆ ' + esc(x) + '</span>'; }).join(" ") + '</div>' : '') +
        depHtml +
        (f ? f.entries.map(entryHtml).join("") : '<p class="empty">No entries.</p>');
    }
    function updateCrumb() {
      var el = document.getElementById("gcrumb"); if (!el) return;
      el.innerHTML = trail.map(function (t, i) {
        var nd = byId[t.id]; var lbl = nd ? (nd.kind === "root" ? nd.label : labelText(nd)) : t.id;
        return '<span class="crumb' + (i === trail.length - 1 ? " cur" : "") + '" data-i="' + i + '">' + esc(lbl) + '</span>';
      }).join('<span class="crumbsep">›</span>');
      el.querySelectorAll(".crumb").forEach(function (c) {
        c.addEventListener("click", function () { var i = +c.getAttribute("data-i"); trail = trail.slice(0, i + 1); focus = trail[i].id; parent = trail[i].parent; page = 0; selected = focus; buildView(); updateCrumb(); updateInfo(); });
      });
    }
    function go(id) {
      if (id === focus) { if (trail.length > 1) { trail.pop(); focus = trail[trail.length - 1].id; parent = trail[trail.length - 1].parent; page = 0; selected = focus; buildView(); updateCrumb(); updateInfo(); } return; }
      trail.push({ id: id, parent: focus }); parent = focus; focus = id; page = 0; selected = id; buildView(); updateCrumb(); updateInfo();
    }
    function hitAt(ev) {
      var rct = canvas.getBoundingClientRect(), mx = ev.clientX - rct.left, my = ev.clientY - rct.top, best = null, bd = 1e9;
      view.forEach(function (it) { var p = pos[it.id], x = cx + p.x, y = cy + p.y, r = nodeR(it) + 5, dx = mx - x, dy = my - y, d = dx * dx + dy * dy; if (d < r * r && d < bd) { bd = d; best = it; } });
      return best;
    }
    canvas.addEventListener("click", function (ev) { var it = hitAt(ev); if (!it) return; if (it.isMore) { page += 1; buildView(); return; } selected = it.id; go(it.id); });
    canvas.addEventListener("mousemove", function (ev) { var it = hitAt(ev); var id = it ? it.id : null; if (id !== hoverId) { hoverId = id; canvas.style.cursor = id ? "pointer" : "default"; } });
    canvas.addEventListener("wheel", function (ev) { ev.preventDefault(); zoom *= ev.deltaY < 0 ? 1.1 : 0.9; zoom = Math.max(0.6, Math.min(2.4, zoom)); buildView(); }, { passive: false });
    window.addEventListener("resize", function () { if (stale()) return; resize(); buildView(); });

    // Deep-link a starting focus (?gfocus=<file path or decision:ID>) so a
    // specific wedge of the map is shareable — same spirit as ?tab/?q/?sev.
    var gf = new URLSearchParams(location.search).get("gfocus");
    if (gf && byId[gf]) { trail = [{ id: ROOT, parent: null }, { id: gf, parent: ROOT }]; focus = gf; parent = ROOT; selected = gf; }

    resize(); buildView(); updateCrumb(); updateInfo(); frame();
  }
  function render() {
    if (graphRaf) { cancelAnimationFrame(graphRaf); graphRaf = null; }
    var main = document.getElementById("main");
    if (tab === "understand") { main.innerHTML = renderUnderstand(); if (!UNDERSTAND && !uLoading) loadUnderstand(); return; }
    main.innerHTML = tab === "files" ? renderFiles() : tab === "graph" ? renderGraph()
      : tab === "decisions" ? renderDecisions()
      : tab === "timeline" ? renderTimeline() : tab === "help" ? renderHelp() : renderHealth();
    if (tab === "graph") { initGraph(); return; }
    main.querySelectorAll(".file .head").forEach(function (h) {
      h.addEventListener("click", function (ev) {
        if (ev.target.classList.contains("copy")) return;
        h.parentNode.classList.toggle("open");
      });
    });
    main.querySelectorAll("[data-copy]").forEach(function (b) {
      b.addEventListener("click", function () {
        var f = DATA.files[+b.getAttribute("data-copy")];
        var snip = shareSnippet(f.path, f.entries);
        if (navigator.clipboard) navigator.clipboard.writeText(snip).then(function () { b.textContent = "✓ Copied"; setTimeout(function () { b.textContent = "Copy why for PR"; }, 1400); });
      });
    });
  }
  function init() {
    document.getElementById("proj").textContent = DATA.project;
    document.getElementById("purpose").textContent = DATA.purpose || "";
    document.getElementById("stack").textContent = DATA.stack.join(" · ");
    // Deep-linkable views: ?tab=files|timeline|health & ?q=... & ?sev=...
    var p = new URLSearchParams(location.search);
    if (p.get("tab")) tab = p.get("tab");
    if (p.get("sev")) sev = p.get("sev");
    if (p.get("q")) { term = (p.get("q") || "").toLowerCase(); }
    document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-tab") === tab); });
    document.querySelectorAll(".chip").forEach(function (c) { c.classList.toggle("active", c.getAttribute("data-sev") === sev); });
    document.getElementById("q").value = p.get("q") || "";
    var bs = Object.keys(DATA.stats.bySource).map(function (k) { return k + ": " + DATA.stats.bySource[k]; }).join("  ·  ");
    document.getElementById("stats").textContent = DATA.stats.entries + " changes · " + DATA.stats.files + " files · " + bs;
    document.querySelectorAll(".tab").forEach(function (t) { t.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); }); t.classList.add("active"); tab = t.getAttribute("data-tab"); render();
    }); });
    document.querySelectorAll(".chip").forEach(function (c) { c.addEventListener("click", function () {
      document.querySelectorAll(".chip").forEach(function (x) { x.classList.remove("active"); }); c.classList.add("active"); sev = c.getAttribute("data-sev"); render();
    }); });
    document.getElementById("q").addEventListener("input", function (e) { term = e.target.value.toLowerCase(); render(); });
    render();
  }
  fetch("/api/data").then(function (r) { return r.json(); }).then(function (d) { DATA = d; init(); })
    .catch(function () { document.getElementById("main").innerHTML = '<p class="empty">Failed to load. Is the kodela ui server still running?</p>'; });
})();
</script>
</body>
</html>
`;
}

/** Serve the UI read-only. GET / → app, GET /api/data → payload. Binds 127.0.0.1 by default. */
export function serveUi(
  repoRoot: string,
  port: number = DEFAULT_UI_PORT,
  host: string = "127.0.0.1",
): http.Server {
  const html = buildUiHtml();
  let cache: { json: string; at: number } | null = null;
  // The Understand payload is heavier (tree-sitter parsing), so it gets its own
  // longer-lived cache and is only computed when the Understand tab is opened.
  let understandCache: { json: string; at: number } | null = null;
  const server = http.createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("Method Not Allowed — kodela ui is read-only.");
      return;
    }
    if ((req.url ?? "/").startsWith("/api/understand")) {
      void (async () => {
        try {
          if (!understandCache || Date.now() - understandCache.at > 30_000) {
            understandCache = { json: JSON.stringify(await loadUnderstandData(repoRoot)), at: Date.now() };
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(understandCache.json);
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      })();
      return;
    }
    if ((req.url ?? "/").startsWith("/api/data")) {
      void (async () => {
        try {
          if (!cache || Date.now() - cache.at > 1000) {
            cache = { json: JSON.stringify(await loadUiData(repoRoot)), at: Date.now() };
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(cache.json);
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      })();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  server.listen(port, host);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `\n✗ Port ${port} is already in use (another kodela ui instance running?).\n` +
        `  → Kill it with: kill $(lsof -ti:${port}) 2>/dev/null\n` +
        `  → Or use a different port: kodela ui --port ${port + 1}\n\n`,
      );
      process.exit(1);
    }
    throw err;
  });
  return server;
}

/** Best-effort open of the default browser; never throws. */
export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* headless / no browser — non-fatal */
  }
}

export async function runUi(opts: UiOptions): Promise<{ port: number; url: string; server: http.Server }> {
  const port = opts.port ?? DEFAULT_UI_PORT;
  const host = opts.host ?? "127.0.0.1";
  const server = serveUi(opts.repoRoot, port, host);
  // When bound to a non-loopback host (e.g. 0.0.0.0 for a hosted demo) there is
  // no local browser to open; only auto-open for the default local bind.
  const isLocal = host === "127.0.0.1" || host === "localhost";
  const url = `http://${isLocal ? "localhost" : host}:${port}`;
  if (opts.open !== false && isLocal) openBrowser(url);
  return { port, url, server };
}
