// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ContextEntrySchema,
  IndexFileSchema,
  MappingFileSchema,
  BaselineFileSchema,
  SignOffRecordSchema,
  ContextCommentSchema,
  SCHEMA_VERSION,
  KodelaSessionSchema,
} from "../schema/index.js";
import type {
  ContextEntry,
  IndexFile,
  MappingFile,
  BaselineFile,
  SignOffRecord,
  ContextComment,
  KodelaSession,
  AggregatedRisk,
} from "../schema/index.js";
import { guardPath, hashFilePath, verifyNoSymlinkEscape } from "./path-guard.js";
import {
  SchemaVersionError,
  StorageCorruptionError,
} from "../errors.js";
import {
  encryptFieldsInPlace,
  decryptFieldsInPlace,
} from "../audit/encryption.js";
import { z } from "zod";

/**
 * Fields that carry user-content-derived sensitive data on a ContextEntry.
 * Per PRIVACY.md §3.1: `note` is the high-sensitivity field (= why_changed +
 * problem_solved + ai_reasoning).  These get AES-256-GCM-encrypted at rest
 * via the file or env-var-loaded master key (internal design note).
 *
 * Encryption is a NO-OP when no master key is configured (existing repos /
 * `kodela init --no-encryption` opt-out / dev mode) — the field stays
 * plaintext.  Symmetric decrypt-on-read handles both paths transparently.
 */
const ENCRYPTED_ENTRY_FIELDS = ["note"] as const;
import {
  validateRepoRoot,
  validateEntryId,
  validateFilePath,
} from "../validation.js";

export const KODELA_DIR = ".kodela" as const;

export type StorageConfig = {
  repoRoot: string;
};

function kodelaDirPath(repoRoot: string): string {
  return path.join(repoRoot, KODELA_DIR);
}

function objectsDir(repoRoot: string): string {
  return path.join(kodelaDirPath(repoRoot), "objects");
}

function mappingsDir(repoRoot: string): string {
  return path.join(kodelaDirPath(repoRoot), "mappings");
}

function indexFilePath(repoRoot: string): string {
  return path.join(kodelaDirPath(repoRoot), "index.json");
}

function baselineFilePath(repoRoot: string): string {
  return path.join(kodelaDirPath(repoRoot), "baseline.json");
}

function signOffsDir(repoRoot: string): string {
  return path.join(kodelaDirPath(repoRoot), "signoffs");
}

function signOffFilePath(repoRoot: string, entryId: string): string {
  const safeId = entryId.replace(/[^a-f0-9-]/gi, "");
  return path.join(signOffsDir(repoRoot), `${safeId}.json`);
}

/**
 * Gap 17 — Storage merge conflicts.
 *
 * Writes `index.json` with one UUID per line inside the `entries` array.
 * This makes the file friendly to Git's `merge=union` driver: concurrent
 * additions on different branches become separate appended lines that Git
 * can auto-resolve without a merge conflict.
 *
 * Format example:
 *   {
 *     "schemaVersion": "1.1.0",
 *     "entries": [
 *       "550e8400-e29b-41d4-a716-446655440001",
 *       "550e8400-e29b-41d4-a716-446655440002"
 *     ],
 *     "createdAt": "2024-01-01T00:00:00.000Z",
 *     "updatedAt": "2024-01-01T00:00:00.000Z"
 *   }
 *
 * JSON.stringify with indent=2 groups all UUIDs onto one nested block;
 * this custom formatter ensures every UUID is a separate line so that
 * `git merge` with the union driver can add/remove individual entries
 * without touching unrelated lines.
 */
export function formatIndexForMerge(index: IndexFile): string {
  const rows: string[] = [];
  rows.push("{");
  rows.push(`  "schemaVersion": ${JSON.stringify(index.schemaVersion)},`);
  rows.push(`  "entries": [`);
  for (let i = 0; i < index.entries.length; i++) {
    const comma = i < index.entries.length - 1 ? "," : "";
    rows.push(`    ${JSON.stringify(index.entries[i])}${comma}`);
  }
  rows.push(`  ],`);
  rows.push(`  "createdAt": ${JSON.stringify(index.createdAt)},`);
  rows.push(`  "updatedAt": ${JSON.stringify(index.updatedAt)}`);
  rows.push("}");
  return rows.join("\n") + "\n";
}

/**
 * Gap 17 — Write `.kodela/.gitattributes` with a `merge=union` strategy for
 * `index.json`.  The union driver takes lines from both sides of a conflict,
 * which is the correct semantic for an append-only list of UUIDs:
 * concurrent branch additions become two separate added lines that both
 * survive the merge.
 *
 * The file is created idempotently: if it already contains the rule it is
 * left unchanged; if it is absent or lacks the rule the rule is appended.
 */
