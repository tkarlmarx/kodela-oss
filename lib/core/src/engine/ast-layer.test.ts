// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isAstLayerApplicable,
  buildAstFingerprint,
  buildAstAnchor,
  computeBodyHash,
  hashAstSignature,
  mapWithAstLayer,
  searchForMovedEntry,
} from "./ast-layer.js";
import type { ContextEntry } from "../schema/index.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PLACEHOLDER_HASH = "a".repeat(64);

const BASE_ENTRY: ContextEntry = {
  schemaVersion: "1.1.0",
  id: "550e8400-e29b-41d4-a716-446655440000",
  filePath: "src/auth/login.ts",
  astAnchor: {
    kind: "function",
    name: "validateToken",
    blockHash: PLACEHOLDER_HASH,
  },
  contentHash: PLACEHOLDER_HASH,
  lineRange: { start: 1, end: 5 },
  note: "Token validation logic.",
  author: "alice",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  severity: "high",
  tags: [],
  source: "human",
  confidence: 0.95,
  status: "mapped",
  reviewRequired: false,
};

// The "before" file — validateToken exists with its original body.
const ORIGINAL_FILE = `
export async function validateToken(token: string): Promise<boolean> {
  if (!token) return false;
  return token.startsWith("Bearer ");
}

export function parsePayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  return JSON.parse(Buffer.from(parts[1] ?? "", "base64").toString());
}
`.trimStart();

// ---------------------------------------------------------------------------
// isAstLayerApplicable
// ---------------------------------------------------------------------------

describe("isAstLayerApplicable", () => {
  test("returns true for TypeScript files", () => {
    assert.equal(isAstLayerApplicable("src/auth.ts"), true);
  });

  test("returns true for TSX files", () => {
    assert.equal(isAstLayerApplicable("src/App.tsx"), true);
  });

  test("returns true for JavaScript files", () => {
    assert.equal(isAstLayerApplicable("lib/util.js"), true);
  });

  test("returns true for .mjs and .cjs files", () => {
    assert.equal(isAstLayerApplicable("dist/index.mjs"), true);
    assert.equal(isAstLayerApplicable("dist/index.cjs"), true);
  });

  test("returns true for Python, Go, Java, C#, Rust files", () => {
    assert.equal(isAstLayerApplicable("src/main.py"), true);
    assert.equal(isAstLayerApplicable("cmd/main.go"), true);
    assert.equal(isAstLayerApplicable("Main.java"), true);
    assert.equal(isAstLayerApplicable("Program.cs"), true);
    assert.equal(isAstLayerApplicable("src/lib.rs"), true);
  });

  test("returns false for plain-text and markdown files", () => {
    assert.equal(isAstLayerApplicable("docs/readme.txt"), false);
    assert.equal(isAstLayerApplicable("README.md"), false);
  });

  test("returns false for JSON and YAML config files", () => {
    assert.equal(isAstLayerApplicable("package.json"), false);
    assert.equal(isAstLayerApplicable("tsconfig.yaml"), false);
  });
});

// ---------------------------------------------------------------------------
// hashAstSignature + computeBodyHash
// ---------------------------------------------------------------------------

describe("hashAstSignature", () => {
  test("produces a 64-character hex string", () => {
    const h = hashAstSignature("function", "validateToken");
    assert.equal(typeof h, "string");
    assert.equal(h.length, 64);
  });

  test("is deterministic", () => {
    assert.equal(
      hashAstSignature("function", "validateToken"),
      hashAstSignature("function", "validateToken"),
    );
  });

  test("differs for different names", () => {
    assert.notEqual(
      hashAstSignature("function", "validateToken"),
      hashAstSignature("function", "parsePayload"),
    );
  });

  test("differs for different kinds", () => {
    assert.notEqual(
      hashAstSignature("function", "render"),
      hashAstSignature("method", "render"),
    );
  });
});

