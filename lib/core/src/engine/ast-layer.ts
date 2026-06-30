// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { createHash } from "node:crypto";
import { MappingLayerError } from "../errors.js";
import { classifyConfidence, type MappingResult } from "./confidence.js";
import { ContextEntrySchema } from "../schema/index.js";
import type { ContextEntry, AstAnchor, MappingStatus } from "../schema/index.js";
import { validateFileContent, validateFilePath } from "../validation.js";
import { parseFunctions, languageForFile } from "../code-graph/treesitter-layer.js";
import type { CodeGraphFunction } from "../code-graph/types.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type FileContent = {
  lines: string[];
  raw: string;
};

type AstNode = {
  kind: "function" | "method" | "class" | "block";
  name: string;
  startLine: number;
  endLine: number;
  /** Normalised body content (everything after the signature line). */
  bodyLines: string[];
  /** Number of formal parameters parsed from the signature line. */
  paramCount: number;
};

// ---------------------------------------------------------------------------
// Regex patterns for supported languages / constructs
// ---------------------------------------------------------------------------

const FUNCTION_PATTERNS: Array<{
  kind: AstNode["kind"];
  pattern: RegExp;
}> = [
  {
    kind: "function",
    pattern:
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
  },
  {
    kind: "method",
    pattern:
      /^\s+(?:(?:public|private|protected|static|async|override)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(/,
  },
  {
    kind: "class",
    pattern: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
  },
  {
    kind: "function",
    pattern:
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*\S+\s*)?=\s*(?:async\s+)?\(/,
  },
  {
    kind: "function",
    pattern:
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*\S+\s*)?=\s*(?:async\s+)?(?:\w+|\([^)]*\))\s*=>/,
  },
];

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Strip comments, collapse whitespace, and lower-case a code block for
 * content-hash comparisons that survive reformatting.
 */
function normaliseBody(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/#[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Count the number of formal parameters in a signature line by counting
 * top-level commas inside the outermost `(…)` pair.
 */
function countParams(signatureLine: string): number {
  const open = signatureLine.indexOf("(");
  if (open === -1) return 0;

  let depth = 0;
  let commas = 0;
  let hasContent = false;

  for (let i = open; i < signatureLine.length; i++) {
    const ch = signatureLine[i];
    if (ch === "(" || ch === "<" || ch === "[" || ch === "{") {
      depth++;
      if (depth === 1) continue;
    }
    if (ch === ")" || ch === ">" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) break;
    }
    if (depth === 1 && ch !== "(" && ch !== " " && ch !== "\t") {
      hasContent = true;
    }
    if (depth === 1 && ch === ",") {
      commas++;
    }
  }

  if (!hasContent) return 0;
  return commas + 1;
}

// ---------------------------------------------------------------------------
// Core: AST node extraction
// ---------------------------------------------------------------------------

/**
 * Sprint 2 / [E.6] — Tree-sitter-backed AstNode extraction.
 *
 * Calls `parseFunctions` (tree-sitter) for languages that have a wasm grammar
 * available (TS/TSX/Python/Go/Rust/Java/Bash) and re-shapes the result into the
 * AstNode contract this layer uses for matching. Returns `null` when the file's
 * language isn't supported OR the grammar/wasm wasn't installed — the async
 * `mapWithAstLayerAsync` treats `null` as "use the regex extractor instead".
 *
 * Why a fresh extractor rather than a swap: the matching tiers in
 * `findBestMatchingNode` need `bodyLines` (for body-hash) and `paramCount`
 * (tiebreaker) which tree-sitter doesn't surface directly. We derive both from
 * the raw line array using the same convention `extractAstNodes` uses, so a
 * regex-extracted vs tree-sitter-extracted node hash identically for the same
 * source.
 */
