// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * kodela view — a minimal, local, read-only viewer for the captured memory.
 *
 * Generates a single self-contained HTML file (no build step, no dependencies,
 * no network) that shows a solo developer the project DNA, the capture stats,
 * and a timeline of the *why* behind every change — grouped by file, filterable
 * in the browser. This is the free, local-first counterpart to the commercial
 * dashboard: it visualises the graph/timeline without any server or account.
 *
 *   kodela view              → write .kodela/view.html
 *   kodela view --serve      → write + serve on http://localhost:7421 (read-only)
 *   kodela view --out v.html → custom output path
 */
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { readAllEntries } from "./status.js";

export type ViewOptions = {
  repoRoot: string;
  out?: string;
  serve?: boolean;
  port?: number;
};

export type ViewResult = {
  html: string;
  outPath?: string;
  entryCount: number;
  fileCount: number;
  bytes: number;
};

interface Dna {
  project?: string;
  purpose?: string;
  stack?: string[];
}

interface ContextLike {
  filePath: string;
  note: string;
  updatedAt: string;
  source?: string;
  severity?: string;
}

export const DEFAULT_VIEW_PORT = 7421;

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Minimal HTML-escape for text interpolated into the page. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Build the self-contained viewer HTML. Pure function of its inputs so it is
 * deterministic and unit-testable.
 */
