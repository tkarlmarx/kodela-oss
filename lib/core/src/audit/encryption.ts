// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Field-level encryption-at-rest — Phase 5.8.3 (doc 24 C1.1).
 *
 * AES-256-GCM authenticated encryption for sensitive ContextEntry fields.
 * Selected approach over SQLCipher / per-file encryption because:
 *
 *   - Keeps `.kodela/objects/*.json` valid JSON (only sensitive *fields* are
 *     ciphertext envelopes, structure is preserved). This means git diffs,
 *     grep, and the audit chain stay legible for non-sensitive metadata.
 *   - No external runtime dep — uses node:crypto stdlib.
 *   - Authenticated mode (GCM) means tampering produces a decrypt failure,
 *     not silently-wrong plaintext.
 *
 * Envelope format (versioned so we can rotate algorithms later):
 *
 *   kdl-aesgcm:v1:<keyId>:<base64url-iv>:<base64url-tag>:<base64url-ciphertext>
 *
 * Where:
 *   - `keyId` identifies which key in the keyring encrypted this field. Lets a
 *     deployment rotate keys: write with the new key, decrypt with the old key
 *     for legacy data, until a re-encrypt sweep finishes.
 *   - `iv` is a 96-bit random nonce (NIST recommendation for GCM).
 *   - `tag` is the 128-bit GCM authentication tag.
 *
 * Key sources (in priority order):
 *
 *   1. `KODELA_MASTER_KEY` env var — single key, base64-encoded 32 bytes.
 *      Used by SaaS-mode for KMS injection and by operators who need an
 *      explicit override.  The keyId is the first 8 hex chars of sha256(key)
 *      so a rotation can be detected without leaking the key.
 *   2. `<repoRoot>/.kodela.master-key` file — written by `kodela init` (doc 27
 *      §E.7).  This makes encryption-at-rest the default for any repo
 *      onboarded with `kodela init` instead of an opt-in env var.  The file
 *      lives at REPO_ROOT (not .kodela/) so it survives RTBF wipes and is
 *      trivially gitignored.
 *   3. `KODELA_MASTER_KEY_<keyId>` env vars — for rotation. Each provides
 *      one historical key the decrypt path can fall back to.
 *   4. `<repoRoot>/.kodela.master-key-<keyId>` files — same purpose as (3) but
 *      for file-based rotation.  `kodela rotate-key` writes these.
 *   5. No key configured → encryption is disabled (plain text mode). For
 *      existing repos and the `kodela init --no-encryption` opt-out path.
 *
 * For SOC 2 C1.1 evidence: a deployment that sets `KODELA_MASTER_KEY` (SaaS)
 * or runs `kodela init` (local) has authenticated encryption-at-rest for
 * every sensitive field; verifyChain + field-level GCM tags together cover
 * both integrity and confidentiality.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ALGO = "aes-256-gcm" as const;
const ENVELOPE_PREFIX = "kdl-aesgcm:v1:" as const;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ENV_VAR_DEFAULT = "KODELA_MASTER_KEY";
const ENV_VAR_PREFIX = "KODELA_MASTER_KEY_";

/**
 * Phase 5.10 (doc 27 §E.7) — file-based key location.
 *
 * `kodela init` writes a per-repo master key to `<repoRoot>/.kodela.master-key`
 * (at REPO_ROOT, not inside .kodela/, so the key survives an RTBF wipe and is
 * trivially gitignored).  Historical keys (after rotation) land at
 * `<repoRoot>/.kodela.master-key-<keyId>` so old data still decrypts.
 *
 * The lookup precedence (highest priority first) is:
 *   1. `_setKeyringForTests` override (tests)
 *   2. `KODELA_MASTER_KEY` env var (explicit override; for SaaS-mode KMS injection)
 *   3. `<repoRoot>/.kodela.master-key` file (default for repos run through `kodela init`)
 *   4. None → plaintext mode (existing repos, opted-out customers)
 *
 * The repo root resolves from `process.env.KODELA_REPO_ROOT ?? process.cwd()`.
 */
const KEY_FILE_NAME = ".kodela.master-key";
const KEY_FILE_PREFIX = ".kodela.master-key-";