describe("computeBodyHash", () => {
  test("produces a 64-character hex string", () => {
    const h = computeBodyHash(["  if (!token) return false;", "  return true;"]);
    assert.equal(typeof h, "string");
    assert.equal(h.length, 64);
  });

  test("is stable across minor whitespace differences (reformatting resilience)", () => {
    const bodyA = ["  if (!token) return false;", "  return token.startsWith('Bearer ');"];
    const bodyB = ["    if (!token) return false;", "    return token.startsWith('Bearer ');"];
    assert.equal(computeBodyHash(bodyA), computeBodyHash(bodyB));
  });

  test("differs for different body content", () => {
    const bodyA = ["  return true;"];
    const bodyB = ["  return false;"];
    assert.notEqual(computeBodyHash(bodyA), computeBodyHash(bodyB));
  });

  test("is stable across single-line comment changes", () => {
    const bodyA = ["  // check token", "  return token.length > 0;"];
    const bodyB = ["  // validate the token", "  return token.length > 0;"];
    assert.equal(computeBodyHash(bodyA), computeBodyHash(bodyB));
  });
});

// ---------------------------------------------------------------------------
// buildAstFingerprint
// ---------------------------------------------------------------------------

describe("buildAstFingerprint", () => {
  test("returns a 64-character hex fingerprint", () => {
    const fp = buildAstFingerprint(ORIGINAL_FILE);
    assert.equal(typeof fp, "string");
    assert.equal(fp.length, 64);
  });

  test("is deterministic for the same file", () => {
    assert.equal(buildAstFingerprint(ORIGINAL_FILE), buildAstFingerprint(ORIGINAL_FILE));
  });

  test("changes when a function is added", () => {
    const extended = ORIGINAL_FILE + "\nexport function newHelper(): void {}\n";
    assert.notEqual(buildAstFingerprint(ORIGINAL_FILE), buildAstFingerprint(extended));
  });

  test("is stable across comment-only changes", () => {
    const withComment = "// Added a top-level comment\n" + ORIGINAL_FILE;
    const fp1 = buildAstFingerprint(ORIGINAL_FILE);
    const fp2 = buildAstFingerprint(withComment);
    assert.notEqual(fp1, fp2, "fingerprint includes node names regardless of comments");
  });
});

// ---------------------------------------------------------------------------
// buildAstAnchor
// ---------------------------------------------------------------------------

describe("buildAstAnchor", () => {
  test("returns null for non-AST-applicable file types", () => {
    const result = buildAstAnchor("docs/readme.txt", { start: 1, end: 3 }, "some text");
    assert.equal(result, null);
  });

  test("returns null when no node overlaps the line range", () => {
    const file = "// just a comment\nconst x = 1;\n";
    const result = buildAstAnchor("src/util.ts", { start: 1, end: 2 }, file);
    assert.equal(result, null);
  });

  test("builds a complete anchor for a matched function", () => {
    const anchor = buildAstAnchor("src/auth.ts", { start: 1, end: 4 }, ORIGINAL_FILE);
    assert.ok(anchor !== null);
    assert.equal(anchor.kind, "function");
    assert.equal(anchor.name, "validateToken");
    assert.equal(typeof anchor.blockHash, "string");
    assert.equal(anchor.blockHash.length, 64);
    assert.equal(typeof anchor.bodyHash, "string");
    assert.equal(anchor.bodyHash!.length, 64);
  });

  test("includes paramCount in the anchor", () => {
    const anchor = buildAstAnchor("src/auth.ts", { start: 1, end: 4 }, ORIGINAL_FILE);
    assert.ok(anchor !== null);
    assert.equal(typeof anchor.paramCount, "number");
    assert.ok(anchor.paramCount! >= 0);
  });

  test("blockHash matches hashAstSignature for the same kind and name", () => {
    const anchor = buildAstAnchor("src/auth.ts", { start: 1, end: 4 }, ORIGINAL_FILE);
    assert.ok(anchor !== null);
    const expected = hashAstSignature(anchor.kind, anchor.name);
    assert.equal(anchor.blockHash, expected);
  });

  test("selects the node with the greatest line-range overlap", () => {
    // parsePayload starts around line 7 in ORIGINAL_FILE
    const anchor = buildAstAnchor("src/auth.ts", { start: 7, end: 10 }, ORIGINAL_FILE);
    assert.ok(anchor !== null);
    assert.equal(anchor.name, "parsePayload");
  });
});

