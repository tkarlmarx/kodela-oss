// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { existsSync } from "node:fs";
import path from "node:path";
import {
  isAstLayerApplicable,
  mapWithAstLayer,
  mapWithAstLayerAsync,
  searchForMovedEntry,
} from "./ast-layer.js";

/**
 * Sprint 2 / [E.6] re-anchor migration marker.  Written by
 * `kodela heal --re-anchor` after a successful run.  When present, the mapping
 * engine treats tree-sitter as the default heal path — the env-var override
 * still takes precedence either way.
 *
 * Cached per repoRoot to avoid stat-calling on every mapContextEntry invocation
 * (heal walks every entry; one boolean per repo is enough).
 */
const REANCHOR_MARKER_REL = ".kodela/.tree-sitter-anchored";
const reanchorMarkerCache = new Map<string, boolean>();
function hasReAnchorMarker(repoRoot: string): boolean {
  const cached = reanchorMarkerCache.get(repoRoot);
  if (cached !== undefined) return cached;
  const present = existsSync(path.join(repoRoot, REANCHOR_MARKER_REL));
  reanchorMarkerCache.set(repoRoot, present);
  return present;
}

/** Test hook — clears the marker cache between fixture runs. */
export function _resetReAnchorMarkerCacheForTests(): void {
  reanchorMarkerCache.clear();
}
import { mapWithTokenHashLayer } from "./token-hash-layer.js";
import { mapWithGitDiffLayer } from "./git-diff-layer.js";
import { classifyConfidence, type MappingResult } from "./confidence.js";
import { ContextEntrySchema } from "../schema/index.js";
import type { ContextEntry } from "../schema/index.js";
import {
  validateFileContent,
  validateRepoRoot,
} from "../validation.js";

export type MappingLayerName =
  | "ast"
  | "astSymbol"
  | "token-hash"
  | "git-diff"
  | "cross-file"
  | "fallback";

export type DetailedMappingResult = MappingResult & {
  layerUsed: MappingLayerName;
  /**
   * When `layerUsed` is `"cross-file"`, this is the file path where the
   * symbol was found after the annotated file no longer contained it.
   */
  movedToFilePath?: string;
};

const MINIMUM_CONFIDENCE_THRESHOLD = 0.3;

export function selectMappingLayer(
  entry: ContextEntry,
  fileContent: string,
): MappingLayerName {
  ContextEntrySchema.parse(entry);
  validateFileContent(fileContent);

  if (entry.astAnchor !== null && isAstLayerApplicable(entry.filePath)) {
    return "ast";
  }
  if (fileContent.length > 0) {
    return "token-hash";
  }
  return "git-diff";
}

/**
 * Map a context entry to its current position using a layered fallback
 * strategy:
 *
 * 1. **AST layer** — symbol lookup by kind:name hash, then by name, then by
 *    normalised body hash (rename-resilient). Requires `entry.astAnchor`.
 * 2. **Token-hash layer** — sliding-window content hash search.
 * 3. **Git-diff layer** — git blame / diff heuristics.
 * 4. **Cross-file layer** — searches `candidateFiles` for the symbol when all
 *    same-file layers fail. Handles file-split scenarios.
 * 5. **Fallback** — returns the original line range with `confidence: 0`.
 *
 * Pass `candidateFiles` (a map of `filePath → fileContent`) to enable
 * cross-file move detection. Only files for which `isAstLayerApplicable`
 * returns `true` are searched.
 */
export async function mapContextEntry(
  entry: ContextEntry,
  currentFileContent: string,
  repoRoot: string,
  candidateFiles?: Map<string, string>,
): Promise<DetailedMappingResult> {
  ContextEntrySchema.parse(entry);
  validateFileContent(currentFileContent);
  validateRepoRoot(repoRoot);

  const astApplicable =
    entry.astAnchor !== null && isAstLayerApplicable(entry.filePath);

  if (astApplicable) {
    try {
      // Sprint 2 / [E.6] — async variant uses tree-sitter for supported
      // languages (TS/TSX/Python/Go/Rust/Java/Bash) and falls back to the
      // regex extractor for everything else.
      //
      // Default decision (priority order):
      //   1. `KODELA_TREESITTER_AST_LAYER=1` → force ON (operator override)
      //   2. `KODELA_TREESITTER_AST_LAYER=0` → force OFF (operator override)
      //   3. Otherwise → ON when `.kodela/.tree-sitter-anchored` marker exists
      //      (i.e. `kodela heal --re-anchor` has run and the persisted anchors
      //      are aligned with tree-sitter's body slicing); OFF otherwise.
      //
      // This honours the 2026-06-25 deferral decision — legacy installs that
      // haven't run the migration get regex (no regression); migrated installs
      // get tree-sitter automatically.
      const envVal = process.env["KODELA_TREESITTER_AST_LAYER"];
      const useTreeSitter =
        envVal === "1" ? true :
        envVal === "0" ? false :
        hasReAnchorMarker(repoRoot);
      const result = useTreeSitter
        ? await mapWithAstLayerAsync(entry, currentFileContent)
        : mapWithAstLayer(entry, currentFileContent);
      if (result.confidence > MINIMUM_CONFIDENCE_THRESHOLD) {
        // Gap 42 — use "astSymbol" as layerUsed when the match was made by
        // symbolId or name (partial-rewrite detection path), so callers can
        // distinguish it from an exact block-hash match.
        const layerUsed: MappingLayerName =
          result.layerHint === "astSymbol" ? "astSymbol" : "ast";
        // AST layer does not produce token/position scores; synthesise a
        // scoreBreakdown from the AST confidence so that callers always have
        // a populated breakdown regardless of which layer won.
        const scoreBreakdown = result.scoreBreakdown ?? {
          token: result.confidence,
          position: result.confidence,
        };
        return { ...result, layerUsed, scoreBreakdown };
      }
    } catch {
      // AST layer failed — fall through to next layer
    }
  }

  try {
    const result = mapWithTokenHashLayer(entry, currentFileContent);
    if (result.confidence > MINIMUM_CONFIDENCE_THRESHOLD) {
      return { ...result, layerUsed: "token-hash" };
    }
  } catch {
    // Token hash layer failed — fall through to git diff
  }

  try {
    const result = await mapWithGitDiffLayer(entry, repoRoot);
    if (result.confidence > MINIMUM_CONFIDENCE_THRESHOLD) {
      return { ...result, layerUsed: "git-diff" };
    }
  } catch {
    // Git diff layer failed — fall through
  }

  // Cross-file layer: try to locate the symbol in sibling files.
  if (candidateFiles !== undefined && candidateFiles.size > 0) {
    try {
      const moved = searchForMovedEntry(entry, candidateFiles);
      if (moved !== null) {
        return {
          confidence: moved.confidence,
          status: classifyConfidence(moved.confidence),
          updatedLineRange: moved.updatedLineRange,
          layerUsed: "cross-file",
          movedToFilePath: moved.filePath,
          scoreBreakdown: { token: 0, position: 0 },
        };
      }
    } catch {
      // Cross-file search failed — fall through to fallback
    }
  }

  const confidence = 0;
  return {
    confidence,
    status: classifyConfidence(confidence),
    updatedLineRange: entry.lineRange,
    layerUsed: "fallback",
    scoreBreakdown: { token: 0, position: 0 },
  };
}
