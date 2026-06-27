// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  readIndex,
  writeIndex,
  readContextEntry,
  writeContextEntry,
  deleteContextEntry,
  readMappingFile,
  writeMappingFile,
  ensureKodelaDir,
  formatIndexForMerge,
  ensureGitAttributesUnion,
  readComments,
  writeComment,
  resolveComment,
  deleteAllComments,
  KODELA_DIR,
} from "./storage.js";
import { guardPath, verifyNoSymlinkEscape } from "./path-guard.js";
import { hashFilePath } from "./path-guard.js";
import type { ContextEntry, IndexFile, MappingFile } from "../schema/index.js";
import { SCHEMA_VERSION } from "../schema/index.js";
import { PathTraversalError, SchemaVersionError, StorageCorruptionError } from "../errors.js";

const VALID_ENTRY: ContextEntry = {
  schemaVersion: "1.1.0",
  id: "550e8400-e29b-41d4-a716-446655440000",
  filePath: "src/auth/login.ts",
  astAnchor: null,
  contentHash: "abc123",
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

let tmpDir: string;

describe("Storage module", () => {
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("Index file", () => {
    test("readIndex returns an empty index when no index file exists", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-idx-"));
      try {
        const index = await readIndex(freshDir);
        assert.deepEqual(index.entries, []);
        assert.equal(index.schemaVersion, SCHEMA_VERSION);
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });

    test("writeIndex then readIndex round-trips correctly", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-idx2-"));
      try {
        await ensureKodelaDir(freshDir);
        const index: IndexFile = {
          schemaVersion: SCHEMA_VERSION,
          entries: ["550e8400-e29b-41d4-a716-446655440000"],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        };
        await writeIndex(freshDir, index);
        const read = await readIndex(freshDir);
        assert.deepEqual(read.entries, index.entries);
        assert.equal(read.schemaVersion, SCHEMA_VERSION);
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });

    test("readIndex throws SchemaVersionError on mismatched schemaVersion", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-sv-"));
      try {
        await ensureKodelaDir(freshDir);
        const badIndex = {
          schemaVersion: "99.0.0",
          entries: [],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        };
        const filePath = path.join(freshDir, KODELA_DIR, "index.json");
        await fs.writeFile(filePath, JSON.stringify(badIndex), "utf-8");
        await assert.rejects(
          () => readIndex(freshDir),
          SchemaVersionError,
        );
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });
  });

  describe("Context entry read/write", () => {
    test("writeContextEntry then readContextEntry round-trips correctly", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-entry-"));
      try {
        await ensureKodelaDir(freshDir);
        await writeContextEntry(freshDir, VALID_ENTRY);
        const read = await readContextEntry(freshDir, VALID_ENTRY.id);
        assert.deepEqual(read, VALID_ENTRY);
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });

    test("writeContextEntry registers ID in the index", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-idx3-"));
      try {
        await ensureKodelaDir(freshDir);
        await writeContextEntry(freshDir, VALID_ENTRY);
        const index = await readIndex(freshDir);
        assert.ok(index.entries.includes(VALID_ENTRY.id));
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });

    test("writeContextEntry is idempotent — does not duplicate index entries", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-idem-"));
      try {
        await ensureKodelaDir(freshDir);
        await writeContextEntry(freshDir, VALID_ENTRY);
        await writeContextEntry(freshDir, VALID_ENTRY);
        const index = await readIndex(freshDir);
        const count = index.entries.filter((e) => e === VALID_ENTRY.id).length;
        assert.equal(count, 1);
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });

    test("deleteContextEntry removes the entry and deregisters from index", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-del-"));
      try {
        await ensureKodelaDir(freshDir);
        await writeContextEntry(freshDir, VALID_ENTRY);
        await deleteContextEntry(freshDir, VALID_ENTRY.id);
        const index = await readIndex(freshDir);
        assert.ok(!index.entries.includes(VALID_ENTRY.id));
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });

    test("deleteContextEntry is idempotent when entry does not exist", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-del2-"));
      try {
        await ensureKodelaDir(freshDir);
        await assert.doesNotReject(() =>
          deleteContextEntry(freshDir, "550e8400-e29b-41d4-a716-446655440000"),
        );
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });

    test("readContextEntry throws on corrupt JSON", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-corrupt-"));
      try {
        await ensureKodelaDir(freshDir);
        const filePath = path.join(freshDir, KODELA_DIR, "objects", `${VALID_ENTRY.id}.json`);
        await fs.writeFile(filePath, "not-valid-json", "utf-8");
        await assert.rejects(
          () => readContextEntry(freshDir, VALID_ENTRY.id),
          StorageCorruptionError,
        );
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });
  });

  describe("Mapping file read/write", () => {
    test("readMappingFile returns null when no mapping exists", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-map-"));
      try {
        await ensureKodelaDir(freshDir);
        const result = await readMappingFile(freshDir, "src/auth/login.ts");
        assert.equal(result, null);
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });

    test("writeMappingFile then readMappingFile round-trips correctly", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-map2-"));
      try {
        await ensureKodelaDir(freshDir);
        const filePath = "src/auth/login.ts";
        const mapping: MappingFile = {
          schemaVersion: SCHEMA_VERSION,
          filePathHash: hashFilePath(filePath),
          updatedAt: "2024-01-01T00:00:00.000Z",
          mappings: [
            {
              entryId: VALID_ENTRY.id,
              lineRange: { start: 1, end: 5 },
              confidence: 0.92,
              status: "mapped",
            },
          ],
        };
        await writeMappingFile(freshDir, mapping);
        const read = await readMappingFile(freshDir, filePath);
        assert.notEqual(read, null);
        assert.equal(read!.mappings.length, 1);
        assert.equal(read!.mappings[0]!.entryId, VALID_ENTRY.id);
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });
  });

  describe("Path guard security", () => {
    test("guardPath throws PathTraversalError for '..' escape", () => {
      assert.throws(
        () => guardPath("/repo", "../../etc/passwd"),
        PathTraversalError,
      );
    });

    test("guardPath throws PathTraversalError for null byte in path", () => {
      assert.throws(
        () => guardPath("/repo", "safe\0path"),
        PathTraversalError,
      );
    });

    test("guardPath allows paths within the repo root", () => {
      const resolved = guardPath("/repo", ".kodela/objects/test.json");
      assert.ok(resolved.startsWith("/repo"));
    });
  });

  describe("Gap 17 — formatIndexForMerge (merge-friendly index format)", () => {
    test("empty entries array produces valid JSON with empty array", () => {
      const index: IndexFile = {
        schemaVersion: SCHEMA_VERSION,
        entries: [],
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };
      const output = formatIndexForMerge(index);
      const parsed = JSON.parse(output) as IndexFile;
      assert.deepEqual(parsed.entries, []);
      assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
    });

    test("each UUID occupies its own line in the output", () => {
      const uuid1 = "550e8400-e29b-41d4-a716-446655440001";
      const uuid2 = "550e8400-e29b-41d4-a716-446655440002";
      const index: IndexFile = {
        schemaVersion: SCHEMA_VERSION,
        entries: [uuid1, uuid2],
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };
      const output = formatIndexForMerge(index);
      const lines = output.split("\n");
      const uuid1Line = lines.find((l) => l.includes(uuid1));
      const uuid2Line = lines.find((l) => l.includes(uuid2));
      assert.ok(uuid1Line, "uuid1 has its own line");
      assert.ok(uuid2Line, "uuid2 has its own line");
      assert.notEqual(uuid1Line, uuid2Line, "each UUID is on a different line");
    });

    test("produces a deterministic stable output for the same input", () => {
      const index: IndexFile = {
        schemaVersion: SCHEMA_VERSION,
        entries: ["550e8400-e29b-41d4-a716-446655440001"],
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };
      assert.equal(formatIndexForMerge(index), formatIndexForMerge(index));
    });

    test("output is valid JSON that round-trips through JSON.parse", () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440003";
      const index: IndexFile = {
        schemaVersion: SCHEMA_VERSION,
        entries: [uuid],
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-02-15T12:00:00.000Z",
      };
      const output = formatIndexForMerge(index);
      const parsed = JSON.parse(output) as IndexFile;
      assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
      assert.deepEqual(parsed.entries, [uuid]);
      assert.equal(parsed.createdAt, index.createdAt);
      assert.equal(parsed.updatedAt, index.updatedAt);
    });

    test("writeIndex stores the merge-friendly format (one UUID per line)", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-fmt-"));
      try {
        await ensureKodelaDir(freshDir);
        const uuid = "550e8400-e29b-41d4-a716-446655440004";
        const index: IndexFile = {
          schemaVersion: SCHEMA_VERSION,
          entries: [uuid],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        };
        await writeIndex(freshDir, index);
        const raw = await fs.readFile(
          path.join(freshDir, KODELA_DIR, "index.json"),
          "utf-8",
        );
        const lines = raw.split("\n");
        const uuidLine = lines.find((l) => l.includes(uuid));
        assert.ok(uuidLine, "UUID should be on its own line in the written file");
        const uuidLines = lines.filter((l) => l.includes(uuid));
        assert.equal(uuidLines.length, 1, "UUID appears exactly once");
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });

    test("readIndex can parse a merge-friendly formatted index", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-reparse-"));
      try {
        await ensureKodelaDir(freshDir);
        const uuid1 = "550e8400-e29b-41d4-a716-446655440005";
        const uuid2 = "550e8400-e29b-41d4-a716-446655440006";
        const index: IndexFile = {
          schemaVersion: SCHEMA_VERSION,
          entries: [uuid1, uuid2],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        };
        await writeIndex(freshDir, index);
        const read = await readIndex(freshDir);
        assert.deepEqual(read.entries, [uuid1, uuid2]);
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });
  });

  describe("Gap 17 — ensureGitAttributesUnion (.gitattributes setup)", () => {
    test("creates .kodela/.gitattributes with union merge rule when absent", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ga-"));
      try {
        await ensureKodelaDir(freshDir);
        const attrPath = path.join(freshDir, KODELA_DIR, ".gitattributes");
        const content = await fs.readFile(attrPath, "utf-8");
        assert.ok(content.includes("index.json merge=union"), "union rule present");
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });

    test("ensureGitAttributesUnion is idempotent — does not duplicate the rule", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ga2-"));
      try {
        await ensureKodelaDir(freshDir);
        await ensureGitAttributesUnion(freshDir);
        await ensureGitAttributesUnion(freshDir);
        const attrPath = path.join(freshDir, KODELA_DIR, ".gitattributes");
        const content = await fs.readFile(attrPath, "utf-8");
        const ruleCount = content.split("\n").filter((l) => l.trim() === "index.json merge=union").length;
        assert.equal(ruleCount, 1, "rule should appear exactly once even after multiple calls");
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });

    test("appends rule to existing .gitattributes without overwriting it", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ga3-"));
      try {
        await ensureKodelaDir(freshDir);
        const attrPath = path.join(freshDir, KODELA_DIR, ".gitattributes");
        await fs.writeFile(attrPath, "*.lock binary\n", "utf-8");
        await ensureGitAttributesUnion(freshDir);
        const content = await fs.readFile(attrPath, "utf-8");
        assert.ok(content.includes("*.lock binary"), "existing rule preserved");
        assert.ok(content.includes("index.json merge=union"), "new rule appended");
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });

    test("does not modify file when rule is already present in existing .gitattributes", async () => {
      const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ga4-"));
      try {
        await ensureKodelaDir(freshDir);
        const attrPath = path.join(freshDir, KODELA_DIR, ".gitattributes");
        const initial = "index.json merge=union\n";
        await fs.writeFile(attrPath, initial, "utf-8");
        await ensureGitAttributesUnion(freshDir);
        const content = await fs.readFile(attrPath, "utf-8");
        assert.equal(content, initial, "file left unchanged when rule already present");
      } finally {
        await fs.rm(freshDir, { recursive: true, force: true });
      }
    });
  });

  describe("Symlink escape prevention", () => {
    test("verifyNoSymlinkEscape throws PathTraversalError when .kodela is symlinked outside repo", async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-sym1-"));
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-sym-outside-"));
      try {
        const kodelaLink = path.join(repoDir, ".kodela");
        await fs.symlink(outsideDir, kodelaLink);
        const escapedPath = path.join(kodelaLink, "objects", "entry.json");
        await assert.rejects(
          () => verifyNoSymlinkEscape(repoDir, escapedPath),
          PathTraversalError,
        );
      } finally {
        await fs.rm(repoDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    test("verifyNoSymlinkEscape allows paths that resolve within repo root", async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-sym2-"));
      try {
        const kodelaDir = path.join(repoDir, ".kodela");
        await fs.mkdir(kodelaDir, { recursive: true });
        const targetPath = path.join(kodelaDir, "index.json");
        await assert.doesNotReject(() =>
          verifyNoSymlinkEscape(repoDir, targetPath),
        );
      } finally {
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });

    test("writeContextEntry rejects a repo where .kodela is symlinked outside", async () => {
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-sym3-"));
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-sym3-out-"));
      try {
        const kodelaLink = path.join(repoDir, ".kodela");
        await fs.mkdir(path.join(outsideDir, "objects"), { recursive: true });
        await fs.symlink(outsideDir, kodelaLink);
        await assert.rejects(
          () => writeContextEntry(repoDir, VALID_ENTRY),
          PathTraversalError,
        );
      } finally {
        await fs.rm(repoDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe("Gap 44 — comment storage", () => {
    const ENTRY_ID = VALID_ENTRY.id;

    function makeComment(overrides: Partial<{
      id: string; body: string; author: string;
    }> = {}) {
      return {
        id: overrides.id ?? "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        entryId: ENTRY_ID,
        author: overrides.author ?? "alice",
        body: overrides.body ?? "This note needs clarification.",
        createdAt: "2024-06-01T12:00:00.000Z",
      };
    }

    test("readComments returns empty array when no file exists", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-cmts-"));
      try {
        await ensureKodelaDir(dir);
        const comments = await readComments(dir, ENTRY_ID);
        assert.deepEqual(comments, []);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    test("writeComment then readComments round-trips correctly", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-cmts-"));
      try {
        await ensureKodelaDir(dir);
        const c = makeComment();
        await writeComment(dir, c);
        const comments = await readComments(dir, ENTRY_ID);
        assert.equal(comments.length, 1);
        assert.deepEqual(comments[0], c);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    test("writeComment appends — multiple comments are ordered oldest first", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-cmts-"));
      try {
        await ensureKodelaDir(dir);
        const c1 = makeComment({ id: "11111111-1111-1111-1111-111111111111", body: "first" });
        const c2 = makeComment({ id: "22222222-2222-2222-2222-222222222222", body: "second" });
        await writeComment(dir, c1);
        await writeComment(dir, c2);
        const comments = await readComments(dir, ENTRY_ID);
        assert.equal(comments.length, 2);
        assert.equal(comments[0].body, "first");
        assert.equal(comments[1].body, "second");
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    test("resolveComment stamps resolvedAt and returns true", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-cmts-"));
      try {
        await ensureKodelaDir(dir);
        const c = makeComment();
        await writeComment(dir, c);
        const found = await resolveComment(dir, ENTRY_ID, c.id);
        assert.equal(found, true);
        const all = await readComments(dir, ENTRY_ID, { includeResolved: true });
        assert.ok(all[0].resolvedAt, "resolvedAt should be set");
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    test("resolved comments are excluded from the default listing", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-cmts-"));
      try {
        await ensureKodelaDir(dir);
        const c = makeComment();
        await writeComment(dir, c);
        await resolveComment(dir, ENTRY_ID, c.id);
        const active = await readComments(dir, ENTRY_ID);
        assert.equal(active.length, 0);
        const all = await readComments(dir, ENTRY_ID, { includeResolved: true });
        assert.equal(all.length, 1);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    test("resolveComment returns false when commentId is not found", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-cmts-"));
      try {
        await ensureKodelaDir(dir);
        const c = makeComment();
        await writeComment(dir, c);
        const found = await resolveComment(dir, ENTRY_ID, "00000000-0000-0000-0000-000000000000");
        assert.equal(found, false);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    test("deleteAllComments removes the thread file", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-cmts-"));
      try {
        await ensureKodelaDir(dir);
        await writeComment(dir, makeComment());
        await deleteAllComments(dir, ENTRY_ID);
        const comments = await readComments(dir, ENTRY_ID);
        assert.deepEqual(comments, []);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    test("deleteAllComments is a no-op when no thread exists", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-cmts-"));
      try {
        await ensureKodelaDir(dir);
        await assert.doesNotReject(() => deleteAllComments(dir, ENTRY_ID));
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });
});