async function extractAstNodesViaTreeSitter(
  filePath: string,
  content: FileContent,
): Promise<AstNode[] | null> {
  if (languageForFile(filePath) === null) return null;

  let fns: CodeGraphFunction[];
  try {
    fns = await parseFunctions(filePath, content.raw);
  } catch {
    return null;
  }

  // Empty result from parseFunctions is genuinely ambiguous (grammar load
  // failure vs. real "no functions"). Treat both as "fall back to regex" —
  // the regex extractor is the safety net.
  if (fns.length === 0) return null;

  const { lines } = content;
  const nodes: AstNode[] = [];
  for (const fn of fns) {
    const kind: AstNode["kind"] =
      fn.kind === "class"
        ? "class"
        : fn.kind === "method"
          ? "method"
          : "function";

    // bodyLines mirrors the regex extractor's convention: everything AFTER
    // the signature line through the closing brace. lines is 0-indexed,
    // startLine/endLine are 1-indexed, so:
    //   signature lives at lines[startLine - 1]
    //   body spans     lines[startLine .. endLine - 1] inclusive
    //                = lines.slice(startLine, endLine) in zero-indexed array math
    // The minimum slice is empty (single-line function); paramCount falls back
    // to 0 in that case via `countParams`.
    const signatureLine = lines[fn.startLine - 1] ?? "";
    const bodyLines = lines.slice(fn.startLine, fn.endLine);
    const paramCount = countParams(signatureLine);

    nodes.push({
      kind,
      name: fn.name,
      startLine: fn.startLine,
      endLine: fn.endLine,
      bodyLines,
      paramCount,
    });
  }
  return nodes;
}

