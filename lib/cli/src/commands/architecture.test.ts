// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 3 — `kodela architecture` end-to-end. Seeds a temp git repo whose paths
 * map to distinct layers, with a cross-layer import and a high-risk entry, and a
 * .kodela/architecture.json refinement, then confirms runArchitecture classifies
 * layers, fuses risk, builds the cross-layer matrix, and applies refinements.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeContextEntry } from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import { runArchitecture, formatArchitectureResult } from "./architecture.js";

const execFileAsync = promisify(execFile);

describe("kodela architecture (Phase 3)", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-arch-"));
    await fs.mkdir(path.join(tmp, "src", "auth"), { recursive: true });
    await fs.mkdir(path.join(tmp, "src", "routes"), { recursive: true });
    await fs.writeFile(path.join(tmp, "src", "auth", "session.ts"), "export const s = 1;\n");
    // A route imports auth → API → Auth cross-layer edge.
    await fs.writeFile(
      path.join(tmp, "src", "routes", "login.ts"),
      "import { s } from '../auth/session.js';\nexport const login = s;\n",
    );
    await execFileAsync("git", ["init", "-q"], { cwd: tmp });
    await execFileAsync("git", ["add", "-A"], { cwd: tmp });

    const entry: ContextEntry = {
      schemaVersion: "1.1.0",
      id: "22222222-2222-4222-8222-222222222222",
      filePath: "src/auth/session.ts",
      astAnchor: null,
      contentHash: "hash",
      lineRange: { start: 1, end: 1 },
      note: "session store — keys live here",
      author: "ai",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      severity: "critical",
      tags: ["auth"],
      source: "ai",
      confidence: 0.9,
      status: "mapped",
      reviewRequired: false,
    };
    await writeContextEntry(tmp, entry);
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("classifies layers, fuses risk, and builds the cross-layer matrix", async () => {
    const { map } = await runArchitecture({ repoRoot: tmp });
    const auth = map.layers.find((l) => l.layer === "Auth & Security")!;
    assert.ok(auth, "auth layer exists");
    assert.equal(auth.highestRisk, "critical", "the critical entry surfaces on the auth layer");
    // API (routes) → Auth edge from the cross-layer import.
    assert.ok(map.layerEdges.some((e) => e.from === "API" && e.to === "Auth & Security"));
  });

  test(".kodela/architecture.json refinements are applied", async () => {
    await fs.writeFile(
      path.join(tmp, ".kodela", "architecture.json"),
      JSON.stringify({ rules: [{ layer: "Identity", match: ["/auth"] }] }),
    );
    const { map, refined } = await runArchitecture({ repoRoot: tmp });
    assert.equal(refined, true);
    assert.equal(map.assignments["src/auth/session.ts"]!.layer, "Identity");
  });

  test("text and json formatters render", async () => {
    // Remove the refinement so this asserts the base output.
    await fs.rm(path.join(tmp, ".kodela", "architecture.json"), { force: true });
    const result = await runArchitecture({ repoRoot: tmp });
    const text = formatArchitectureResult(result, "text");
    assert.match(text, /Architecture —/);
    assert.match(text, /Layers \(by size\)/);
    const json = JSON.parse(formatArchitectureResult(result, "json"));
    assert.ok(Array.isArray(json.layers));
    assert.ok(Array.isArray(json.layerEdges));
  });
});
