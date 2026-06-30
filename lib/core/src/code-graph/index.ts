// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Code-graph barrel — Phase 4 entrypoint.
 *
 * Consumers (api-server, mcp-server, dashboard helpers) import from
 * `@kodela/core/code-graph`.  Keep this barrel minimal so optional
 * `web-tree-sitter` / grammar deps are loaded only when first invoked.
 */

export type { CodeGraphFunction, FunctionKind, SupportedLanguage } from "./types.js";
export {
  parseFunctions,
  languageForFile,
  _resetParserCacheForTests,
  _grammarAvailableForTests,
  _setGrammarPathOverrideForTests,
} from "./treesitter-layer.js";
export {
  ensureFunctionCacheTables,
  hashFileContent,
  readCachedFunctions,
  writeCachedFunctions,
  invalidateOtherHashes,
  countCachedRows,
} from "./function-cache-store.js";