function extractAstNodes(content: FileContent): AstNode[] {
  const nodes: AstNode[] = [];
  const { lines } = content;

  // Track brace depth cumulatively so we can find where each node ends.
  const braceDepths: number[] = new Array<number>(lines.length).fill(0);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    braceDepths[i] = depth;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();

    for (const { kind, pattern } of FUNCTION_PATTERNS) {
      const match = pattern.exec(line);
      if (match !== null && match[1] !== undefined) {
        const name = match[1]!;
        const startDepth = braceDepths[i] ?? 0;

        // Walk forward to find the matching closing brace.
        let endLine = i;
        for (let j = i + 1; j < lines.length; j++) {
          if ((braceDepths[j] ?? 0) <= startDepth) {
            endLine = j;
            break;
          }
          endLine = j;
        }

        // Collect body lines (everything after the signature line).
        const bodyLines = lines.slice(i + 1, endLine + 1);
        const paramCount = countParams(line);

        nodes.push({
          kind,
          name,
          startLine: i + 1,
          endLine: endLine + 1,
          bodyLines,
          paramCount,
        });
        break;
      }
    }
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

export function hashAstSignature(kind: string, name: string): string {
  return createHash("sha256")
    .update(`${kind}:${name}`)
    .digest("hex");
}

/**
 * Compute a normalised body hash from an array of source lines.
 * The body is stripped of comments and whitespace so minor reformatting
 * does not change the hash.
 */
export function computeBodyHash(bodyLines: string[]): string {
  return createHash("sha256")
    .update(normaliseBody(bodyLines))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const CONFIDENCE_BLOCK_HASH = 0.95;
const CONFIDENCE_SYMBOL_ID = 0.90;
const CONFIDENCE_NAME_MATCH = 0.87;
const CONFIDENCE_BODY_HASH = 0.78;

/**
 * Gap 42 — Tier tag carried alongside a match result so the caller can
 * distinguish exact-hash matches from symbol-name and body-hash matches.
 * Used to populate `MappingResult.layerHint`.
 */
type MatchTier = "blockHash" | "symbolId" | "name" | "bodyHash";

type MatchResult = { node: AstNode; confidence: number; tier: MatchTier };

/**
 * Four-tier node lookup (Gap 42 adds Tier 0 symbolId and tags each tier):
 *
 * 0. SymbolId match (kind:name from stable symbolId) — `0.90` confidence.
 *    Used as the primary AST-first lookup when `targetSymbolId` is present.
 *    Survives full body rewrites as long as the symbol name and kind match.
 *
 * 1. Exact `blockHash` match (kind:name hash) — `0.95` confidence.
 *    Survives reformatting and code motion within the same file.
 *
 * 2. Name-only match — `0.87` confidence.
 *    Falls back when the blockHash is absent or stale.
 *
 * 3. Body-hash match — `0.78` confidence.
 *    Survives variable/function renames: the function body is unchanged but
 *    the symbol was renamed. Uses `targetBodyHash` when provided; otherwise
 *    computes body hashes on-the-fly from the extracted nodes.
 *    When multiple nodes share the same body hash, the one whose
 *    `paramCount` matches `targetParamCount` wins.
 */
function findBestMatchingNode(
  nodes: AstNode[],
  targetBlockHash: string,
  targetName: string,
  targetBodyHash?: string,
  targetParamCount?: number,
  targetSymbolId?: string,
): MatchResult | null {
  // Tier 0: symbolId match — extract kind:name from the symbolId and match
  // against nodes. This is the primary AST-first pass introduced by Gap 42.
  // A symbolId has the form `${filePath}#${kind}:${name}`.
  if (targetSymbolId !== undefined && targetSymbolId.length > 0) {
    const hashIndex = targetSymbolId.indexOf("#");
    if (hashIndex !== -1) {
      const kindName = targetSymbolId.slice(hashIndex + 1); // e.g. "function:validateToken"
      for (const node of nodes) {
        if (`${node.kind}:${node.name}` === kindName) {
          return { node, confidence: CONFIDENCE_SYMBOL_ID, tier: "symbolId" };
        }
      }
    }
  }

  // Tier 1: exact block-hash match.
  for (const node of nodes) {
    if (hashAstSignature(node.kind, node.name) === targetBlockHash) {
      return { node, confidence: CONFIDENCE_BLOCK_HASH, tier: "blockHash" };
    }
  }

  // Tier 2: name-only match.
  for (const node of nodes) {
    if (node.name === targetName) {
      return { node, confidence: CONFIDENCE_NAME_MATCH, tier: "name" };
    }
  }

  // Tier 3: body-hash match (rename resilience).
  if (targetBodyHash !== undefined && targetBodyHash.length > 0) {
    const bodyMatches: AstNode[] = [];
    for (const node of nodes) {
      const nodeBodyHash = computeBodyHash(node.bodyLines);
      if (nodeBodyHash === targetBodyHash) {
        bodyMatches.push(node);
      }
    }

    if (bodyMatches.length > 0) {
      // Prefer the node whose paramCount matches.
      if (targetParamCount !== undefined && bodyMatches.length > 1) {
        const paramMatch = bodyMatches.find(
          (n) => n.paramCount === targetParamCount,
        );
        if (paramMatch !== undefined) {
          return { node: paramMatch, confidence: CONFIDENCE_BODY_HASH, tier: "bodyHash" };
        }
      }
      return { node: bodyMatches[0]!, confidence: CONFIDENCE_BODY_HASH, tier: "bodyHash" };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the AST layer can process the given file based on its
 * extension. Supported: TypeScript, JavaScript (all variants), Python, Go,
 * Java, C#, and Rust.
 */
export function isAstLayerApplicable(filePath: string): boolean {
  validateFilePath(filePath);
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|cs|rs)$/.test(filePath);
}

/**
 * Build a compact fingerprint of the file's AST structure.
 * Used by the baseline snapshot to detect structural changes across commits.
 */
export function buildAstFingerprint(raw: string): string {
  validateFileContent(raw);
  const lines = raw.split("\n");
  const content: FileContent = { lines, raw };
  const nodes = extractAstNodes(content);
  const signatures = nodes.map((n) => `${n.kind}:${n.name}`).join("|");
  return createHash("sha256").update(signatures).digest("hex");
}

/**
 * Build a complete `AstAnchor` for the symbol that covers `lineRange` in
 * `fileContent`. The anchor includes:
 *
 * - `blockHash` — hash of `kind:name`, the primary lookup key.
 * - `bodyHash`  — hash of the normalised function body; enables rename-
 *                 resilient tracking after a symbol is renamed.
 * - `paramCount` — number of formal parameters; tiebreaker when two symbols
 *                  share an identical body.
 *
 * Returns `null` when no AST node overlaps the requested line range (e.g.
 * the range covers plain statements or the file type is not supported).
 */
export function buildAstAnchor(
  filePath: string,
  lineRange: { start: number; end: number },
  fileContent: string,
): AstAnchor {
  validateFilePath(filePath);
  validateFileContent(fileContent);

  if (!isAstLayerApplicable(filePath)) {
    return null;
  }

  const lines = fileContent.split("\n");
  const content: FileContent = { lines, raw: fileContent };
  const nodes = extractAstNodes(content);

  // Find the node whose range best overlaps the requested line range.
  // Prefer the smallest node that fully contains the range; fall back to the
  // best-overlapping node.
  let best: AstNode | null = null;
  let bestOverlap = 0;

  for (const node of nodes) {
    const overlapStart = Math.max(node.startLine, lineRange.start);
    const overlapEnd = Math.min(node.endLine, lineRange.end);
    const overlap = Math.max(0, overlapEnd - overlapStart + 1);

    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = node;
    }
  }

  if (best === null) {
    return null;
  }

  return {
    kind: best.kind,
    name: best.name,
    blockHash: hashAstSignature(best.kind, best.name),
    bodyHash: computeBodyHash(best.bodyLines),
    paramCount: best.paramCount,
    symbolId: `${filePath}#${best.kind}:${best.name}`,
  };
}

/**
 * Sprint 2 / [E.6] re-anchor migration — async variant of `buildAstAnchor` that
 * uses tree-sitter when a grammar is available and falls back to the regex
 * extractor otherwise.
 *
 * Why this exists: persisted `astAnchor.bodyHash` values across the corpus
 * were computed with the regex extractor.  The hash-audit shows 0 / 845
 * compat with tree-sitter's body slicing because the regex layer terminates
 * single-line-opening-brace bodies early.  The migration tool calls this
 * function for every entry so the persisted anchors match what
 * `mapWithAstLayerAsync` computes at heal time — enabling Tier-3 (bodyHash)
 * rename-resilience under the tree-sitter path.
 */
export async function buildAstAnchorAsync(
  filePath: string,
  lineRange: { start: number; end: number },
  fileContent: string,
): Promise<AstAnchor> {
  validateFilePath(filePath);
  validateFileContent(fileContent);

  if (!isAstLayerApplicable(filePath)) {
    return null;
  }

  const lines = fileContent.split("\n");
  const content: FileContent = { lines, raw: fileContent };

  // Try tree-sitter first; fall back to regex (parity with mapWithAstLayerAsync).
  const tsNodes = await extractAstNodesViaTreeSitter(filePath, content);
  const nodes = tsNodes ?? extractAstNodes(content);

  let best: AstNode | null = null;
  let bestOverlap = 0;

  for (const node of nodes) {
    const overlapStart = Math.max(node.startLine, lineRange.start);
    const overlapEnd = Math.min(node.endLine, lineRange.end);
    const overlap = Math.max(0, overlapEnd - overlapStart + 1);

    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = node;
    }
  }

  if (best === null) {
    return null;
  }

  return {
    kind: best.kind,
    name: best.name,
    blockHash: hashAstSignature(best.kind, best.name),
    bodyHash: computeBodyHash(best.bodyLines),
    paramCount: best.paramCount,
    symbolId: `${filePath}#${best.kind}:${best.name}`,
  };
}

/**
 * Result of a cross-file move search.
 */
export type MovedEntryMatch = {
  filePath: string;
  updatedLineRange: { start: number; end: number };
  confidence: number;
};

/**
 * Search for a context entry's annotated symbol across multiple candidate
 * files. This handles the **file-split** scenario: the function was moved
 * to a different module and the original file no longer contains it.
 *
 * `candidateFiles` is a map of `filePath → fileContent`. Only files for
 * which `isAstLayerApplicable` returns `true` are searched.
 *
 * Returns the best match found, or `null` when no file contains the symbol
 * above the minimum confidence threshold (0.5).
 */
export function searchForMovedEntry(
  entry: ContextEntry,
  candidateFiles: Map<string, string>,
): MovedEntryMatch | null {
  ContextEntrySchema.parse(entry);

  if (entry.astAnchor === null) {
    return null;
  }

  const anchor = entry.astAnchor;
  let best: MovedEntryMatch | null = null;

  for (const [filePath, fileContent] of candidateFiles) {
    if (!isAstLayerApplicable(filePath)) continue;
    if (filePath === entry.filePath) continue;

    try {
      validateFileContent(fileContent);
    } catch {
      continue;
    }

    const lines = fileContent.split("\n");
    const content: FileContent = { lines, raw: fileContent };
    const nodes = extractAstNodes(content);

    const match = findBestMatchingNode(
      nodes,
      anchor.blockHash,
      anchor.name,
      anchor.bodyHash,
      anchor.paramCount,
      anchor.symbolId,
    );

    if (match !== null && match.confidence > 0.5) {
      if (best === null || match.confidence > best.confidence) {
        best = {
          filePath,
          updatedLineRange: {
            start: match.node.startLine,
            end: match.node.endLine,
          },
          confidence: match.confidence,
        };
      }
    }
  }

  return best;
}

/**
 * Map a single `ContextEntry` to its new position in `currentFileContent`
 * using AST-based symbol lookup.
 *
 * Matching tiers (in order):
 *  0. SymbolId match (kind:name from symbolId) — confidence 0.90  ← Gap 42
 *  1. Exact block-hash (`kind:name`) — confidence 0.95
 *  2. Symbol name only             — confidence 0.87
 *  3. Normalised body hash         — confidence 0.78  ← rename resilience
 *
 * Gap 42 — Partial-rewrite detection:
 * When the match tier is "symbolId" or "name" (i.e. the blockHash changed but
 * the symbol name and kind still match), the annotation is promoted to
 * `"uncertain"` regardless of the raw confidence value. This surfaces a
 * "code may have changed" warning rather than silently treating the entry as
 * fully mapped or discarding it as orphaned.
 *
 * Returns `{ status: "orphaned" }` when:
 *  - `entry.astAnchor` is `null`, or
 *  - no node matches at any tier.
 */
/**
 * Sprint 2 / [E.6] — Async variant of `mapWithAstLayer` that uses tree-sitter
 * when a grammar is available, and falls back to the regex extractor otherwise.
 *
 * Identical matching contract to `mapWithAstLayer`: same four tiers, same
 * confidences, same partial-rewrite detection. Only the node extraction changes.
 *
 * Why both sync and async exist:
 *   - The mapping pipeline (`mapContextEntry`) is already async, so it adopts
 *     this version to get tree-sitter coverage.
 *   - The sync `mapWithAstLayer` stays for callers that can't await (validation
 *     tests, snapshot tooling) and as the regex implementation behind the
 *     async path's fallback.
 */
export async function mapWithAstLayerAsync(
  entry: ContextEntry,
  currentFileContent: string,
): Promise<MappingResult> {
  ContextEntrySchema.parse(entry);
  validateFileContent(currentFileContent);

  try {
    if (entry.astAnchor === null) {
      return {
        confidence: 0,
        status: "orphaned",
        updatedLineRange: entry.lineRange,
      };
    }

    const lines = currentFileContent.split("\n");
    const content: FileContent = { lines, raw: currentFileContent };

    // Try tree-sitter first; fall back to regex when grammar unavailable.
    const tsNodes = await extractAstNodesViaTreeSitter(entry.filePath, content);
    const nodes = tsNodes ?? extractAstNodes(content);

    const match = findBestMatchingNode(
      nodes,
      entry.astAnchor.blockHash,
      entry.astAnchor.name,
      entry.astAnchor.bodyHash,
      entry.astAnchor.paramCount,
      entry.astAnchor.symbolId,
    );

    if (match === null) {
      return {
        confidence: 0,
        status: "orphaned",
        updatedLineRange: entry.lineRange,
      };
    }

    const { node, confidence, tier } = match;
    const isPartialRewrite = tier === "symbolId" || tier === "name";
    const status: MappingStatus = isPartialRewrite
      ? "uncertain"
      : classifyConfidence(confidence);

    const layerHint: MappingResult["layerHint"] =
      tier === "blockHash" ? "astBlockHash"
      : tier === "bodyHash" ? "astBodyHash"
      : "astSymbol";

    return {
      confidence,
      status,
      updatedLineRange: { start: node.startLine, end: node.endLine },
      layerHint,
    };
  } catch (err) {
    throw new MappingLayerError("ast", err);
  }
}

export function mapWithAstLayer(
  entry: ContextEntry,
  currentFileContent: string,
): MappingResult {
  ContextEntrySchema.parse(entry);
  validateFileContent(currentFileContent);

  try {
    if (entry.astAnchor === null) {
      return {
        confidence: 0,
        status: "orphaned",
        updatedLineRange: entry.lineRange,
      };
    }

    const lines = currentFileContent.split("\n");
    const content: FileContent = { lines, raw: currentFileContent };
    const nodes = extractAstNodes(content);

    const match = findBestMatchingNode(
      nodes,
      entry.astAnchor.blockHash,
      entry.astAnchor.name,
      entry.astAnchor.bodyHash,
      entry.astAnchor.paramCount,
      entry.astAnchor.symbolId,
    );

    if (match === null) {
      return {
        confidence: 0,
        status: "orphaned",
        updatedLineRange: entry.lineRange,
      };
    }

    const { node, confidence, tier } = match;

    // Gap 42 — Partial-rewrite detection:
    // A symbolId or name-only match means the blockHash changed (the function
    // body was rewritten). Force the status to "uncertain" so the annotator
    // is prompted to re-verify the note rather than silently accepting it.
    const isPartialRewrite = tier === "symbolId" || tier === "name";
    const status: MappingStatus = isPartialRewrite
      ? "uncertain"
      : classifyConfidence(confidence);

    // Map the tier to a MappingResult layerHint.
    const layerHint: MappingResult["layerHint"] =
      tier === "blockHash" ? "astBlockHash"
      : tier === "bodyHash" ? "astBodyHash"
      : "astSymbol";

    return {
      confidence,
      status,
      updatedLineRange: { start: node.startLine, end: node.endLine },
      layerHint,
    };
  } catch (err) {
    throw new MappingLayerError("ast", err);
  }
}