export function buildViewHtml(data: {
  name: string;
  dna: Dna | null;
  entries: ContextLike[];
  /** When set (serve mode), inject a browser auto-refresh so the page stays live. */
  autoRefreshSeconds?: number;
}): string {
  const { name, dna, entries } = data;
  const refreshMeta =
    data.autoRefreshSeconds && data.autoRefreshSeconds > 0
      ? `<meta http-equiv="refresh" content="${Math.floor(data.autoRefreshSeconds)}">`
      : "";

  const byFile = new Map<string, ContextLike[]>();
  for (const e of entries) {
    const arr = byFile.get(e.filePath) ?? [];
    arr.push(e);
    byFile.set(e.filePath, arr);
  }
  const files = [...byFile.keys()].sort();

  const sourceCounts = new Map<string, number>();
  for (const e of entries) {
    const s = e.source ?? "unknown";
    sourceCounts.set(s, (sourceCounts.get(s) ?? 0) + 1);
  }

  const stat = (label: string, value: string) =>
    `<div class="stat"><div class="stat-v">${esc(value)}</div><div class="stat-l">${esc(label)}</div></div>`;

  const stats = [
    stat("captured changes", String(entries.length)),
    stat("files", String(files.length)),
    ...[...sourceCounts.entries()].map(([s, n]) => stat(`by ${s}`, String(n))),
  ].join("");

  const fileSections = files
    .map((file) => {
      const recs = byFile
        .get(file)!
        .slice()
        .sort((a, b) => {
          const sa = SEVERITY_ORDER[a.severity ?? "low"] ?? 3;
          const sb = SEVERITY_ORDER[b.severity ?? "low"] ?? 3;
          if (sa !== sb) return sa - sb;
          return b.updatedAt > a.updatedAt ? 1 : -1;
        });
      const items = recs
        .map((r) => {
          const sev = r.severity ?? "low";
          const src = r.source ?? "unknown";
          const when = (r.updatedAt ?? "").slice(0, 10);
          return `<li class="entry sev-${esc(sev)}" data-sev="${esc(sev)}" data-src="${esc(src)}">
        <div class="entry-head"><span class="badge sev">${esc(sev)}</span><span class="badge src">${esc(src)}</span><span class="when">${esc(when)}</span></div>
        <div class="note">${esc(r.note.replace(/\s+/g, " ").trim())}</div>
      </li>`;
        })
        .join("");
      return `<section class="file" data-file="${esc(file)}">
      <h3><code>${esc(file)}</code> <span class="count">${recs.length}</span></h3>
      <ul>${items}</ul>
    </section>`;
    })
    .join("");

  const empty = `<p class="empty">No context captured yet. As you work with AI tools, Kodela records the <em>why</em> behind each change and it appears here.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshMeta}
<title>${esc(name)} — Kodela memory</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #0b0d12; color: #e6e8ee; }
  header { padding: 28px 32px 20px; border-bottom: 1px solid #1d2230; background: #0e1119; }
  h1 { margin: 0 0 6px; font-size: 22px; }
  .purpose { color: #98a1b3; max-width: 70ch; margin: 6px 0 0; }
  .stack { margin-top: 10px; color: #7d8694; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .03em; }
  .stats { display: flex; flex-wrap: wrap; gap: 14px; padding: 18px 32px; border-bottom: 1px solid #1d2230; }
  .stat { background: #141826; border: 1px solid #232a3b; border-radius: 12px; padding: 12px 16px; min-width: 120px; }
  .stat-v { font-size: 22px; font-weight: 700; }
  .stat-l { color: #8b94a7; font-size: 12px; }
  .toolbar { padding: 14px 32px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
    border-bottom: 1px solid #1d2230; position: sticky; top: 0; background: #0b0d12; z-index: 2; }
  .toolbar input { background: #141826; border: 1px solid #2a3245; color: #e6e8ee; border-radius: 8px;
    padding: 7px 11px; min-width: 240px; }
  .filter { background: #141826; border: 1px solid #2a3245; color: #b9c0cf; border-radius: 8px;
    padding: 6px 11px; cursor: pointer; font: inherit; font-size: 13px; }
  .filter.active { background: #2a3a66; border-color: #3a52a0; color: #fff; }
  main { padding: 8px 32px 64px; }
  .file { margin: 22px 0; }
  .file h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; color: #cdd3df; }
  .file h3 code { color: #8fb4ff; }
  .count { font-size: 12px; color: #6b7488; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .entry { background: #11151f; border: 1px solid #1f2636; border-left-width: 3px; border-radius: 10px; padding: 10px 14px; }
  .entry-head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
  .when { color: #6b7488; font-size: 12px; margin-left: auto; }
  .badge.src { background: #1b2235; color: #9fb0d0; }
  .sev-critical { border-left-color: #ff5c7a; } .sev-critical .badge.sev { background: #3a1420; color: #ff8fa3; }
  .sev-high { border-left-color: #ff9f43; } .sev-high .badge.sev { background: #38260f; color: #ffc078; }
  .sev-medium { border-left-color: #ffd43b; } .sev-medium .badge.sev { background: #332d10; color: #ffe066; }
  .sev-low { border-left-color: #51cf66; } .sev-low .badge.sev { background: #122a18; color: #8ce99a; }
  .note { color: #d6dae3; }
  .empty { color: #8b94a7; padding: 32px 0; }
  footer { padding: 20px 32px; color: #6b7488; border-top: 1px solid #1d2230; font-size: 13px; }
  a { color: #8fb4ff; }
</style>
</head>
<body>
<header>
  <h1>${esc(name)} <span class="badge" style="background:#15311f;color:#8ce99a;vertical-align:middle">read-only</span></h1>
  ${dna?.purpose ? `<p class="purpose">${esc(dna.purpose)}</p>` : ""}
  ${dna?.stack?.length ? `<p class="stack">${esc(dna.stack.join(" · "))}</p>` : ""}
</header>
<div class="stats">${stats}</div>
<div class="toolbar">
  <input id="q" type="search" placeholder="Filter by file or text…" aria-label="Filter">
  <button class="filter active" data-sev="all">All</button>
  <button class="filter" data-sev="critical">Critical</button>
  <button class="filter" data-sev="high">High</button>
  <button class="filter" data-sev="medium">Medium</button>
  <button class="filter" data-sev="low">Low</button>
</div>
<main>${files.length ? fileSections : empty}</main>
<footer>Generated by <a href="https://github.com/tkarlmarx/kodela-oss">kodela view</a> — local, read-only, offline. Refresh with <code>kodela view</code>.</footer>
<script>
  (function () {
    var q = document.getElementById('q');
    var sev = 'all';
    var buttons = document.querySelectorAll('.filter');
    function apply() {
      var term = (q.value || '').toLowerCase();
      document.querySelectorAll('.file').forEach(function (sec) {
        var file = (sec.getAttribute('data-file') || '').toLowerCase();
        var anyVisible = false;
        sec.querySelectorAll('.entry').forEach(function (li) {
          var matchSev = sev === 'all' || li.getAttribute('data-sev') === sev;
          var text = (file + ' ' + li.textContent).toLowerCase();
          var matchTerm = !term || text.indexOf(term) !== -1;
          var show = matchSev && matchTerm;
          li.style.display = show ? '' : 'none';
          if (show) anyVisible = true;
        });
        sec.style.display = anyVisible ? '' : 'none';
      });
    }
    q.addEventListener('input', apply);
    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        buttons.forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        sev = b.getAttribute('data-sev');
        apply();
      });
    });
  })();
</script>
</body>
</html>
`;
}

