// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Comprehension graph (Phase 2 — P2.1). Confirms the builder emits file /
 * class / function / method nodes with containment edges, produces offline
 * heuristic descriptions, prefers a captured note over the heuristic, fuses
 * whys + decisions onto the overlapping node, and computes coverage.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildComprehension,
  humanizeIdentifier,
  heuristicFunctionDescription,
  type ComprehensionFileInput,
} from "./index.js";
import type { CodeGraphFunction } from "../code-graph/types.js";
import type { ContextEntry } from "../schema/index.js";

function fn(over: Partial<CodeGraphFunction>): CodeGraphFunction {
  return {
    name: "doThing",
    kind: "function",
    startLine: 1,
    endLine: 10,
    language: "typescript",
    ast_anchor: "function:doThing",
    ...over,
  };
}

function entry(over: Partial<ContextEntry>): ContextEntry {
  return {
    schemaVersion: "1.1.0",
    id: "00000000-0000-0000-0000-000000000000",
    filePath: "src/auth.ts",
    astAnchor: null,
    contentHash: "hash",
    lineRange: { start: 1, end: 5 },
    note: "note",
    author: "ai",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    severity: "low",
    tags: [],
    source: "ai",
    confidence: 0.9,
    status: "mapped",
    reviewRequired: false,
    ...over,
  };
}

describe("humanizeIdentifier", () => {
  test("splits camel / snake / Pascal case", () => {
    assert.equal(humanizeIdentifier("getUserToken"), "get user token");
    assert.equal(humanizeIdentifier("parse_http_header"), "parse http header");
    assert.equal(humanizeIdentifier("HTTPClient"), "http client");
  });
});

describe("heuristicFunctionDescription", () => {
  test("uses a verb hint for known leading verbs", () => {
    assert.match(heuristicFunctionDescription(fn({ name: "getToken" })), /^Reads token/);
    assert.match(heuristicFunctionDescription(fn({ name: "validateInput" })), /^Validates input/);
  });
  test("describes a class by name", () => {
    assert.match(
      heuristicFunctionDescription(fn({ name: "SessionManager", kind: "class" })),
      /`SessionManager` class/,
    );
  });
  test("does not crash on prototype-chain names like constructor/toString", () => {
    // VERB_HINTS[name] must not resolve to inherited Object.prototype members.
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      assert.doesNotThrow(() => heuristicFunctionDescription(fn({ name, kind: "method", parent: "C" })));
    }
    assert.match(heuristicFunctionDescription(fn({ name: "constructor", kind: "method", parent: "Session" })), /constructor/);
  });
});

describe("buildComprehension", () => {
  const files: ComprehensionFileInput[] = [
    {
      filePath: "src/auth.ts",
      functions: [
        fn({ name: "Session", kind: "class", startLine: 1, endLine: 40 }),
        fn({ name: "rotate", kind: "method", parent: "Session", startLine: 3, endLine: 8 }),
        fn({ name: "getToken", kind: "function", startLine: 50, endLine: 60 }),
      ],
    },
  ];

  test("emits file + class + method + function nodes with containment edges", () => {
    const g = buildComprehension(files);
    const kinds = g.nodes.map((n) => n.kind).sort();
    assert.deepEqual(kinds, ["class", "file", "function", "method"]);
    assert.equal(g.stats.files, 1);
    assert.equal(g.stats.classes, 1);
    assert.equal(g.stats.functions, 2); // method + function both counted as functions
    // The method edge points from the class node, not the file.
    const methodNode = g.nodes.find((n) => n.kind === "method")!;
    assert.equal(methodNode.parentId, "src/auth.ts#class:Session");
    assert.ok(g.edges.some((e) => e.to === methodNode.id && e.kind === "method-of"));
  });

  test("fuses a captured note as the description and records the why", () => {
    const g = buildComprehension(files, {
      entries: [
        entry({
          id: "why-1",
          filePath: "src/auth.ts",
          lineRange: { start: 3, end: 6 },
          note: "Rotation invalidates the previous token id so a captured old token cannot be replayed.",
          severity: "high",
          tags: ["auth", "security"],
        }),
      ],
    });
    const rotate = g.nodes.find((n) => n.name === "rotate")!;
    assert.equal(rotate.descriptionSource, "note");
    assert.match(rotate.description, /invalidates the previous token/);
    assert.equal(rotate.whys.length, 1);
    assert.equal(rotate.riskLevel, "high");
    // The distant getToken function must NOT pick up that why.
    const getToken = g.nodes.find((n) => n.name === "getToken")!;
    assert.equal(getToken.whys.length, 0);
    assert.equal(getToken.descriptionSource, "heuristic");
  });

  test("fuses decisions via the entry→decision map and computes coverage", () => {
    const g = buildComprehension(files, {
      entries: [entry({ id: "e1", filePath: "src/auth.ts", lineRange: { start: 3, end: 6 } })],
      decisionsByEntryId: new Map([
        ["e1", [{ decisionId: "d1", title: "Use ed25519", status: "accepted" }]],
      ]),
    });
    const rotate = g.nodes.find((n) => n.name === "rotate")!;
    assert.equal(rotate.decisions.length, 1);
    assert.equal(rotate.decisions[0]!.title, "Use ed25519");
    assert.ok(g.stats.coverage > 0 && g.stats.coverage <= 1);
    assert.ok(g.stats.documented >= 2, "file + rotate node are documented");
  });

  test("archived entries are ignored in fusion", () => {
    const archived = {
      ...entry({ id: "arch", filePath: "src/auth.ts", lineRange: { start: 3, end: 6 } }),
      archived: true,
    } as ContextEntry;
    const g = buildComprehension(files, { entries: [archived] });
    assert.equal(g.stats.documented, 0);
  });
});
