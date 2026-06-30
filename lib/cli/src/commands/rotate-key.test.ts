// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { runRotateKey, RotateKeyError, formatRotateKeyResult } from "./rotate-key.js";

const KEY_FILE = ".kodela.master-key";

async function makeTmpRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kodela-rotate-key-test-"));
}

function deriveKeyIdLikeProd(rawBase64: string): string {
  const key = Buffer.from(rawBase64.trim(), "base64");
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

describe("runRotateKey", () => {
  test("rotates: old key → historical file, new key → current file", async () => {
    const repoRoot = await makeTmpRepo();
    try {
      const oldKeyB64 = randomBytes(32).toString("base64");
      await fs.writeFile(path.join(repoRoot, KEY_FILE), `${oldKeyB64}\n`);
      const expectedOldKeyId = deriveKeyIdLikeProd(oldKeyB64);

      const result = await runRotateKey({ repoRoot });

      assert.equal(result.oldKeyId, expectedOldKeyId);
      assert.notEqual(result.oldKeyId, result.newKeyId);
      assert.equal(result.currentKeyPath, path.join(repoRoot, KEY_FILE));
      assert.equal(
        result.historicalKeyPath,
        path.join(repoRoot, `.kodela.master-key-${expectedOldKeyId}`),
      );

      // Historical file should hold the OLD key (the same bytes we wrote).
      const histRaw = (await fs.readFile(result.historicalKeyPath, "utf8")).trim();
      assert.equal(histRaw, oldKeyB64);

      // Current file should hold a DIFFERENT 32-byte key.
      const newRaw = (await fs.readFile(result.currentKeyPath, "utf8")).trim();
      assert.notEqual(newRaw, oldKeyB64);
      const newKeyBytes = Buffer.from(newRaw, "base64");
      assert.equal(newKeyBytes.length, 32);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("file modes are 0600 on both files after rotation (POSIX)", async () => {
    if (process.platform === "win32") return; // Skip on Windows
    const repoRoot = await makeTmpRepo();
    try {
      const keyB64 = randomBytes(32).toString("base64");
      await fs.writeFile(path.join(repoRoot, KEY_FILE), `${keyB64}\n`);

      const result = await runRotateKey({ repoRoot });

      const histStat = await fs.stat(result.historicalKeyPath);
      const currStat = await fs.stat(result.currentKeyPath);
      assert.equal(histStat.mode & 0o777, 0o600, "historical key should be 0600");
      assert.equal(currStat.mode & 0o777, 0o600, "new current key should be 0600");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("throws when no master key exists", async () => {
    const repoRoot = await makeTmpRepo();
    try {
      await assert.rejects(
        () => runRotateKey({ repoRoot }),
        (err) => err instanceof RotateKeyError && /No master key found/.test(err.message),
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("throws when existing key file is not a valid 32-byte base64 key", async () => {
    const repoRoot = await makeTmpRepo();
    try {
      await fs.writeFile(path.join(repoRoot, KEY_FILE), "not-a-real-key");
      await assert.rejects(
        () => runRotateKey({ repoRoot }),
        (err) => err instanceof RotateKeyError && /not a valid 32-byte/.test(err.message),
      );
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("refuses to clobber an existing historical key file", async () => {
    const repoRoot = await makeTmpRepo();
    try {
      const oldKeyB64 = randomBytes(32).toString("base64");
      const oldKeyId = deriveKeyIdLikeProd(oldKeyB64);
      await fs.writeFile(path.join(repoRoot, KEY_FILE), `${oldKeyB64}\n`);
      // Pre-existing historical file with the SAME keyId — should block rotation
      // so we don't silently lose a previously-archived key.
      await fs.writeFile(
        path.join(repoRoot, `.kodela.master-key-${oldKeyId}`),
        "preexisting-historical-content\n",
      );

      await assert.rejects(
        () => runRotateKey({ repoRoot }),
        (err) => err instanceof RotateKeyError && /Historical key already exists/.test(err.message),
      );

      // The current key should be UNTOUCHED after the refusal — we should not
      // have started the rename and then failed half-way.
      const currentRaw = (await fs.readFile(path.join(repoRoot, KEY_FILE), "utf8")).trim();
      assert.equal(currentRaw, oldKeyB64, "rotation must not modify current key when it refuses");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("post-rotation: old envelope still decrypts under file-based historical lookup", async () => {
    // End-to-end: encrypt under old key, rotate, then verify decrypt still
    // works because encryption.ts's findKeyById picks up the historical file.
    const { encryptField, decryptField } = await import("@kodela/core/audit");

    const repoRoot = await makeTmpRepo();
    const prevRoot = process.env.KODELA_REPO_ROOT;
    const prevKey = process.env.KODELA_MASTER_KEY;
    process.env.KODELA_REPO_ROOT = repoRoot;
    delete process.env.KODELA_MASTER_KEY;
    try {
      // Phase 1 — write a key, encrypt something.
      const oldKeyB64 = randomBytes(32).toString("base64");
      await fs.writeFile(path.join(repoRoot, KEY_FILE), `${oldKeyB64}\n`);
      const envelope = encryptField("important secret written before rotation");
      assert.ok(envelope.startsWith("kdl-aesgcm:v1:"));

      // Phase 2 — rotate. Old key moves to historical; new current key is fresh.
      const result = await runRotateKey({ repoRoot });

      // Phase 3 — decrypt path resolves the old envelope's keyId to the
      // historical file, so the plaintext comes back.
      assert.equal(
        decryptField(envelope),
        "important secret written before rotation",
        "rotation must preserve readability of pre-rotation envelopes",
      );

      // Phase 4 — new envelopes use the new key.
      const fresh = encryptField("written after rotation");
      assert.ok(fresh.includes(`:${result.newKeyId}:`));
      assert.equal(decryptField(fresh), "written after rotation");
    } finally {
      if (prevRoot !== undefined) process.env.KODELA_REPO_ROOT = prevRoot;
      else delete process.env.KODELA_REPO_ROOT;
      if (prevKey !== undefined) process.env.KODELA_MASTER_KEY = prevKey;
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("formatRotateKeyResult", () => {
  test("includes old + new keyIds and both paths", () => {
    const txt = formatRotateKeyResult({
      repoRoot: "/tmp/repo",
      oldKeyId: "abcd1234",
      newKeyId: "ef567890",
      historicalKeyPath: "/tmp/repo/.kodela.master-key-abcd1234",
      currentKeyPath: "/tmp/repo/.kodela.master-key",
    });
    assert.match(txt, /abcd1234/);
    assert.match(txt, /ef567890/);
    assert.match(txt, /Historical key preserved/);
    assert.match(txt, /Back up/);
  });
});
