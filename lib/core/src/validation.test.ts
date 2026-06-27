// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { selectMappingLayer, mapContextEntry } from "./engine/mapping-engine.js";
import { mapWithAstLayer, isAstLayerApplicable, buildAstFingerprint } from "./engine/ast-layer.js";
import { mapWithTokenHashLayer, hashTokenStream } from "./engine/token-hash-layer.js";
import { mapWithGitDiffLayer } from "./engine/git-diff-layer.js";
import {
  readIndex,
  writeIndex,
  readContextEntry,
  writeContextEntry,
  deleteContextEntry,
  readMappingFile,
  writeMappingFile,
  readBaseline,
  writeBaseline,
  ensureKodelaDir,
} from "./storage/storage.js";
import { normalizeRepoPath, hashFilePath } from "./storage/path-guard.js";
import { initBaseline, isBaselineInitialized, getBaseline } from "./baseline/baseline.js";
import type { ContextEntry, IndexFile } from "./schema/index.js";

const VALID_ENTRY: ContextEntry = {
  schemaVersion: "1.1.0",
  id: "550e8400-e29b-41d4-a716-446655440000",
  filePath: "src/auth/login.ts",
  astAnchor: null,
  contentHash: "a".repeat(64),
  lineRange: { start: 1, end: 5 },
  note: "Test annotation.",
  author: "alice",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  severity: "low",
  tags: [],
  source: "human",
  confidence: 0.95,
  status: "mapped",
  reviewRequired: false,
};

const VALID_REPO = "/tmp/kodela-test-repo";

function assertZodRejection(fn: () => unknown): void {
  assert.throws(fn, (err) => {
    assert.ok(
      err instanceof Error,
      `Expected Error, got ${String(err)}`,
    );
    return true;
  });
}

async function assertZodRejectionAsync(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err) => {
    assert.ok(err instanceof Error);
    return true;
  });
}

describe("Input validation — repoRoot boundaries", () => {
  test("readIndex rejects empty repoRoot", async () => {
    await assertZodRejectionAsync(() => readIndex(""));
  });

  test("readIndex rejects repoRoot with null byte", async () => {
    await assertZodRejectionAsync(() => readIndex("/tmp/a\0b"));
  });

  test("writeContextEntry rejects empty repoRoot", async () => {
    await assertZodRejectionAsync(() => writeContextEntry("", VALID_ENTRY));
  });

  test("readContextEntry rejects empty repoRoot", async () => {
    await assertZodRejectionAsync(() =>
      readContextEntry("", "550e8400-e29b-41d4-a716-446655440000"),
    );
  });

  test("deleteContextEntry rejects empty repoRoot", async () => {
    await assertZodRejectionAsync(() =>
      deleteContextEntry("", "550e8400-e29b-41d4-a716-446655440000"),
    );
  });

  test("readMappingFile rejects empty repoRoot", async () => {
    await assertZodRejectionAsync(() => readMappingFile("", "src/foo.ts"));
  });

  test("ensureKodelaDir rejects empty repoRoot", async () => {
    await assertZodRejectionAsync(() => ensureKodelaDir(""));
  });

  test("readBaseline rejects empty repoRoot", async () => {
    await assertZodRejectionAsync(() => readBaseline(""));
  });

  test("initBaseline rejects empty repoRoot", async () => {
    await assertZodRejectionAsync(() => initBaseline(""));
  });

  test("isBaselineInitialized rejects empty repoRoot", async () => {
    await assertZodRejectionAsync(() => isBaselineInitialized(""));
  });

  test("getBaseline rejects empty repoRoot", async () => {
    await assertZodRejectionAsync(() => getBaseline(""));
  });
});