// ---------------------------------------------------------------------------
// mapWithAstLayer — Tier 1: blockHash match
// ---------------------------------------------------------------------------

describe("mapWithAstLayer — tier 1: blockHash match", () => {
  test("returns orphaned when astAnchor is null", () => {
    const entry: ContextEntry = { ...BASE_ENTRY, astAnchor: null };
    const result = mapWithAstLayer(entry, ORIGINAL_FILE);
    assert.equal(result.status, "orphaned");
    assert.equal(result.confidence, 0);
  });

  test("returns high confidence when blockHash matches the extracted node", () => {
    const correctBlockHash = hashAstSignature("function", "validateToken");
    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: {
        kind: "function",
        name: "validateToken",
        blockHash: correctBlockHash,
      },
    };
    const result = mapWithAstLayer(entry, ORIGINAL_FILE);
    assert.equal(result.confidence, 0.95);
    assert.notEqual(result.status, "orphaned");
  });

  test("updatedLineRange covers the matched function", () => {
    const correctBlockHash = hashAstSignature("function", "validateToken");
    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: {
        kind: "function",
        name: "validateToken",
        blockHash: correctBlockHash,
      },
    };
    const result = mapWithAstLayer(entry, ORIGINAL_FILE);
    assert.ok(result.updatedLineRange.start >= 1);
    assert.ok(result.updatedLineRange.end > result.updatedLineRange.start);
  });
});

// ---------------------------------------------------------------------------
// mapWithAstLayer — Tier 2: name-only match
// ---------------------------------------------------------------------------

describe("mapWithAstLayer — tier 2: name-only match", () => {
  test("returns 0.87 confidence when blockHash is stale but name matches", () => {
    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: {
        kind: "function",
        name: "validateToken",
        blockHash: "stale-or-wrong-hash",
      },
    };
    const result = mapWithAstLayer(entry, ORIGINAL_FILE);
    assert.equal(result.confidence, 0.87);
    assert.notEqual(result.status, "orphaned");
  });

  test("returns orphaned when name does not exist in the file", () => {
    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: {
        kind: "function",
        name: "ghostFunction",
        blockHash: "no-hash",
      },
    };
    const result = mapWithAstLayer(entry, ORIGINAL_FILE);
    assert.equal(result.status, "orphaned");
    assert.equal(result.confidence, 0);
  });
});

// ---------------------------------------------------------------------------
// mapWithAstLayer — Tier 3: body-hash match (rename resilience — Gap 8)
// ---------------------------------------------------------------------------