// ── Key resolution ──────────────────────────────────────────────────────────

interface KeyMaterial {
  keyId: string;
  key: Buffer;
}

/**
 * Test-only override.  When set, key resolution consults this map FIRST.
 * Production code never sets it; the variable stays empty and the
 * env-var lookup runs untouched.
 */
const testKeyringOverride = new Map<string, Buffer>();

/** Test-only — install a keyring, optionally including the default current key. */
export function _setKeyringForTests(
  keys: Array<{ keyId: string; key: Buffer; isCurrent?: boolean }>,
): void {
  testKeyringOverride.clear();
  let currentKeyId: string | null = null;
  for (const k of keys) {
    testKeyringOverride.set(k.keyId, k.key);
    if (k.isCurrent) currentKeyId = k.keyId;
  }
  // Use a special marker key "__current__" so the resolver knows which is
  // active for new writes.
  if (currentKeyId !== null) {
    testKeyringOverride.set("__current__", Buffer.from(currentKeyId, "utf8"));
  }
}

/** Test-only — clear all overrides. */
export function _clearKeyringForTests(): void {
  testKeyringOverride.clear();
}

function deriveKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function parseKey(raw: string): Buffer | null {
  // Accept base64 (standard or url-safe) for the 32-byte master key.
  try {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === KEY_BYTES) return buf;
  } catch {
    /* fall through */
  }
  try {
    const buf = Buffer.from(raw, "base64url");
    if (buf.length === KEY_BYTES) return buf;
  } catch {
    /* fall through */
  }
  return null;
}

/** Repo root used by the file-based key loader. Env override wins for tests + SaaS. */
function resolveRepoRoot(): string {
  return process.env.KODELA_REPO_ROOT ?? process.cwd();
}

/** Read & parse the current-key file `<repoRoot>/.kodela.master-key`. */
function readKeyFromFile(repoRoot: string): Buffer | null {
  const path = join(repoRoot, KEY_FILE_NAME);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length === 0) return null;
    return parseKey(raw);
  } catch {
    return null;
  }
}

/** Read & parse a historical-key file `<repoRoot>/.kodela.master-key-<keyId>`. */
function readHistoricalKeyFromFile(repoRoot: string, keyId: string): Buffer | null {
  // Defence-in-depth: keyId comes from the envelope (user-controlled), so reject
  // anything that isn't hex/alphanum to keep this off the join() path.
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(keyId)) return null;
  const path = join(repoRoot, `${KEY_FILE_PREFIX}${keyId}`);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length === 0) return null;
    return parseKey(raw);
  } catch {
    return null;
  }
}

/** Resolve the *current* (write) key. Returns null when no key is configured. */
export function getCurrentKey(): KeyMaterial | null {
  if (testKeyringOverride.size > 0) {
    const currentMarker = testKeyringOverride.get("__current__");
    if (currentMarker) {
      const keyId = currentMarker.toString("utf8");
      const key = testKeyringOverride.get(keyId);
      if (key) return { keyId, key };
    }
  }
  // Priority 1 — env var override (SaaS-mode KMS injection, explicit operator override).
  const raw = process.env[ENV_VAR_DEFAULT];
  if (raw && raw.trim().length > 0) {
    const key = parseKey(raw.trim());
    if (key) return { keyId: deriveKeyId(key), key };
  }
  // Priority 2 — per-repo key file (`kodela init` default; doc 27 §E.7).
  const fileKey = readKeyFromFile(resolveRepoRoot());
  if (fileKey) return { keyId: deriveKeyId(fileKey), key: fileKey };
  // Priority 3 — no key configured. Encryption is a no-op (existing repos /
  // explicit opt-out via `kodela init --no-encryption`).
  return null;
}

