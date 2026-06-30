// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { loadUiData, buildUiHtml, serveUi, runUi, DEFAULT_UI_PORT } from "./ui.js";
import { runInit } from "./init.js";
import { runAdd } from "./add.js";

describe("buildUiHtml", () => {
  test("is a self-contained page that fetches the data endpoint", () => {
    const html = buildUiHtml();
    assert.match(html, /<!doctype html>/);
    assert.match(html, /fetch\("\/api\/data"\)/);
    assert.match(html, /Memory health/);
    assert.match(html, /Copy why for PR/);
    // the Graph tab + canvas renderer are present
    assert.match(html, /data-tab="graph"/);
    assert.match(html, /id="gcanvas"/);
    // the read-only Decisions tab is present
    assert.match(html, /data-tab="decisions"/);
    assert.match(html, /renderDecisions/);
    // the self-explanatory Help tab is present
    assert.match(html, /data-tab="help"/);
    assert.match(html, /renderHelp/);
    assert.match(html, /What is this\?/);
    // light theme (aligned with the commercial dashboard)
    assert.match(html, /color-scheme: light/);
    // no data is inlined — it loads dynamically
    assert.doesNotMatch(html, /__DATA__/);
  });
});

describe("loadUiData + serveUi", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ui-test-"));
    await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "demo-ui" }));
    await fs.mkdir(path.join(tmp, ".kodela", "dna"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".kodela", "dna", "project.json"),
      JSON.stringify({ project: "demo-ui", purpose: "See the why.", stack: ["TypeScript"] }),
    );
    await fs.writeFile(path.join(tmp, "auth.ts"), "export const x = 1;\n");
    await runInit(tmp);
    await runAdd({ repoRoot: tmp, filePath: "auth.ts", lineStart: 1, lineEnd: 1, note: "token rotation lives here", severity: "high", source: "human" });
    // a decision JSON copy, exactly as the MCP server persists it
    await fs.mkdir(path.join(tmp, ".kodela", "decisions"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".kodela", "decisions", "DEC-0001.json"),
      JSON.stringify({
        schemaVersion: "1.0.0",
        decision: {
          id: "DEC-0001",
          title: "Use SQLite for local storage",
          category: "architecture",
          status: "active",
          problem: "Need local, zero-config persistence.",
          decision: "Adopt node:sqlite.",
          reason: "Bundled with Node 24, no native deps.",
          author_id: "human:dev",
          tags: ["storage"],
          decided_at: "2026-06-29T00:00:00.000Z",
        },
        options: [
          { label: "node:sqlite", description: "Built in.", was_chosen: true },
          { label: "Postgres", description: "Server DB.", was_chosen: false, rejection_reason: "Too heavy for single-dev local use." },
        ],
        links: [],
      }),
    );
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("loadUiData groups entries by file with stats and metrics", async () => {
    const data = await loadUiData(tmp);
    assert.equal(data.project, "demo-ui");
    assert.equal(data.purpose, "See the why.");
    assert.equal(data.stats.entries, 1);
    assert.equal(data.files.length, 1);
    assert.equal(data.files[0]?.path, "auth.ts");
    assert.match(data.files[0]?.entries[0]?.note ?? "", /token rotation/);
    assert.ok(data.metrics && data.metrics.memorySize === 1);
    // graph payload: a node per file, edges array present
    assert.ok(Array.isArray(data.graph.nodes) && data.graph.nodes.length === 1);
    assert.equal(data.graph.nodes[0]?.id, "auth.ts");
    assert.ok(Array.isArray(data.graph.edges));
  });

  test("loadUiData reads human-authored decisions from .kodela/decisions", async () => {
    const data = await loadUiData(tmp);
    assert.equal(data.decisions.length, 1);
    const d = data.decisions[0]!;
    assert.equal(d.id, "DEC-0001");
    assert.equal(d.title, "Use SQLite for local storage");
    assert.equal(d.category, "architecture");
    assert.equal(d.status, "active");
    assert.equal(d.date, "2026-06-29");
    assert.equal(d.options.length, 2);
    assert.equal(d.options.find((o) => o.chosen)?.label, "node:sqlite");
    assert.match(d.options.find((o) => !o.chosen)?.rejectionReason ?? "", /Too heavy/);
  });

  test("serveUi serves the app, the JSON payload, and is read-only", async () => {
    const port = DEFAULT_UI_PORT + 211;
    const server = serveUi(tmp, port);
    try {
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const req = (method: string, path = "/") =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const r = http.request({ host: "127.0.0.1", port, method, path }, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          });
          r.on("error", reject);
          r.end();
        });
      const app = await req("GET", "/");
      assert.equal(app.status, 200);
      assert.match(app.body, /<!doctype html>/);
      const data = await req("GET", "/api/data");
      assert.equal(data.status, 200);
      const parsed = JSON.parse(data.body);
      assert.equal(parsed.project, "demo-ui");
      assert.match(data.body, /token rotation/);
      const post = await req("POST", "/api/data");
      assert.equal(post.status, 405);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("runUi honors --host (0.0.0.0 for the hosted demo) and does not auto-open", async () => {
    const { url, server } = await runUi({ repoRoot: tmp, port: DEFAULT_UI_PORT + 212, host: "0.0.0.0", open: false });
    try {
      assert.match(url, /^http:\/\/0\.0\.0\.0:/);
      const body = await new Promise<string>((resolve, reject) => {
        const r = http.request({ host: "127.0.0.1", port: DEFAULT_UI_PORT + 212, method: "GET", path: "/api/data" }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve(b));
        });
        r.on("error", reject);
        r.end();
      });
      assert.equal(JSON.parse(body).project, "demo-ui");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("loadUiData fuses file→decision links from the local graph store", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ui-fuse-"));
    await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "fuse-ui" }));
    await fs.writeFile(path.join(tmp, "billing.ts"), "export const total = 0;\n");
    await runInit(tmp);
    await runAdd({ repoRoot: tmp, filePath: "billing.ts", lineStart: 1, lineEnd: 1, note: "rounds the subtotal before tax", severity: "medium", source: "ai" });

    // The decision the file implements (as the MCP server persists it on disk).
    await fs.mkdir(path.join(tmp, ".kodela", "decisions"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".kodela", "decisions", "DEC-9001.json"),
      JSON.stringify({
        schemaVersion: "1.0.0",
        decision: { id: "DEC-9001", title: "Tax on the rounded subtotal", category: "business", status: "active", problem: "p", decision: "d", reason: "r", author_id: "human:dev", tags: [], decided_at: "2026-06-29T00:00:00.000Z" },
        options: [],
        links: [],
      }),
    );

    // Seed the local graph store with the IMPLEMENTS edge (file_change → decision),
    // joined back to the entry's file_path — exactly the shape readFusedLinks reads.
    const entryId = JSON.parse(await fs.readFile(path.join(tmp, ".kodela", "index.json"), "utf8")).entries[0] as string;
    const db = new DatabaseSync(path.join(tmp, ".kodela", "index.db"));
    db.exec(
      "CREATE TABLE entries (id TEXT PRIMARY KEY, file_path TEXT NOT NULL);" +
        "CREATE TABLE graph_edges (id TEXT PRIMARY KEY, edge_type TEXT, source_node_type TEXT, source_node_id TEXT, target_node_type TEXT, target_node_id TEXT, valid_until TEXT);",
    );
    db.prepare("INSERT INTO entries (id, file_path) VALUES (?, ?)").run(entryId, "billing.ts");
    db.prepare("INSERT INTO graph_edges (id, edge_type, source_node_type, source_node_id, target_node_type, target_node_id, valid_until) VALUES (?,?,?,?,?,?,NULL)")
      .run("ge-1", "IMPLEMENTS", "FILE_CHANGE", entryId, "DECISION", "DEC-9001");
    db.close();
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("graph carries a decision node and a file→decision implements edge", async () => {
    const data = await loadUiData(tmp);
    const fileNode = data.graph.nodes.find((n) => n.id === "billing.ts");
    assert.ok(fileNode, "file node present");
    assert.equal(fileNode?.kind, "file");

    const decNode = data.graph.nodes.find((n) => n.id === "decision:DEC-9001");
    assert.ok(decNode, "decision node present");
    assert.equal(decNode?.kind, "decision");
    assert.equal(decNode?.label, "Tax on the rounded subtotal");

    const implEdge = data.graph.edges.find((e) => e.kind === "implements" && e.a === "billing.ts" && e.b === "decision:DEC-9001");
    assert.ok(implEdge, "implements edge present");
  });

  test("graph degrades to co-change only when there is no graph store", async () => {
    await fs.rm(path.join(tmp, ".kodela", "index.db"), { force: true });
    const data = await loadUiData(tmp);
    assert.ok(data.graph.nodes.every((n) => n.kind !== "decision"), "no decision nodes without the store");
    assert.ok(data.graph.edges.every((e) => e.kind !== "implements"), "no implements edges without the store");
  });
});
