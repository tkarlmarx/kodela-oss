// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { runView, buildViewHtml, formatViewResult, serveView, DEFAULT_VIEW_PORT } from "./view.js";
import { runInit } from "./init.js";
import { runAdd } from "./add.js";

describe("buildViewHtml", () => {
  test("renders DNA, stats, and an entry as a self-contained page", () => {
    const html = buildViewHtml({
      name: "demo-view",
      dna: { project: "demo-view", purpose: "Show the why.", stack: ["TypeScript"] },
      entries: [
        {
          filePath: "auth.ts",
          note: "token rotation lives here",
          updatedAt: "2026-06-29T00:00:00.000Z",
          source: "human",
          severity: "high",
        },
      ],
    });
    assert.match(html, /<!doctype html>/);
    assert.match(html, /demo-view/);
    assert.match(html, /Show the why\./);
    assert.match(html, /token rotation lives here/);
    assert.match(html, /sev-high/);
    assert.match(html, /read-only/);
  });

  test("escapes HTML in notes and shows the empty state when cold", () => {
    const html = buildViewHtml({
      name: "cold",
      dna: null,
      entries: [],
    });
    assert.match(html, /No context captured yet/);

    const escaped = buildViewHtml({
      name: "x",
      dna: null,
      entries: [
        { filePath: "a.ts", note: "<script>alert(1)</script>", updatedAt: "2026-06-29", source: "ai", severity: "low" },
      ],
    });
    assert.doesNotMatch(escaped, /<script>alert\(1\)<\/script>/);
    assert.match(escaped, /&lt;script&gt;/);
  });
});

describe("runView", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-view-test-"));
    await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "demo-view" }));
    await fs.mkdir(path.join(tmp, ".kodela", "dna"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".kodela", "dna", "project.json"),
      JSON.stringify({ project: "demo-view", purpose: "View the why.", stack: ["TypeScript"] }),
    );
    await fs.writeFile(path.join(tmp, "auth.ts"), "export const x = 1;\n");
    await runInit(tmp);
    await runAdd({
      repoRoot: tmp,
      filePath: "auth.ts",
      lineStart: 1,
      lineEnd: 1,
      note: "Why this exists: token rotation",
      severity: "high",
      source: "human",
    });
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("writes a viewer HTML file and reports counts", async () => {
    const result = await runView({ repoRoot: tmp });
    assert.equal(result.outPath, path.join(".kodela", "view.html"));
    assert.equal(result.entryCount, 1);
    assert.equal(result.fileCount, 1);
    const written = await fs.readFile(path.join(tmp, ".kodela", "view.html"), "utf8");
    assert.match(written, /token rotation/);
    assert.ok(result.bytes > 0);
  });

  test("custom --out path is honoured", async () => {
    const result = await runView({ repoRoot: tmp, out: "memory.html" });
    assert.equal(result.outPath, "memory.html");
    await assert.doesNotReject(fs.access(path.join(tmp, "memory.html")));
  });

  test("formatViewResult renders text and json", async () => {
    const result = await runView({ repoRoot: tmp });
    assert.match(formatViewResult(result, "text"), /Wrote/);
    assert.doesNotThrow(() => JSON.parse(formatViewResult(result, "json")));
  });

  test("serveView serves live HTML (auto-refresh) and is read-only", async () => {
    const port = DEFAULT_VIEW_PORT + 137;
    const server = serveView(tmp, port, 5);
    try {
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const get = (method: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = http.request({ host: "127.0.0.1", port, method, path: "/" }, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          });
          req.on("error", reject);
          req.end();
        });
      const ok = await get("GET");
      assert.equal(ok.status, 200);
      assert.match(ok.body, /token rotation/);
      assert.match(ok.body, /http-equiv="refresh" content="5"/);
      const post = await get("POST");
      assert.equal(post.status, 405);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