export async function ensureGitAttributesUnion(repoRoot: string): Promise<void> {
  validateRepoRoot(repoRoot);
  const dir = kodelaDirPath(repoRoot);
  const attrPath = path.join(dir, ".gitattributes");

  await verifyNoSymlinkEscape(repoRoot, attrPath);

  const rule = "index.json merge=union";
  let existing = "";
  try {
    existing = await fs.readFile(attrPath, "utf-8");
  } catch {
    // file does not yet exist — will be created below
  }

  if (existing.split("\n").some((l) => l.trim() === rule)) {
    return; // already present
  }

  const header =
    "# Kodela index merge strategy\n" +
    "# One UUID per line makes concurrent branch additions auto-resolvable.\n" +
    "# The union merge driver takes lines from both sides of a conflict so\n" +
    "# that two developers adding annotations on separate branches both\n" +
    "# survive the merge without manual conflict resolution.\n";

  const content = existing
    ? `${existing.trimEnd()}\n\n${header}${rule}\n`
    : `${header}${rule}\n`;

  await atomicWrite(repoRoot, attrPath, content);
}

async function atomicWrite(
  repoRoot: string,
  filePath: string,
  content: string,
): Promise<void> {
  await verifyNoSymlinkEscape(repoRoot, filePath);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

function parseJsonFile<T>(
  filePath: string,
  schema: z.ZodSchema<T>,
  raw: string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StorageCorruptionError(filePath, err);
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "schemaVersion" in parsed
  ) {
    const sv = (parsed as Record<string, unknown>)["schemaVersion"];
    if (sv !== SCHEMA_VERSION) {
      // Migrate "1.0.0" files forward to "1.1.0".
      // The only schema change is the optional `origin` field on ContextEntry,
      // so bumping the version string is the only transformation needed.
      if (sv === "1.0.0") {
        (parsed as Record<string, unknown>)["schemaVersion"] = SCHEMA_VERSION;
      } else {
        throw new SchemaVersionError(sv, SCHEMA_VERSION);
      }
    }
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new StorageCorruptionError(filePath, result.error.message);
  }
  return result.data;
}

export async function ensureKodelaDir(repoRoot: string): Promise<void> {
  validateRepoRoot(repoRoot);
  const dir = kodelaDirPath(repoRoot);
  await fs.mkdir(path.join(dir, "objects"), { recursive: true });
  await fs.mkdir(path.join(dir, "mappings"), { recursive: true });
  await ensureGitAttributesUnion(repoRoot);
}

export async function readIndex(repoRoot: string): Promise<IndexFile> {
  validateRepoRoot(repoRoot);
  const filePath = indexFilePath(repoRoot);
  await verifyNoSymlinkEscape(repoRoot, filePath);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return {
      schemaVersion: SCHEMA_VERSION,
      entries: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return parseJsonFile(filePath, IndexFileSchema, raw);
}

export async function writeIndex(
  repoRoot: string,
  index: IndexFile,
): Promise<void> {
  validateRepoRoot(repoRoot);
  IndexFileSchema.parse(index);
  const filePath = indexFilePath(repoRoot);
  await atomicWrite(repoRoot, filePath, formatIndexForMerge(index));
}

export async function readContextEntry(
  repoRoot: string,
  id: string,
): Promise<ContextEntry> {
  validateRepoRoot(repoRoot);
  validateEntryId(id);
  const safeId = id.replace(/[^a-f0-9-]/gi, "");
  const filePath = guardPath(
    repoRoot,
    path.join(KODELA_DIR, "objects", `${safeId}.json`),
  );
  await verifyNoSymlinkEscape(repoRoot, filePath);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    throw new StorageCorruptionError(filePath, `Entry not found: ${id}`);
  }
  const entry = parseJsonFile(filePath, ContextEntrySchema, raw);
  // Decrypt sensitive fields on read.  Symmetric to writeContextEntry below;
  // entries written under a no-key configuration come back as plaintext.
  // The encryption module's `process.env.KODELA_REPO_ROOT ?? process.cwd()`
  // resolution finds the per-repo `.kodela.master-key` file even when this
  // function is called from a different working directory.
  const prevRoot = process.env.KODELA_REPO_ROOT;
  process.env.KODELA_REPO_ROOT = repoRoot;
  try {
    decryptFieldsInPlace(entry as unknown as Record<string, unknown>, ENCRYPTED_ENTRY_FIELDS);
  } finally {
    if (prevRoot === undefined) delete process.env.KODELA_REPO_ROOT;
    else process.env.KODELA_REPO_ROOT = prevRoot;
  }
  return entry;
}

