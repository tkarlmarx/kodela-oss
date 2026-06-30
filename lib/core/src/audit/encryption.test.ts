// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encryptField,
  decryptField,
  encryptFieldsInPlace,
  decryptFieldsInPlace,
  isEncrypted,
  isEncryptionEnabled,
  _setKeyringForTests,
  _clearKeyringForTests,
} from "./encryption.js";

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

function withKey(key: Buffer, keyId: string, fn: () => void): void {
  _setKeyringForTests([{ keyId, key, isCurrent: true }]);
  try {
    fn();
  } finally {
    _clearKeyringForTests();
  }
}

function withKeyring(
  keys: Array<{ keyId: string; key: Buffer; isCurrent?: boolean }>,
  fn: () => void,
): void {
  _setKeyringForTests(keys);
  try {
    fn();
  } finally {
    _clearKeyringForTests();
  }
}

test("isEncryptionEnabled: false when no key configured", () => {
  _clearKeyringForTests();
  // Defensive — strip env vars AND point the file-loader at a fresh tmpdir so
  // a stray `.kodela.master-key` in process.cwd() can't accidentally turn
  // encryption on.
  const prev = process.env.KODELA_MASTER_KEY;
  const prevRoot = process.env.KODELA_REPO_ROOT;
  delete process.env.KODELA_MASTER_KEY;
  const emptyRoot = mkdtempSync(join(tmpdir(), "kodela-noenc-"));
  process.env.KODELA_REPO_ROOT = emptyRoot;
  try {
    assert.equal(isEncryptionEnabled(), false);
  } finally {
    if (prev !== undefined) process.env.KODELA_MASTER_KEY = prev;
    if (prevRoot !== undefined) process.env.KODELA_REPO_ROOT = prevRoot;
    else delete process.env.KODELA_REPO_ROOT;
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("isEncryptionEnabled: true with key configured (test override)", () => {
  withKey(KEY_A, "abcd1234", () => {
    assert.equal(isEncryptionEnabled(), true);
  });
});

test("encryptField is a no-op when no key configured", () => {
  _clearKeyringForTests();
  const prev = process.env.KODELA_MASTER_KEY;
  const prevRoot = process.env.KODELA_REPO_ROOT;
  delete process.env.KODELA_MASTER_KEY;
  const emptyRoot = mkdtempSync(join(tmpdir(), "kodela-noenc-"));
  process.env.KODELA_REPO_ROOT = emptyRoot;
  try {
    const result = encryptField("anything");
    assert.equal(result, "anything");
    assert.equal(isEncrypted(result), false);
  } finally {
    if (prev !== undefined) process.env.KODELA_MASTER_KEY = prev;
    if (prevRoot !== undefined) process.env.KODELA_REPO_ROOT = prevRoot;
    else delete process.env.KODELA_REPO_ROOT;
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("encryptField/decryptField round-trip restores the original string", () => {
  withKey(KEY_A, "kid-001a", () => {
    const original = "Session manager owns the currentTokenId field.";
    const envelope = encryptField(original);
    assert.ok(isEncrypted(envelope), `expected envelope prefix; got ${envelope}`);
    assert.ok(envelope.includes(":kid-001a:"), "keyId must appear in envelope");
    assert.equal(decryptField(envelope), original);
  });
});

test("envelope format: kdl-aesgcm:v1:<kid>:<iv>:<tag>:<ct>", () => {
  withKey(KEY_A, "kid-002a", () => {
    const envelope = encryptField("hi");
    assert.match(envelope, /^kdl-aesgcm:v1:kid-002a:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  });
});

test("encrypted output is non-deterministic (random IV)", () => {
  withKey(KEY_A, "kid-003a", () => {
    const a = encryptField("same plaintext");
    const b = encryptField("same plaintext");
    assert.notEqual(a, b);
    assert.equal(decryptField(a), "same plaintext");
    assert.equal(decryptField(b), "same plaintext");
  });
});

test("decryptField on plain text passes through unchanged", () => {
  withKey(KEY_A, "kid-004a", () => {
    const value = "not encrypted at all";
    assert.equal(decryptField(value), value);
  });
});

function flipLastChar(s: string): string {
  // Swap the FIRST char of the segment to a different base64url char.  Earlier
  // versions of this helper flipped the LAST char, but ran into a subtle bug:
  // on a 16-byte (128-bit) tag the last base64 char covers only 2 meaningful
  // bits; the remaining 4 bits are zero-padding.  Flipping "A" (000000) → "B"
  // (000001) keeps the top 2 bits as 00, so the decoded byte didn't actually
  // change → flake rate ~25%.  The FIRST char of any base64 segment always
  // covers a full 6 bits of real data, so flipping it reliably changes the
  // decoded bytes — the same property the GCM tag check needs to catch.
  const first = s[0]!;
  const replacement = first === "A" ? "B" : "A";
  return replacement + s.slice(1);
}

test("decryptField throws on tampered ciphertext (GCM tag fails)", () => {
  withKey(KEY_A, "kid-005a", () => {
    const envelope = encryptField("secret value");
    // Flip the last char in the ciphertext segment (last segment).
    const parts = envelope.split(":");
    parts[parts.length - 1] = flipLastChar(parts[parts.length - 1]!);
    assert.throws(() => decryptField(parts.join(":")), /authentication tag mismatch/i);
  });
});

test("decryptField throws on tampered authentication tag", () => {
  withKey(KEY_A, "kid-006a", () => {
    const envelope = encryptField("secret value");
    const parts = envelope.split(":");
    // tag is at index 4 (0-indexed: "kdl-aesgcm" | "v1" | kid | iv | tag | ct)
    parts[4] = flipLastChar(parts[4]!);
    assert.throws(() => decryptField(parts.join(":")), /authentication tag mismatch/i);
  });
});

test("decryptField with wrong key fails (auth tag mismatch)", () => {
  let envelope = "";
  withKey(KEY_A, "kid-007a", () => {
    envelope = encryptField("secret value");
  });
  // Now switch to a totally different key with the SAME keyId — the GCM tag
  // verification fails because the keys are different.
  withKey(KEY_B, "kid-007a", () => {
    assert.throws(() => decryptField(envelope), /authentication tag mismatch/i);
  });
});

test("decryptField with unknown keyId throws a typed error", () => {
  withKey(KEY_A, "kid-008a", () => {
    const envelope = encryptField("hi");
    // Switch keyring to one that doesn't have this keyId.
    withKeyring([{ keyId: "kid-different", key: KEY_B, isCurrent: true }], () => {
      assert.throws(() => decryptField(envelope), /no key configured for keyId=kid-008a/i);
    });
  });
});

test("decryptField rejects malformed envelopes", () => {
  withKey(KEY_A, "kid-009a", () => {
    assert.throws(() => decryptField("kdl-aesgcm:v1:bad"), /malformed envelope/i);
    assert.throws(() => decryptField("kdl-aesgcm:v1:kid::tag:ct"), /malformed envelope/i);
  });
});

test("key rotation: encrypt with new key, decrypt LEGACY with old key", () => {
  // Simulate a rotation: a record was encrypted with kid-old; the new
  // current key is kid-new. Both keys are in the keyring so the legacy
  // record can still be read.
  let legacyEnvelope = "";
  withKey(KEY_A, "kid-old", () => {
    legacyEnvelope = encryptField("written under old key");
  });
  withKeyring(
    [
      { keyId: "kid-new", key: KEY_B, isCurrent: true },
      { keyId: "kid-old", key: KEY_A }, // historical key for decrypt-only
    ],
    () => {
      // Read path: legacy envelope decrypts fine.
      assert.equal(decryptField(legacyEnvelope), "written under old key");
      // Write path: new records use the new key.
      const fresh = encryptField("new content");
      assert.ok(fresh.includes(":kid-new:"));
      assert.equal(decryptField(fresh), "new content");
    },
  );
});

test("encryptFieldsInPlace: encrypts only string fields, idempotent", () => {
  withKey(KEY_A, "kid-fields-a", () => {
    const payload = {
      why_changed: "rotate tokens",
      problem_solved: "prevent replay",
      ai_reasoning: "",
      file_path: "src/auth.ts", // not encrypted (not in fields list)
      lines_added: 10,
    };
    const encrypted = encryptFieldsInPlace({ ...payload }, ["why_changed", "problem_solved", "ai_reasoning"]);
    assert.ok(isEncrypted(encrypted.why_changed));
    assert.ok(isEncrypted(encrypted.problem_solved));
    assert.equal(encrypted.ai_reasoning, "", "empty strings are skipped");
    assert.equal(encrypted.file_path, "src/auth.ts", "non-listed field untouched");
    assert.equal(encrypted.lines_added, 10);

    // Idempotency: running it again doesn't double-wrap.
    const before = encrypted.why_changed;
    encryptFieldsInPlace(encrypted, ["why_changed"]);
    assert.equal(encrypted.why_changed, before, "double-encrypt is a bug");
  });
});

test("decryptFieldsInPlace: round-trip through encrypt+decrypt", () => {
  withKey(KEY_A, "kid-fields-b", () => {
    const original = {
      why_changed: "ordinary text",
      problem_solved: "fixed it",
      file_path: "src/auth.ts",
    };
    const encrypted = encryptFieldsInPlace({ ...original }, ["why_changed", "problem_solved"]);
    assert.ok(isEncrypted(encrypted.why_changed));
    assert.ok(isEncrypted(encrypted.problem_solved));
    const decrypted = decryptFieldsInPlace(encrypted, ["why_changed", "problem_solved"]);
    assert.equal(decrypted.why_changed, "ordinary text");
    assert.equal(decrypted.problem_solved, "fixed it");
    assert.equal(decrypted.file_path, "src/auth.ts");
  });
});

test("encryptFieldsInPlace is a no-op when no key configured", () => {
  _clearKeyringForTests();
  const prev = process.env.KODELA_MASTER_KEY;
  const prevRoot = process.env.KODELA_REPO_ROOT;
  delete process.env.KODELA_MASTER_KEY;
  const emptyRoot = mkdtempSync(join(tmpdir(), "kodela-noenc-"));
  process.env.KODELA_REPO_ROOT = emptyRoot;
  try {
    const payload = { why_changed: "plain text", note: "untouched" };
    const result = encryptFieldsInPlace({ ...payload }, ["why_changed"]);
    assert.equal(result.why_changed, "plain text", "no-key mode passes plaintext through");
    assert.equal(isEncrypted(result.why_changed), false);
  } finally {
    if (prev !== undefined) process.env.KODELA_MASTER_KEY = prev;
    if (prevRoot !== undefined) process.env.KODELA_REPO_ROOT = prevRoot;
    else delete process.env.KODELA_REPO_ROOT;
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("isEncrypted: sniffs the envelope prefix without parsing", () => {
  assert.equal(isEncrypted("kdl-aesgcm:v1:kid:iv:tag:ct"), true);
  assert.equal(isEncrypted("plain text"), false);
  assert.equal(isEncrypted(""), false);
  assert.equal(isEncrypted(null), false);
  assert.equal(isEncrypted(undefined), false);
  assert.equal(isEncrypted(42), false);
});

// ── doc 27 §E.7 — file-based key loader ────────────────────────────────────

/**
 * Run `fn` with a fake repo root that contains the given files.
 * Cleans up tmpdir + KODELA_REPO_ROOT + KODELA_MASTER_KEY on exit so test
 * isolation is preserved even when fn throws.
 */
function withFileRepo(
  files: Record<string, string>,
  fn: (repoRoot: string) => void,
): void {
  const repoRoot = mkdtempSync(join(tmpdir(), "kodela-encryption-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(repoRoot, name), content);
  }
  const prevRoot = process.env.KODELA_REPO_ROOT;
  const prevKey = process.env.KODELA_MASTER_KEY;
  process.env.KODELA_REPO_ROOT = repoRoot;
  delete process.env.KODELA_MASTER_KEY;
  _clearKeyringForTests();
  try {
    fn(repoRoot);
  } finally {
    if (prevRoot !== undefined) process.env.KODELA_REPO_ROOT = prevRoot;
    else delete process.env.KODELA_REPO_ROOT;
    if (prevKey !== undefined) process.env.KODELA_MASTER_KEY = prevKey;
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("file loader: .kodela.master-key enables encryption automatically", () => {
  const key = randomBytes(32).toString("base64");
  withFileRepo({ ".kodela.master-key": `${key}\n` }, () => {
    assert.equal(isEncryptionEnabled(), true);
    const envelope = encryptField("from the file-based key");
    assert.ok(isEncrypted(envelope));
    assert.equal(decryptField(envelope), "from the file-based key");
  });
});

test("file loader: missing .kodela.master-key falls back to plaintext", () => {
  withFileRepo({}, () => {
    assert.equal(isEncryptionEnabled(), false);
    assert.equal(encryptField("hello"), "hello");
  });
});

test("file loader: malformed key file is rejected, encryption stays off", () => {
  withFileRepo({ ".kodela.master-key": "not-a-base64-32-byte-key" }, () => {
    assert.equal(isEncryptionEnabled(), false);
    assert.equal(encryptField("hello"), "hello");
  });
});

test("file loader: env var KODELA_MASTER_KEY wins over file (SaaS override)", () => {
  const fileKey = randomBytes(32).toString("base64");
  const envKey = randomBytes(32).toString("base64");
  withFileRepo({ ".kodela.master-key": `${fileKey}\n` }, () => {
    process.env.KODELA_MASTER_KEY = envKey;
    const envelope = encryptField("payload");
    // Sanity: we encrypted under the env-var key, not the file key. So removing
    // the env var (back to file-only) should fail to decrypt with the file key
    // — different key bytes ⇒ keyId mismatch ⇒ "no key configured for keyId=…".
    delete process.env.KODELA_MASTER_KEY;
    assert.throws(() => decryptField(envelope), /no key configured for keyId=/);
  });
});

test("file loader: rotation via historical key file (.kodela.master-key-<keyId>)", () => {
  // Set up: encrypt with KEY_OLD, then rotate by replacing the current-key
  // file with KEY_NEW and storing KEY_OLD as a historical file.
  const oldKey = randomBytes(32);
  const oldKeyB64 = oldKey.toString("base64");
  const newKey = randomBytes(32);
  const newKeyB64 = newKey.toString("base64");

  // Derive the keyId the production code will assign to `oldKey`.
  // (Same algorithm as encryption.ts: first 8 hex chars of sha256(key).)
  const oldKeyId = createHash("sha256").update(oldKey).digest("hex").slice(0, 8);

  // Phase 1: encrypt under old key.
  let envelope = "";
  withFileRepo({ ".kodela.master-key": `${oldKeyB64}\n` }, () => {
    envelope = encryptField("written under old key");
    assert.ok(envelope.includes(`:${oldKeyId}:`), "envelope must reference old keyId");
  });

  // Phase 2: rotated — new key is current, old key file is historical.
  withFileRepo(
    {
      ".kodela.master-key": `${newKeyB64}\n`,
      [`.kodela.master-key-${oldKeyId}`]: `${oldKeyB64}\n`,
    },
    () => {
      // Legacy data still decrypts because the historical file is found.
      assert.equal(decryptField(envelope), "written under old key");
      // New writes use the new key.
      const fresh = encryptField("under new key");
      assert.ok(!fresh.includes(`:${oldKeyId}:`));
      assert.equal(decryptField(fresh), "under new key");
    },
  );
});

test("file loader: bad keyId in envelope can't path-traverse to /etc/passwd", () => {
  // Defence-in-depth: a malicious envelope claims keyId "../../../etc/passwd".
  // The historical-file lookup MUST reject this — otherwise readFile would
  // happily open /etc/passwd and the GCM tag check would mask the read.
  const key = randomBytes(32).toString("base64");
  withFileRepo({ ".kodela.master-key": `${key}\n` }, () => {
    const malicious = `kdl-aesgcm:v1:../../../etc/passwd:aaaa:bbbb:cccc`;
    assert.throws(
      () => decryptField(malicious),
      /no key configured for keyId=\.\.\/\.\.\/\.\.\/etc\/passwd/,
    );
  });
});