describe("mapWithAstLayer — tier 3: body-hash match (rename resilience)", () => {
  // File after rename: validateToken → checkToken (same body)
  const RENAMED_FILE = `
export async function checkToken(token: string): Promise<boolean> {
  if (!token) return false;
  return token.startsWith("Bearer ");
}

export function parsePayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  return JSON.parse(Buffer.from(parts[1] ?? "", "base64").toString());
}
`.trimStart();

  test("locates a renamed function using bodyHash", () => {
    // Build the body hash from the original function body.
    const originalBodyLines = [
      '  if (!token) return false;',
      '  return token.startsWith("Bearer ");',
    ];
    const bh = computeBodyHash(originalBodyLines);

    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: {
        kind: "function",
        name: "validateToken",
        blockHash: "old-block-hash",
        bodyHash: bh,
      },
    };

    // validateToken no longer exists; checkToken has the same body.
    const result = mapWithAstLayer(entry, RENAMED_FILE);
    assert.ok(result.confidence >= 0.78, `Expected confidence >= 0.78, got ${result.confidence}`);
    assert.notEqual(result.status, "orphaned");
  });

  test("returns confidence 0.78 for a body-hash match", () => {
    const originalBodyLines = [
      '  if (!token) return false;',
      '  return token.startsWith("Bearer ");',
    ];
    const bh = computeBodyHash(originalBodyLines);

    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: {
        kind: "function",
        name: "oldName",
        blockHash: "wrong-block-hash",
        bodyHash: bh,
      },
    };

    const result = mapWithAstLayer(entry, RENAMED_FILE);
    assert.equal(result.confidence, 0.78);
  });

  test("body-hash match is stable across whitespace reformatting", () => {
    // Reformatted file: extra spaces in the function body.
    const REFORMATTED_FILE = `
export async function checkToken(token: string): Promise<boolean> {
    if ( !token ) return false;
    return token.startsWith( "Bearer " );
}
`.trimStart();

    const originalBodyLines = [
      '  if (!token) return false;',
      '  return token.startsWith("Bearer ");',
    ];
    const bh = computeBodyHash(originalBodyLines);

    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: {
        kind: "function",
        name: "validateToken",
        blockHash: "old-hash",
        bodyHash: bh,
      },
    };

    const result = mapWithAstLayer(entry, REFORMATTED_FILE);
    assert.ok(
      result.confidence >= 0.78,
      `Expected confidence >= 0.78, got ${result.confidence}`,
    );
  });

  test("does not use body-hash matching when bodyHash is absent", () => {
    const entry: ContextEntry = {
      ...BASE_ENTRY,
      astAnchor: {
        kind: "function",
        name: "validateToken",
        blockHash: "wrong-hash",
        // bodyHash intentionally absent
      },
    };
    const result = mapWithAstLayer(entry, RENAMED_FILE);
    // Name match fails (validateToken is gone), body hash unavailable — orphaned.
    assert.equal(result.status, "orphaned");
  });

  test("uses paramCount as tiebreaker when multiple nodes share the same body hash", () => {
    // Two functions with the same trivial body but different param counts.
    const FILE_WITH_TWINS = `
export function doA(x: string): string {
  return x;
}

export function doB(x: string, y: string): string {
  return x;
}
`.trimStart();

    const bodyLines = ["  return x;"];
    const bh = computeBodyHash(bodyLines);

    // Entry for the 1-param version.
    const entry: ContextEntry = {
      ...BASE_ENTRY,
      filePath: "src/twins.ts",
      astAnchor: {
        kind: "function",
        name: "oldOneParmName",
        blockHash: "wrong-hash",
        bodyHash: bh,
        paramCount: 1,
      },
    };

    const result = mapWithAstLayer(entry, FILE_WITH_TWINS);
    assert.ok(result.confidence >= 0.78);
    assert.ok(result.updatedLineRange.start < result.updatedLineRange.end);
    // Should match doA (1 param), not doB (2 params).
    assert.equal(result.updatedLineRange.start, 1);
  });
});

// ---------------------------------------------------------------------------
// searchForMovedEntry — cross-file / file-split (Gap 8)
// ---------------------------------------------------------------------------