/** Look up a key by its keyId (write-time fingerprint). For decrypt. */
function findKeyById(keyId: string): Buffer | null {
  if (testKeyringOverride.has(keyId)) {
    const key = testKeyringOverride.get(keyId);
    if (key) return key;
  }
  // Current key (env-var or file-based) — if its fingerprint matches, use it.
  const current = getCurrentKey();
  if (current && current.keyId === keyId) return current.key;
  // Historical env var (KODELA_MASTER_KEY_<keyId>) — pre-file rotation convention.
  const raw = process.env[`${ENV_VAR_PREFIX}${keyId}`];
  if (raw && raw.trim().length > 0) {
    const parsed = parseKey(raw.trim());
    if (parsed) return parsed;
  }
  // Historical file (<repoRoot>/.kodela.master-key-<keyId>) — file-based rotation.
  const fileKey = readHistoricalKeyFromFile(resolveRepoRoot(), keyId);
  if (fileKey) return fileKey;
  return null;
}

// ── Envelope I/O ────────────────────────────────────────────────────────────

/** True when `value` looks like a kdl-aesgcm:v1: envelope. Pure string check. */
export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

/** True when encryption is configured (current key resolves). */
export function isEncryptionEnabled(): boolean {
  return getCurrentKey() !== null;
}

/**
 * Encrypt a UTF-8 string and return the envelope.  When no key is configured,
 * returns the plaintext UNCHANGED — encryption is opt-in via env var so
 * local-dev and existing repos see no behaviour change.
 */
export function encryptField(plaintext: string): string {
  const current = getCurrentKey();
  if (!current) return plaintext;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, current.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_PREFIX,
    current.keyId,
    ":",
    iv.toString("base64url"),
    ":",
    tag.toString("base64url"),
    ":",
    ciphertext.toString("base64url"),
  ].join("");
}

/**
 * Decrypt a kdl-aesgcm:v1: envelope or pass through plain text. Throws when
 * the value looks encrypted but no matching key is configured, the envelope
 * is malformed, or the authentication tag fails.  Throws — does not silently
 * return ciphertext — because surface-level read paths should fail fast on
 * trust-boundary violations.
 */
export function decryptField(value: string): string {
  if (!isEncrypted(value)) return value;
  const body = value.slice(ENVELOPE_PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 4) {
    throw new Error("decryptField: malformed envelope (wrong segment count)");
  }
  const [keyId, ivB64, tagB64, ctB64] = parts;
  if (!keyId || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("decryptField: malformed envelope (empty segment)");
  }
  const key = findKeyById(keyId);
  if (!key) {
    throw new Error(`decryptField: no key configured for keyId=${keyId} (set KODELA_MASTER_KEY_${keyId})`);
  }
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ciphertext = Buffer.from(ctB64, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("decryptField: malformed envelope (iv/tag size mismatch)");
  }
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // GCM tag verification failure — DO NOT leak which step failed.
    throw new Error("decryptField: authentication tag mismatch (tampered or wrong key)");
  }
}

/**
 * Apply encryptField to every property named in `fields` that is currently
 * a non-empty string and NOT already encrypted (idempotent — double-encrypt is
 * a bug, so the no-op on already-encrypted is the safe default).
 *
 * Used by capture call sites to encrypt a known sensitive subset of a
 * ContextEntry payload in one pass.
 */
export function encryptFieldsInPlace<T extends Record<string, unknown>>(
  payload: T,
  fields: ReadonlyArray<keyof T>,
): T {
  if (!isEncryptionEnabled()) return payload;
  for (const f of fields) {
    const v = payload[f];
    if (typeof v !== "string" || v.length === 0) continue;
    if (isEncrypted(v)) continue; // already encrypted — don't double-wrap
    (payload as Record<string, unknown>)[f as string] = encryptField(v);
  }
  return payload;
}

/** Mirror of encryptFieldsInPlace for the read path. */
export function decryptFieldsInPlace<T extends Record<string, unknown>>(
  payload: T,
  fields: ReadonlyArray<keyof T>,
): T {
  for (const f of fields) {
    const v = payload[f];
    if (typeof v !== "string") continue;
    if (!isEncrypted(v)) continue;
    (payload as Record<string, unknown>)[f as string] = decryptField(v);
  }
  return payload;
}

/**
 * Constant-time string-equality helper used by tests verifying that
 * isEncryptionEnabled returns the same result deterministically across calls.
 * Exposed because Node's `===` on user-controlled strings is timing-leaky in
 * a security-sensitive comparison.
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