export async function writeContextEntry(
  repoRoot: string,
  entry: ContextEntry,
): Promise<void> {
  validateRepoRoot(repoRoot);
  const validated = ContextEntrySchema.parse(entry);
  const safeId = validated.id.replace(/[^a-f0-9-]/gi, "");
  const filePath = guardPath(
    repoRoot,
    path.join(KODELA_DIR, "objects", `${safeId}.json`),
  );

  // Encrypt sensitive fields BEFORE serialising.  This wires E.7's
  // encryption infrastructure into the actual write path — pre-fix the
  // encryptFieldsInPlace helper existed but was never called from
  // production code, so every entry's `note` was written plaintext despite
  // `kodela doctor` reporting "Encryption-at-rest: Enabled."
  //
  // Mutate a clone so the caller's object isn't surprised by post-write
  // ciphertext where it had plaintext.  Idempotent — already-encrypted
  // values are detected via the envelope prefix and not double-wrapped.
  const cloned = JSON.parse(JSON.stringify(validated)) as Record<string, unknown>;
  const prevRoot = process.env.KODELA_REPO_ROOT;
  process.env.KODELA_REPO_ROOT = repoRoot;
  try {
    encryptFieldsInPlace(cloned, ENCRYPTED_ENTRY_FIELDS);
  } finally {
    if (prevRoot === undefined) delete process.env.KODELA_REPO_ROOT;
    else process.env.KODELA_REPO_ROOT = prevRoot;
  }
  await atomicWrite(repoRoot, filePath, JSON.stringify(cloned, null, 2));

  const index = await readIndex(repoRoot);
  if (!index.entries.includes(validated.id)) {
    index.entries.push(validated.id);
    index.updatedAt = new Date().toISOString();
    await writeIndex(repoRoot, index);
  }
}

export async function deleteContextEntry(
  repoRoot: string,
  id: string,
): Promise<void> {
  validateRepoRoot(repoRoot);
  validateEntryId(id);
  const safeId = id.replace(/[^a-f0-9-]/gi, "");
  const filePath = guardPath(
    repoRoot,
    path.join(KODELA_DIR, "objects", `${safeId}.json`),
  );
  try {
    await fs.unlink(filePath);
  } catch {
    // already deleted — idempotent
  }

  const index = await readIndex(repoRoot);
  const pos = index.entries.indexOf(id);
  if (pos !== -1) {
    index.entries.splice(pos, 1);
    index.updatedAt = new Date().toISOString();
    await writeIndex(repoRoot, index);
  }
}

export async function readMappingFile(
  repoRoot: string,
  filePath: string,
): Promise<MappingFile | null> {
  validateRepoRoot(repoRoot);
  validateFilePath(filePath);
  const fileHash = hashFilePath(filePath);
  const mappingPath = guardPath(
    repoRoot,
    path.join(KODELA_DIR, "mappings", `${fileHash}.json`),
  );
  await verifyNoSymlinkEscape(repoRoot, mappingPath);
  let raw: string;
  try {
    raw = await fs.readFile(mappingPath, "utf-8");
  } catch {
    return null;
  }
  return parseJsonFile(mappingPath, MappingFileSchema, raw);
}

export async function writeMappingFile(
  repoRoot: string,
  mapping: MappingFile,
): Promise<void> {
  validateRepoRoot(repoRoot);
  const validated = MappingFileSchema.parse(mapping);
  const mappingPath = guardPath(
    repoRoot,
    path.join(KODELA_DIR, "mappings", `${validated.filePathHash}.json`),
  );
  await atomicWrite(repoRoot, mappingPath, JSON.stringify(validated, null, 2));
}

export async function readBaseline(
  repoRoot: string,
): Promise<BaselineFile | null> {
  validateRepoRoot(repoRoot);
  const filePath = baselineFilePath(repoRoot);
  await verifyNoSymlinkEscape(repoRoot, filePath);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  return parseJsonFile(filePath, BaselineFileSchema, raw);
}

export async function writeBaseline(
  repoRoot: string,
  baseline: BaselineFile,
): Promise<void> {
  validateRepoRoot(repoRoot);
  const validated = BaselineFileSchema.parse(baseline);
  const filePath = baselineFilePath(repoRoot);
  await atomicWrite(repoRoot, filePath, JSON.stringify(validated, null, 2));
}