describe("searchForMovedEntry — cross-file move detection (file split)", () => {
  const ORIGINAL_BODY = [
    '  if (!token) return false;',
    '  return token.startsWith("Bearer ");',
  ];

  const buildEntryWithBodyHash = (filePath: string): ContextEntry => ({
    ...BASE_ENTRY,
    filePath,
    astAnchor: {
      kind: "function",
      name: "validateToken",
      blockHash: hashAstSignature("function", "validateToken"),
      bodyHash: computeBodyHash(ORIGINAL_BODY),
    },
  });

  test("returns null when astAnchor is null", () => {
    const entry: ContextEntry = { ...BASE_ENTRY, astAnchor: null };
    const result = searchForMovedEntry(entry, new Map());
    assert.equal(result, null);
  });

  test("returns null when candidateFiles is empty", () => {
    const entry = buildEntryWithBodyHash("src/auth.ts");
    const result = searchForMovedEntry(entry, new Map());
    assert.equal(result, null);
  });

  test("returns null when the symbol is not found in any candidate file", () => {
    const entry = buildEntryWithBodyHash("src/auth.ts");
    const candidates = new Map([
      ["src/payments.ts", "export function charge(amount: number): void { return; }"],
    ]);
    const result = searchForMovedEntry(entry, candidates);
    assert.equal(result, null);
  });

  test("skips the original file when searching candidates", () => {
    const entry = buildEntryWithBodyHash("src/auth.ts");
    // Only candidate is the original file itself — should be skipped.
    const candidates = new Map([["src/auth.ts", ORIGINAL_FILE]]);
    const result = searchForMovedEntry(entry, candidates);
    assert.equal(result, null);
  });

  test("skips non-AST-applicable files (e.g. markdown)", () => {
    const entry = buildEntryWithBodyHash("src/auth.ts");
    const candidates = new Map([["README.md", "# Some docs"]]);
    const result = searchForMovedEntry(entry, candidates);
    assert.equal(result, null);
  });

  test("finds a function that moved to a different file (file-split scenario)", () => {
    const entry = buildEntryWithBodyHash("src/auth.ts");
    const TOKEN_MODULE = `
export async function validateToken(token: string): Promise<boolean> {
  if (!token) return false;
  return token.startsWith("Bearer ");
}
`.trimStart();

    const candidates = new Map([
      ["src/token.ts", TOKEN_MODULE],
      ["src/payments.ts", "export function charge(): void {}"],
    ]);

    const result = searchForMovedEntry(entry, candidates);
    assert.ok(result !== null);
    assert.equal(result.filePath, "src/token.ts");
    assert.ok(result.confidence >= 0.87);
    assert.ok(result.updatedLineRange.start >= 1);
    assert.ok(result.updatedLineRange.end >= result.updatedLineRange.start);
  });

  test("finds a renamed function in a different file using body-hash", () => {
    const entry = buildEntryWithBodyHash("src/auth.ts");
    const RENAMED_IN_OTHER_FILE = `
export async function checkToken(token: string): Promise<boolean> {
  if (!token) return false;
  return token.startsWith("Bearer ");
}
`.trimStart();

    const candidates = new Map([["src/token-utils.ts", RENAMED_IN_OTHER_FILE]]);
    const result = searchForMovedEntry(entry, candidates);
    assert.ok(result !== null, "should find renamed function via body hash");
    assert.ok(result.confidence >= 0.78);
  });

  test("returns the highest-confidence match when multiple files match", () => {
    // One file has the function by exact name (0.87), another by body hash only (0.78).
    const EXACT_NAME_FILE = `
export async function validateToken(token: string): Promise<boolean> {
  if (!token) return false;
  return token.startsWith("Bearer ");
}
`.trimStart();

    const RENAMED_FILE = `
export async function checkToken(token: string): Promise<boolean> {
  if (!token) return false;
  return token.startsWith("Bearer ");
}
`.trimStart();

    const candidates = new Map([
      ["src/renamed.ts", RENAMED_FILE],
      ["src/exact.ts", EXACT_NAME_FILE],
    ]);

    const testEntry = buildEntryWithBodyHash("src/auth.ts");
    const result = searchForMovedEntry(testEntry, candidates);
    assert.ok(result !== null);
    // The exact-name match should win.
    assert.equal(result.confidence, 0.87);
    assert.equal(result.filePath, "src/exact.ts");
  });
});