describe("Input validation — entryId boundaries", () => {
  test("readContextEntry rejects non-UUID id", async () => {
    await assertZodRejectionAsync(() =>
      readContextEntry(VALID_REPO, "not-a-uuid"),
    );
  });

  test("deleteContextEntry rejects non-UUID id", async () => {
    await assertZodRejectionAsync(() =>
      deleteContextEntry(VALID_REPO, "not-a-uuid"),
    );
  });

  test("readContextEntry rejects empty id", async () => {
    await assertZodRejectionAsync(() => readContextEntry(VALID_REPO, ""));
  });
});

describe("Input validation — filePath boundaries", () => {
  test("readMappingFile rejects empty filePath", async () => {
    await assertZodRejectionAsync(() => readMappingFile(VALID_REPO, ""));
  });

  test("normalizeRepoPath rejects empty filePath", () => {
    assertZodRejection(() => normalizeRepoPath(""));
  });

  test("normalizeRepoPath rejects path with null byte", () => {
    assertZodRejection(() => normalizeRepoPath("src/a\0b.ts"));
  });

  test("hashFilePath rejects empty filePath", () => {
    assertZodRejection(() => hashFilePath(""));
  });

  test("hashFilePath rejects path with null byte", () => {
    assertZodRejection(() => hashFilePath("src/a\0b.ts"));
  });

  test("isAstLayerApplicable rejects empty filePath", () => {
    assertZodRejection(() => isAstLayerApplicable(""));
  });
});

describe("Input validation — fileContent boundaries", () => {
  test("hashTokenStream rejects non-string content", () => {
    assertZodRejection(() => hashTokenStream(null as unknown as string));
  });

  test("buildAstFingerprint rejects non-string content", () => {
    assertZodRejection(() => buildAstFingerprint(null as unknown as string));
  });
});

describe("Input validation — engine layer function boundaries", () => {
  test("selectMappingLayer rejects invalid entry (bad schemaVersion)", () => {
    const badEntry = { ...VALID_ENTRY, schemaVersion: "99.0.0" };
    assertZodRejection(() =>
      selectMappingLayer(badEntry as unknown as ContextEntry, "content"),
    );
  });

  test("mapWithAstLayer rejects invalid entry (bad schemaVersion)", () => {
    const badEntry = { ...VALID_ENTRY, schemaVersion: "99.0.0" };
    assertZodRejection(() =>
      mapWithAstLayer(badEntry as unknown as ContextEntry, "content"),
    );
  });

  test("mapWithTokenHashLayer rejects invalid entry (bad schemaVersion)", () => {
    const badEntry = { ...VALID_ENTRY, schemaVersion: "99.0.0" };
    assertZodRejection(() =>
      mapWithTokenHashLayer(badEntry as unknown as ContextEntry, "content"),
    );
  });

  test("mapWithGitDiffLayer rejects invalid entry (bad schemaVersion)", async () => {
    const badEntry = { ...VALID_ENTRY, schemaVersion: "99.0.0" };
    await assertZodRejectionAsync(() =>
      mapWithGitDiffLayer(badEntry as unknown as ContextEntry, VALID_REPO),
    );
  });

  test("mapWithGitDiffLayer rejects empty repoRoot", async () => {
    await assertZodRejectionAsync(() =>
      mapWithGitDiffLayer(VALID_ENTRY, ""),
    );
  });

  test("mapContextEntry rejects empty repoRoot", async () => {
    await assertZodRejectionAsync(() =>
      mapContextEntry(VALID_ENTRY, "content", ""),
    );
  });

  test("mapContextEntry rejects invalid entry", async () => {
    const badEntry = { ...VALID_ENTRY, confidence: 2 };
    await assertZodRejectionAsync(() =>
      mapContextEntry(badEntry as unknown as ContextEntry, "content", VALID_REPO),
    );
  });
});

describe("Input validation — initBaseline options boundaries", () => {
  test("initBaseline rejects unknown option fields", async () => {
    await assertZodRejectionAsync(() =>
      initBaseline(VALID_REPO, { force: true, unknown: "field" } as object),
    );
  });
});
