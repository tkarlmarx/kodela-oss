// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela rotate-key` — rotate the per-repo master key (internal design note).
 *
 * Reads the current `<repoRoot>/.kodela.master-key`, derives its keyId (the
 * same 8-hex-char sha256 prefix used by `lib/core/src/audit/encryption.ts`),
 * moves it to `<repoRoot>/.kodela.master-key-<keyId>` as a historical file,
 * then generates a fresh 32-byte random key and writes it as the new current
 * key.  After rotation:
 *
 *   - New encrypt writes use the fresh key (envelope `:newKeyId:`)
 *   - Old envelopes still decrypt because the historical file holds the old key
 *     (see encryption.ts's findKeyById → readHistoricalKeyFromFile path)
 *
 * The historical file path is already gitignored by `kodela init` (the
 * `.kodela.master-key-*` glob was appended at init-time).
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileExists } from "../utils/repo.js";

export type RotateKeyOptions = {
  repoRoot: string;
};

export type RotateKeyResult = {
  repoRoot: string;
  oldKeyId: string;
  newKeyId: string;
  historicalKeyPath: string;
  currentKeyPath: string;
};

const KEY_FILE_NAME = ".kodela.master-key";
const KEY_FILE_PREFIX = ".kodela.master-key-";
const KEY_BYTES = 32;

export class RotateKeyError extends Error {
  constructor(message: string, public readonly remediation?: string) {
    super(message);
    this.name = "RotateKeyError";
  }
}

/**
 * Same algorithm as encryption.ts deriveKeyId — first 8 hex chars of sha256(key).
 * Duplicated here (vs imported) because the CLI deliberately doesn't depend on
 * the encryption module's private internals; the keyId derivation rule is
 * load-bearing on the envelope format and is documented as part of encryption.ts.
 */
function deriveKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function parseKey(raw: string): Buffer | null {
  // Accept base64 (standard or url-safe). Same tolerance as encryption.ts.
  const trimmed = raw.trim();
  try {
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length === KEY_BYTES) return buf;
  } catch {
    /* fall through */
  }
  try {
    const buf = Buffer.from(trimmed, "base64url");
    if (buf.length === KEY_BYTES) return buf;
  } catch {
    /* fall through */
  }
  return null;
}

export async function runRotateKey(opts: RotateKeyOptions): Promise<RotateKeyResult> {
  const { repoRoot } = opts;
  const currentKeyPath = path.join(repoRoot, KEY_FILE_NAME);

  if (!(await fileExists(currentKeyPath))) {
    throw new RotateKeyError(
      `No master key found at ${currentKeyPath}`,
      "→ run `kodela init` to generate a key, or set KODELA_MASTER_KEY for env-var mode",
    );
  }

  const oldRaw = await readFile(currentKeyPath, "utf8");
  const oldKey = parseKey(oldRaw);
  if (!oldKey) {
    throw new RotateKeyError(
      `Existing key at ${currentKeyPath} is not a valid 32-byte base64-encoded key`,
      "→ inspect the file; if it's corrupted, restore from your secret store before rotating",
    );
  }

  const oldKeyId = deriveKeyId(oldKey);
  const historicalKeyPath = path.join(repoRoot, `${KEY_FILE_PREFIX}${oldKeyId}`);

  if (await fileExists(historicalKeyPath)) {
    // Refusing to overwrite is the safer default — silently clobbering a
    // historical key would make previously-encrypted envelopes unreadable.
    throw new RotateKeyError(
      `Historical key already exists at ${historicalKeyPath}`,
      "→ this means the current key was previously rotated to and back; remove the old historical file manually after confirming nothing references it",
    );
  }

  // Move the current key to the historical slot via rename — atomic on POSIX
  // and means we never have a brief window where the current key file is
  // missing entirely.
  await rename(currentKeyPath, historicalKeyPath);
  try {
    await chmod(historicalKeyPath, 0o600);
  } catch {
    // Non-fatal on platforms without full POSIX mode support.
  }

  // Generate and write the new current key.
  const newKey = randomBytes(KEY_BYTES);
  const newKeyId = deriveKeyId(newKey);
  await writeFile(currentKeyPath, `${newKey.toString("base64")}\n`, { mode: 0o600 });
  try {
    await chmod(currentKeyPath, 0o600);
  } catch {
    /* non-fatal */
  }

  return {
    repoRoot,
    oldKeyId,
    newKeyId,
    historicalKeyPath,
    currentKeyPath,
  };
}

export function formatRotateKeyResult(result: RotateKeyResult): string {
  return [
    `✓ Master key rotated.`,
    ``,
    `  Old keyId: ${result.oldKeyId}`,
    `  New keyId: ${result.newKeyId}`,
    ``,
    `  Historical key preserved at ${result.historicalKeyPath}`,
    `  New current key written to ${result.currentKeyPath}`,
    ``,
    `  ℹ  Existing encrypted entries continue to decrypt via the historical key.`,
    `  ℹ  New entries from this point will use the new key.`,
    `  ⚠  Back up ${result.historicalKeyPath} alongside ${result.currentKeyPath} — losing the historical key makes pre-rotation entries unreadable.`,
  ].join("\n");
}

export function handleRotateKeyError(err: unknown): never {
  if (err instanceof RotateKeyError) {
    process.stderr.write(`Error: ${err.message}\n`);
    if (err.remediation) process.stderr.write(`${err.remediation}\n`);
    process.exit(1);
  }
  throw err;
}