/** Read DNA + entries and render the viewer HTML, without touching disk. */
async function loadViewHtml(
  repoRoot: string,
  autoRefreshSeconds?: number,
): Promise<{ html: string; entryCount: number; fileCount: number }> {
  const dna = await readJson<Dna>(path.join(repoRoot, ".kodela", "dna", "project.json"));
  const pkg = await readJson<{ name?: string }>(path.join(repoRoot, "package.json"));
  const entries = (await readAllEntries(repoRoot).catch(() => [])) as unknown as ContextLike[];

  const name = dna?.project ?? pkg?.name ?? path.basename(repoRoot);
  const uniqueFiles = new Set(entries.map((e) => e.filePath));
  const html = buildViewHtml({ name, dna, entries, autoRefreshSeconds });
  return { html, entryCount: entries.length, fileCount: uniqueFiles.size };
}

export async function runView(opts: ViewOptions): Promise<ViewResult> {
  const { repoRoot } = opts;
  const { html, entryCount, fileCount } = await loadViewHtml(repoRoot);

  const result: ViewResult = {
    html,
    entryCount,
    fileCount,
    bytes: Buffer.byteLength(html, "utf8"),
  };

  const outPath = path.resolve(repoRoot, opts.out ?? path.join(".kodela", "view.html"));
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, html, "utf8");
  result.outPath = path.relative(repoRoot, outPath) || opts.out;

  return result;
}

/**
 * Serve the viewer read-only on localhost, LIVE: each request re-renders from the
 * current captured data (cached ~1s to absorb bursts), and the page carries a
 * browser auto-refresh so it stays current as the watcher captures new context.
 * Only GET is allowed. Returns the listening server so the caller keeps the
 * process alive (and can close it on shutdown).
 */
export function serveView(
  repoRoot: string,
  port: number = DEFAULT_VIEW_PORT,
  refreshSeconds = 5,
): http.Server {
  let cache: { html: string; at: number } | null = null;
  const server = http.createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("Method Not Allowed — kodela view is read-only.");
      return;
    }
    void (async () => {
      try {
        const fresh = !cache || Date.now() - cache.at > 1000;
        if (fresh) {
          const { html } = await loadViewHtml(repoRoot, refreshSeconds);
          cache = { html, at: Date.now() };
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(cache!.html);
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`kodela view error: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });
  server.listen(port, "127.0.0.1");
  return server;
}

export function formatViewResult(result: ViewResult, output: "text" | "json" = "text"): string {
  if (output === "json") {
    const { html, ...meta } = result;
    return JSON.stringify(meta, null, 2);
  }
  const kb = (result.bytes / 1024).toFixed(1);
  return [
    `✚ Wrote ${result.outPath}`,
    `  ${result.entryCount} captured change${result.entryCount === 1 ? "" : "s"} across ${result.fileCount} file${result.fileCount === 1 ? "" : "s"} · ${kb} KB`,
    "",
    "Open it in your browser, or run `kodela view --serve` for a local read-only server.",
  ].join("\n");
}
