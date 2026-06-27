// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  writeContextEntry,
  hashTokenStream,
  buildAstAnchor,
  loadLicense,
  SCHEMA_VERSION,
  resolveToolNameAttribution,
  detectCursorFromEnv,
  extractFingerprint,
  classifyScope,
  enrichEntry,
} from "@kodela/core";
import type { ContextEntry, Severity, Origin, ExternalRef } from "@kodela/core";
import { parseExternalRef, fetchExternalRefTitle } from "../integrations/index.js";
import type { PromptInterface } from "../utils/prompt.js";
import { promptRequired, promptOptional } from "../utils/prompt.js";
import { isSensitivePath, matchingSensitivePaths } from "../security/sensitive-paths.js";
import { recordCliEvent } from "../audit/recordCliEvent.js";

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

/**
 * FNV-1a 32-bit hash — fast, non-cryptographic.
 * Used for promptHash when hash_algorithm === "fnv1a".
 */
function fnv1a32(text: string): string {
  let hash = 2166136261;
  const bytes = Buffer.from(text, "utf-8");
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function computePromptHash(promptText: string, algorithm: "sha256" | "fnv1a"): string {
  if (algorithm === "fnv1a") {
    return fnv1a32(promptText);
  }
  return crypto.createHash("sha256").update(promptText, "utf-8").digest("hex");
}

export type AddOptions = {
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  note?: string;
  severity?: ContextEntry["severity"];
  source?: ContextEntry["source"];
  aiTool?: string;
  /**
   * Gap 14: URL to the AI chat session that produced the annotated code.
   * Stored as `entry.link` so the VS Code hover can surface a clickable deep-link.
   */
  link?: string;
  tags?: string[];
  repoRoot: string;
  sensitivePaths?: string[];
  /**
   * Gap 13 — Prompt Lineage / AI Decision Origin capture.
   * These fields populate the `origin` block on the stored ContextEntry.
   */
  originSummary?: string;
  originModel?: string;
  originSessionId?: string;
  /**
   * Path to a file containing the AI prompt text (relative to repoRoot).
   * Its content is hashed and stored as `origin.promptHash`.
   * The full text is only stored in `origin.prompt` when capturePromptFull is true.
   */
  originPromptFile?: string;
  /**
   * Ordered list of reasoning steps / alternatives considered.
   * Stored in `origin.reasoning` (suppressed when captureReasoning is false).
   */
  originReasoning?: string[];
  /** When true, store the full prompt text in origin.prompt. Defaults to false. */
  capturePromptFull?: boolean;
  /** Hash algorithm for promptHash. Defaults to "sha256". */
  hashAlgorithm?: "sha256" | "fnv1a";
  /** When false, reasoning is suppressed even if provided. Defaults to true. */
  captureReasoning?: boolean;
  /**
   * Gap 50 — URL to an external issue/document that drove the code decision.
   * Parsed into an ExternalRef and stored on the entry.  The title is fetched
   * from the provider API when the relevant KODELA_*_API_KEY env var is set.
   */
  ref?: string;
};

export type AddResult = {
  entry: ContextEntry;
  securityFlagged: boolean;
};

export async function runAdd(
  opts: AddOptions,
  promptIface?: PromptInterface,
): Promise<AddResult> {
  const { repoRoot, sensitivePaths = [] } = opts;
  let { filePath, lineStart, lineEnd, note, severity, source, tags } = opts;

  // --- AI tool attribution resolution ---
  // If --ai-tool is provided, resolve the canonical link (unless --link
  // was explicitly supplied, which always takes priority).
  // If neither flag is provided, fall back to environment heuristics
  // (e.g. Cursor IDE detected via CURSOR_TRACE_ID / CURSOR_SESSION_ID).
  let aiTool = opts.aiTool;
  let link = opts.link;

  if (aiTool) {
    const resolved = resolveToolNameAttribution(aiTool);
    if (resolved) {
      aiTool = resolved.aiTool;
      if (!link && resolved.link) {
        link = resolved.link;
      }
    }
  } else {
    const cursorAttr = detectCursorFromEnv();
    if (cursorAttr) {
      aiTool = cursorAttr.aiTool;
      if (!link) {
        link = cursorAttr.link;
      }
    }
  }

  if (promptIface) {
    if (!filePath) {
      filePath = await promptRequired(promptIface, "File path (relative to repo root)");
    }
    if (lineStart === undefined) {
      const raw = await promptOptional(promptIface, "Start line", "1");
      lineStart = parseInt(raw, 10);
    }
    if (lineEnd === undefined) {
      const raw = await promptOptional(promptIface, "End line", String(lineStart ?? 1));
      lineEnd = parseInt(raw, 10);
    }
    if (!note) {
      note = await promptRequired(promptIface, "Context note");
    }
    if (!severity) {
      const raw = await promptOptional(promptIface, "Severity (low/medium/high/critical)", "low");
      severity = raw as ContextEntry["severity"];
    }
    if (!source) {
      const raw = await promptOptional(promptIface, "Source (human/ai/import)", "human");
      source = raw as ContextEntry["source"];
    }
  }

  if (!filePath) throw new Error("filePath is required");
  if (lineStart === undefined) throw new Error("lineStart is required");
  if (lineEnd === undefined) lineEnd = lineStart;
  if (!note) throw new Error("note is required");

  if (lineStart < 1) throw new Error("lineStart must be >= 1");
  if (lineEnd < lineStart) throw new Error("lineEnd must be >= lineStart");

  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const absoluteFilePath = path.resolve(repoRoot, normalizedPath);

  let contentHash: string;
  let astAnchor: ContextEntry["astAnchor"] = null;
  let contentFingerprint: string[] | undefined;
  try {
    const content = await fs.readFile(absoluteFilePath, "utf-8");
    const lines = content.split("\n");
    const slice = lines.slice(lineStart - 1, lineEnd).join("\n");
    contentHash = hashTokenStream(slice);
    // Gap 42 — populate the AST anchor (including symbolId) so the heal engine
    // can use symbol-level re-attachment on future rewrites.
    astAnchor = buildAstAnchor(normalizedPath, { start: lineStart, end: lineEnd }, content);
    // Gap 48 — store a lightweight identifier fingerprint for drift detection.
    contentFingerprint = extractFingerprint(slice);
  } catch {
    contentHash = "0".repeat(64);
  }

  const resolvedSource: ContextEntry["source"] = source ?? "human";

  const isSensitiveFile =
    sensitivePaths.length > 0 && isSensitivePath(normalizedPath, sensitivePaths);

  const securityFlagged = isSensitiveFile;

  const matchedPaths = isSensitiveFile
    ? matchingSensitivePaths(normalizedPath, sensitivePaths)
    : [];

  const baseTags: string[] = tags ?? [];
  const allTags = isSensitiveFile
    ? [...new Set([...baseTags, "security-sensitive"])]
    : baseTags;

  const baseSeverity: Severity = severity ?? "low";
  const resolvedSeverity: Severity = isSensitiveFile
    ? maxSeverity(baseSeverity, "high")
    : baseSeverity;

  // --- Gap 13: Build origin block ---
  let origin: Origin | undefined;
  const hasOriginInput =
    opts.originSummary ||
    opts.originPromptFile ||
    opts.originModel ||
    opts.originSessionId ||
    (opts.originReasoning && opts.originReasoning.length > 0);

  if (hasOriginInput || resolvedSource === "ai") {
    const algorithm = opts.hashAlgorithm ?? "sha256";
    const captureReasoning = opts.captureReasoning !== false;
    let promptHash: string | undefined;
    let promptFull: string | undefined;

    if (opts.originPromptFile) {
      try {
        const promptText = await fs.readFile(
          path.resolve(repoRoot, opts.originPromptFile),
          "utf-8",
        );
        promptHash = computePromptHash(promptText, algorithm);
        if (opts.capturePromptFull) {
          promptFull = promptText;
        }
      } catch {
        // best-effort — prompt file may not exist yet
      }
    }

    origin = {
      // "unknown" is a classification-level value not present in OriginSchema.
      // When source is uncertain, the origin block still records the tool context
      // as "ai" (something AI-adjacent was detected; we just cannot be sure).
      type: resolvedSource === "unknown" ? "ai" : resolvedSource,
      ...(opts.originSummary ? { summary: opts.originSummary } : {}),
      ...(promptHash ? { promptHash } : {}),
      ...(promptFull ? { prompt: promptFull } : {}),
      ...(captureReasoning && opts.originReasoning?.length
        ? { reasoning: opts.originReasoning }
        : {}),
      ...(aiTool ? { tool: aiTool } : {}),
      ...(opts.originModel ? { model: opts.originModel } : {}),
      ...(opts.originSessionId ? { sessionId: opts.originSessionId } : {}),
    };
  }

  // --- Gap 50: resolve externalRef ---
  let externalRef: ExternalRef | undefined;
  if (opts.ref) {
    try {
      externalRef = parseExternalRef(opts.ref);
      const title = await fetchExternalRefTitle(externalRef);
      if (title) externalRef.title = title;
    } catch {
      // invalid URL — skip silently, the note is still stored
    }
  }

  const actor = process.env["KODELA_AUTHOR"] ?? process.env["GIT_AUTHOR_NAME"] ?? "unknown";
  const now = new Date().toISOString();
  const symbolName =
    astAnchor && "name" in astAnchor && astAnchor !== null
      ? (astAnchor as { name: string }).name
      : undefined;
  const entryScope = classifyScope(normalizedPath, symbolName, note);

  const addPartial: ContextEntry = {
    schemaVersion: SCHEMA_VERSION,
    id: crypto.randomUUID(),
    filePath: normalizedPath,
    astAnchor,
    contentHash,
    lineRange: { start: lineStart, end: lineEnd },
    note,
    author: actor,
    createdAt: now,
    updatedAt: now,
    severity: resolvedSeverity,
    tags: allTags,
    source: resolvedSource,
    ...(aiTool ? { aiTool } : {}),
    ...(link ? { link } : {}),
    confidence: 1.0,
    status: "mapped",
    reviewRequired: resolvedSource === "ai" || securityFlagged,
    ...(contentFingerprint ? { contentFingerprint } : {}),
    ...(externalRef ? { externalRef } : {}),
    ...(origin ? { origin } : {}),
    scope: entryScope,
  };

  // Gap 101/102/103 — enrich with ingestion provenance, summary, rawContext.
  // contentFingerprint is already set above so enrichEntry will preserve it.
  const linesInRange = lineEnd - lineStart + 1;
  const entry = enrichEntry(addPartial, {
    sourceType: "manual",
    isExplicitAgent: true,
    trustLevel: "high",
    linesAdded: linesInRange,
    linesRemoved: 0,
    fileCount: 1,
    aiProposalNote: opts.originSummary,
  });

  await writeContextEntry(repoRoot, entry);

  const license = await loadLicense(repoRoot);
  const orgId = license?.orgId;
  if (orgId) {
    void recordCliEvent(
      {
        eventType: "context_added",
        actor,
        orgId,
        filePath: normalizedPath,
        entryId: entry.id,
        metadata: { source: resolvedSource, severity: resolvedSeverity },
      },
      repoRoot,
    );
  }

  if (securityFlagged) {
    process.stderr.write(
      `⚠ Security-sensitive path detected (${matchedPaths.join(", ")}). ` +
        `Entry flagged with review_required: true, tagged "security-sensitive", and severity elevated to "${resolvedSeverity}".\n`,
    );
  }

  return { entry, securityFlagged };
}
