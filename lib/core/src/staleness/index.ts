// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 48 — Content staleness detection helpers.
 *
 * This module provides three functions used by the heal engine and `kodela add`
 * to track whether an annotation's text is still accurate after code changes:
 *
 *   extractFingerprint(code)           → string[]
 *     Lightweight identifier/token extraction (no AST required).
 *
 *   computeJaccard(a, b)               → number  [0, 1]
 *     Jaccard similarity between two token sets.
 *
 *   computeContentDrift(stored, current) → "low" | "medium" | "high"
 *     Maps Jaccard distance to a drift level.
 */

/**
 * Extract a deduplicated set of tokens from a code fragment.
 *
 * Tokens captured:
 *   - Identifiers: camelCase, PascalCase, snake_case, UPPER_CASE (≥ 2 chars)
 *   - Function calls: identifier immediately followed by `(` → stored as `id(`
 *   - String literals: content of single/double/backtick quoted strings
 *     (truncated to 40 chars to avoid long URLs inflating the set)
 *
 * Returns a sorted, deduplicated array.  Empty when `code` is blank.
 */
export function extractFingerprint(code: string): string[] {
  const tokens = new Set<string>();

  // --- string literals (single, double, backtick) ---
  const stringLiteralRe = /(?:'([^'\\]{1,40})'|"([^"\\]{1,40})"|`([^`\\]{1,40})`)/g;
  let m: RegExpExecArray | null;
  while ((m = stringLiteralRe.exec(code)) !== null) {
    const val = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (val.length >= 2) tokens.add(`"${val}"`);
  }

  // Remove string content so string-internal words don't appear as identifiers.
  const stripped = code
    .replace(/`[^`]*`/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/'[^']*'/g, " ");

  // --- function calls: word( ---
  const callRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  while ((m = callRe.exec(stripped)) !== null) {
    const name = m[1]!.toLowerCase();
    if (name.length >= 2) tokens.add(`${name}(`);
  }

  // --- identifiers (≥ 2 chars, not pure numbers) ---
  const identRe = /\b([A-Za-z_$][A-Za-z0-9_$]{1,})\b/g;
  while ((m = identRe.exec(stripped)) !== null) {
    const word = m[1]!.toLowerCase();
    // Skip common noise keywords
    if (NOISE_KEYWORDS.has(word)) continue;
    tokens.add(word);
  }

  return [...tokens].sort();
}

/** Keywords too common to be useful as drift signals. */
const NOISE_KEYWORDS = new Set([
  "const", "let", "var", "function", "class", "return", "if", "else",
  "for", "while", "do", "switch", "case", "break", "continue", "new",
  "this", "typeof", "instanceof", "in", "of", "import", "export",
  "default", "from", "async", "await", "try", "catch", "finally",
  "throw", "void", "null", "undefined", "true", "false", "static",
  "public", "private", "protected", "abstract", "readonly", "interface",
  "type", "enum", "extends", "implements", "super", "yield", "delete",
  "as", "is", "declare", "namespace", "module",
  // Python / Go / Ruby common keywords
  "def", "end", "do", "pass", "raise", "except", "with", "lambda",
  "and", "or", "not", "in", "print", "self", "cls",
  "func", "go", "chan", "map", "select", "defer", "range",
]);

/**
 * Compute the Jaccard similarity between two token sets.
 *
 *   J(A, B) = |A ∩ B| / |A ∪ B|
 *
 * Returns 1.0 when both sets are empty (nothing to compare → no divergence).
 * Returns 0.0 when one set is empty and the other is not.
 */
export function computeJaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const setA = new Set(a);
  const setB = new Set(b);

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

/**
 * Map the Jaccard distance between a stored fingerprint and a freshly-computed
 * fingerprint to a drift level.
 *
 * Distance thresholds (Jaccard distance = 1 − similarity):
 *   < 0.20  → "low"    (code barely changed)
 *   < 0.50  → "medium" (noticeable divergence — worth reviewing)
 *   ≥ 0.50  → "high"   (annotation likely stale)
 *
 * Special cases:
 *   - Either fingerprint is empty → treat as "low" (no signal).
 *   - stored === current (distance = 0) → "low".
 */
export function computeContentDrift(
  stored: readonly string[],
  current: readonly string[],
): "low" | "medium" | "high" {
  if (stored.length === 0 || current.length === 0) return "low";

  const similarity = computeJaccard(stored, current);
  const distance = 1 - similarity;

  if (distance < 0.20) return "low";
  if (distance < 0.50) return "medium";
  return "high";
}