/**
 * Gap 45 — Read the sign-off record for a given entry, or null if none exists.
 * Stored at `.kodela/signoffs/<entryId>.json`.
 */
export async function readSignOff(
  repoRoot: string,
  entryId: string,
): Promise<SignOffRecord | null> {
  validateRepoRoot(repoRoot);
  validateEntryId(entryId);
  const filePath = signOffFilePath(repoRoot, entryId);
  await verifyNoSymlinkEscape(repoRoot, filePath);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StorageCorruptionError(filePath, err);
  }
  const result = SignOffRecordSchema.safeParse(parsed);
  if (!result.success) {
    throw new StorageCorruptionError(filePath, result.error.message);
  }
  return result.data;
}

/**
 * Gap 45 — Write a sign-off record to `.kodela/signoffs/<entryId>.json`.
 * Creates the `signoffs/` directory if it does not exist.
 * Uses an atomic write (tmp → rename) to prevent partial writes.
 */
export async function writeSignOff(
  repoRoot: string,
  record: SignOffRecord,
): Promise<void> {
  validateRepoRoot(repoRoot);
  const validated = SignOffRecordSchema.parse(record);
  const filePath = signOffFilePath(repoRoot, validated.entryId);
  await atomicWrite(repoRoot, filePath, JSON.stringify(validated, null, 2));
}

/**
 * Gap 44 — Annotation discussion threads.
 *
 * Comments are stored as an ordered array in `.kodela/comments/<entryId>.json`.
 * Each write uses an atomic tmp-rename to prevent partial writes.
 *
 * `readComments`   — returns the full thread (all or active-only).
 * `writeComment`   — appends a new ContextComment to the thread.
 * `resolveComment` — stamps `resolvedAt` on a specific comment by ID.
 * `deleteAllComments` — removes the entire thread file.
 */

const CommentsArraySchema = z.array(ContextCommentSchema);

function commentsDir(repoRoot: string): string {
  return path.join(kodelaDirPath(repoRoot), "comments");
}

function commentFilePath(repoRoot: string, entryId: string): string {
  const safeId = entryId.replace(/[^a-f0-9-]/gi, "");
  return path.join(commentsDir(repoRoot), `${safeId}.json`);
}

export async function readComments(
  repoRoot: string,
  entryId: string,
  opts: { includeResolved?: boolean } = {},
): Promise<ContextComment[]> {
  validateRepoRoot(repoRoot);
  validateEntryId(entryId);
  const filePath = commentFilePath(repoRoot, entryId);
  await verifyNoSymlinkEscape(repoRoot, filePath);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StorageCorruptionError(filePath, err);
  }
  const result = CommentsArraySchema.safeParse(parsed);
  if (!result.success) {
    throw new StorageCorruptionError(filePath, result.error.message);
  }
  const comments = result.data;
  return opts.includeResolved ? comments : comments.filter((c) => !c.resolvedAt);
}

export async function writeComment(
  repoRoot: string,
  comment: ContextComment,
): Promise<void> {
  validateRepoRoot(repoRoot);
  validateEntryId(comment.entryId);
  const validated = ContextCommentSchema.parse(comment);
  const filePath = commentFilePath(repoRoot, validated.entryId);
  await verifyNoSymlinkEscape(repoRoot, filePath);
  const existing = await readComments(repoRoot, validated.entryId, { includeResolved: true });
  const updated = [...existing, validated];
  await atomicWrite(repoRoot, filePath, JSON.stringify(updated, null, 2));
}

export async function resolveComment(
  repoRoot: string,
  entryId: string,
  commentId: string,
): Promise<boolean> {
  validateRepoRoot(repoRoot);
  validateEntryId(entryId);
  const existing = await readComments(repoRoot, entryId, { includeResolved: true });
  const idx = existing.findIndex((c) => c.id === commentId);
  if (idx === -1) return false;
  existing[idx] = { ...existing[idx], resolvedAt: new Date().toISOString() };
  const filePath = commentFilePath(repoRoot, entryId);
  await atomicWrite(repoRoot, filePath, JSON.stringify(existing, null, 2));
  return true;
}

export async function deleteAllComments(
  repoRoot: string,
  entryId: string,
): Promise<void> {
  validateRepoRoot(repoRoot);
  validateEntryId(entryId);
  const filePath = commentFilePath(repoRoot, entryId);
  await verifyNoSymlinkEscape(repoRoot, filePath);
  try {
    await fs.unlink(filePath);
  } catch {
    // no-op if the file does not exist
  }
}

// ---------------------------------------------------------------------------
// Gap 55 Phase A — Session-Based Change Grouping: file storage
// ---------------------------------------------------------------------------

