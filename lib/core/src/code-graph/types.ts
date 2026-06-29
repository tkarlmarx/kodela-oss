// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Code-graph parser types.
 *
 * Phase 4 of the project design docs
 *
 * `parseFunctions` returns a list of function-like declarations a Tree-sitter
 * grammar found in a single source file. The shape is deliberately small and
 * language-agnostic so the dashboard's "Expand functions" toggle can render
 * function nodes without knowing which grammar produced them.
 */

export type SupportedLanguage =
  | "typescript"
  | "tsx"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "bash";

export type FunctionKind =
  | "function"   // top-level function declaration / `def`
  | "method"     // method on a class
  | "class"      // class declaration — included for navigation, methods nest inside
  | "arrow"      // `const foo = () => {}` — TS only
  | "generator"; // `function* x()` or `async def` (Python `async` mapped to "generator")

export interface CodeGraphFunction {
  /** Human-readable name. `<anonymous>:L42` for unnamed declarations. */
  name: string;
  kind: FunctionKind;
  /** 1-based line numbers, inclusive. */
  startLine: number;
  endLine: number;
  language: SupportedLanguage;
  /** Containing class name, when {@link kind} === "method". */
  parent?: string;
  /**
   * Stable cross-rename identifier — `<repoRelPath>#<kind>:<name>` per
   * doc 14 §4.1. The parser cannot know the repo root so callers compose the
   * final anchor; this field carries the `<kind>:<name>` half only.
   */
  ast_anchor: string;
}