function sessionsDir(repoRoot: string): string {
  return path.join(kodelaDirPath(repoRoot), "sessions");
}

function sessionFilePath(repoRoot: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId) throw new Error("Invalid session ID");
  return path.join(sessionsDir(repoRoot), `${safeId}.json`);
}

/**
 * Write a KodelaSession to `.kodela/sessions/<sessionId>.json`.
 * Creates the `sessions/` directory if it does not exist.
 * Uses an atomic write (tmp → rename) to prevent partial writes.
 */
export async function writeSession(
  repoRoot: string,
  session: KodelaSession,
): Promise<void> {
  validateRepoRoot(repoRoot);
  const validated = KodelaSessionSchema.parse(session);
  const filePath = sessionFilePath(repoRoot, validated.id);
  await verifyNoSymlinkEscape(repoRoot, filePath);
  await atomicWrite(repoRoot, filePath, JSON.stringify(validated, null, 2));
}

/**
 * Read a KodelaSession from `.kodela/sessions/<sessionId>.json`.
 * Returns null if the session file does not exist.
 * Throws StorageCorruptionError if the file exists but cannot be parsed.
 */
export async function readSession(
  repoRoot: string,
  sessionId: string,
): Promise<KodelaSession | null> {
  validateRepoRoot(repoRoot);
  const filePath = sessionFilePath(repoRoot, sessionId);
  await verifyNoSymlinkEscape(repoRoot, filePath);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StorageCorruptionError(filePath, err);
  }
  const result = KodelaSessionSchema.safeParse(parsed);
  if (!result.success) {
    throw new StorageCorruptionError(filePath, result.error.message);
  }
  return result.data;
}

/**
 * Append an entry UUID and its file path to an existing session.
 * If the session does not exist yet, creates it with default values
 * (aggregatedRisk: "low", startedAt: now).
 *
 * Both `entries[]` and `filesChanged[]` are deduped before writing.
 */
export async function appendEntryToSession(
  repoRoot: string,
  sessionId: string,
  entryId: string,
  filePath: string,
): Promise<void> {
  validateRepoRoot(repoRoot);
  const now = new Date().toISOString();
  const existing = await readSession(repoRoot, sessionId);
  const session: KodelaSession = existing ?? {
    id: sessionId,
    startedAt: now,
    entries: [],
    aggregatedRisk: "low",
    filesChanged: [],
  };

  if (!session.entries.includes(entryId)) {
    session.entries = [...session.entries, entryId];
  }
  if (filePath && !session.filesChanged.includes(filePath)) {
    session.filesChanged = [...session.filesChanged, filePath];
  }

  await writeSession(repoRoot, session);
}

/**
 * Mark a session as closed: stamp `endedAt` with the current time and
 * optionally override `aggregatedRisk`.
 *
 * Full risk computation (iterating all linked entries) is performed by
 * `SessionManager.closeSession()` (Gap 55 Phase B). This function is the
 * raw storage primitive that Phase B calls after computing the risk.
 *
 * Returns null and is a no-op if the session does not exist.
 */
export async function closeSession(
  repoRoot: string,
  sessionId: string,
  opts: { aggregatedRisk?: AggregatedRisk; goal?: string } = {},
): Promise<KodelaSession | null> {
  validateRepoRoot(repoRoot);
  const existing = await readSession(repoRoot, sessionId);
  if (!existing) return null;

  const updated: KodelaSession = {
    ...existing,
    endedAt: new Date().toISOString(),
    ...(opts.aggregatedRisk !== undefined
      ? { aggregatedRisk: opts.aggregatedRisk }
      : {}),
    ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
  };

  await writeSession(repoRoot, updated);
  return updated;
}

/**
 * List all sessions stored in `.kodela/sessions/`.
 * Returns an empty array if the directory does not exist.
 * Skips any file that fails Zod validation (logs nothing — use as a
 * best-effort list for CLI display).
 */
export async function listSessions(
  repoRoot: string,
): Promise<KodelaSession[]> {
  validateRepoRoot(repoRoot);
  const dir = sessionsDir(repoRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const sessions: KodelaSession[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(dir, name);
    await verifyNoSymlinkEscape(repoRoot, filePath);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = KodelaSessionSchema.safeParse(parsed);
    if (result.success) {
      sessions.push(result.data);
    }
  }
  return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export {
  kodelaDirPath,
  objectsDir,
  mappingsDir,
  indexFilePath,
  baselineFilePath,
  signOffsDir,
  commentsDir,
  sessionsDir,
};
