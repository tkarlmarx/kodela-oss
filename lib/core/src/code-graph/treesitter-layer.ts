// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Tree-sitter parser dispatcher for the function-level code graph.
 *
 * Phase 4 of the project design docs
 * and §4.1 of doc 14 (function-level code graph).
 *
 * Resolves the right grammar from the file extension, parses the source, runs a
 * language-specific extraction query, and returns a normalised
 * {@link CodeGraphFunction}[].  All Tree-sitter work happens lazily; the WASM
 * runtime and grammar packages live under `optionalDependencies` so a customer
 * install on a slow link or unusual platform that fails to fetch them still
 * yields `[]` from `parseFunctions` instead of crashing the watcher.
 *
 * Why WASM, not native: the bundled `@kodela/cli` tarball must `npm install`
 * cleanly on machines without a C toolchain.  Native `tree-sitter` bindings
 * require `node-gyp` + Python + gcc; WASM grammars are a single fetch.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import type { CodeGraphFunction, SupportedLanguage } from "./types.js";

type WasmGrammarModule =
  | "@lumis-sh/wasm-typescript"
  | "@lumis-sh/wasm-tsx"
  | "@lumis-sh/wasm-python"
  | "@lumis-sh/wasm-go"
  | "@lumis-sh/wasm-rust"
  | "@lumis-sh/wasm-java"
  | "@lumis-sh/wasm-bash";

const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".jsx": "tsx",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".sh": "bash",
  ".bash": "bash",
};

const LANGUAGE_TO_GRAMMAR_PKG: Record<SupportedLanguage, WasmGrammarModule> = {
  typescript: "@lumis-sh/wasm-typescript",
  tsx: "@lumis-sh/wasm-tsx",
  python: "@lumis-sh/wasm-python",
  go: "@lumis-sh/wasm-go",
  rust: "@lumis-sh/wasm-rust",
  java: "@lumis-sh/wasm-java",
  bash: "@lumis-sh/wasm-bash",
};

const GRAMMAR_WASM_SUBPATH: Record<WasmGrammarModule, string> = {
  "@lumis-sh/wasm-typescript": "@lumis-sh/wasm-typescript/tree-sitter-typescript.wasm",
  "@lumis-sh/wasm-tsx": "@lumis-sh/wasm-tsx/tree-sitter-tsx.wasm",
  "@lumis-sh/wasm-python": "@lumis-sh/wasm-python/tree-sitter-python.wasm",
  "@lumis-sh/wasm-go": "@lumis-sh/wasm-go/tree-sitter-go.wasm",
  "@lumis-sh/wasm-rust": "@lumis-sh/wasm-rust/tree-sitter-rust.wasm",
  "@lumis-sh/wasm-java": "@lumis-sh/wasm-java/tree-sitter-java.wasm",
  "@lumis-sh/wasm-bash": "@lumis-sh/wasm-bash/tree-sitter-bash.wasm",
};

const QUERIES: Record<SupportedLanguage, string> = {
  // TypeScript grammar covers .ts/.mts/.cts.
  typescript: `
    (function_declaration name: (identifier) @name) @function
    (generator_function_declaration name: (identifier) @name) @generator
    (method_definition name: (property_identifier) @name) @method
    (class_declaration name: (type_identifier) @name) @class
    (abstract_class_declaration name: (type_identifier) @name) @class
    (variable_declarator
      name: (identifier) @arrow_name
      value: [(arrow_function) (function_expression)]) @arrow
  `,
  // TSX grammar — same shape, includes JSX/component syntax.
  tsx: `
    (function_declaration name: (identifier) @name) @function
    (generator_function_declaration name: (identifier) @name) @generator
    (method_definition name: (property_identifier) @name) @method
    (class_declaration name: (type_identifier) @name) @class
    (abstract_class_declaration name: (type_identifier) @name) @class
    (variable_declarator
      name: (identifier) @arrow_name
      value: [(arrow_function) (function_expression)]) @arrow
  `,
  python: `
    (function_definition name: (identifier) @name) @function
    (class_definition name: (identifier) @name) @class
    (decorated_definition (function_definition name: (identifier) @name)) @function
    (decorated_definition (class_definition name: (identifier) @name)) @class
  `,
  // Go — top-level functions, methods on receivers, struct/interface type decls.
  // method_declaration has a "receiver" parameter_list that holds the type the
  // method is attached to; resolveParent() walks the method node's children to
  // pull the receiver type out as `parent` (Go has no enclosing class node).
  go: `
    (function_declaration name: (identifier) @name) @function
    (method_declaration name: (field_identifier) @name) @method
    (type_declaration (type_spec name: (type_identifier) @name (struct_type))) @class
    (type_declaration (type_spec name: (type_identifier) @name (interface_type))) @class
  `,
  // Rust — top-level fn (function_item) plus impl methods (also function_item
  // but nested in impl_item/declaration_list). resolveParent() walks up to the
  // enclosing impl_item to extract the type the impl block is for.
  rust: `
    (function_item name: (identifier) @name) @function
    (struct_item name: (type_identifier) @name) @class
    (enum_item name: (type_identifier) @name) @class
    (trait_item name: (type_identifier) @name) @class
  `,
  // Java — class/interface/method/constructor. Constructors collapse to "method"
  // with the parent set to the enclosing class.
  java: `
    (method_declaration name: (identifier) @name) @method
    (constructor_declaration name: (identifier) @name) @method
    (class_declaration name: (identifier) @name) @class
    (interface_declaration name: (identifier) @name) @class
    (enum_declaration name: (identifier) @name) @class
  `,
  // Bash — function_definition only. No classes or methods.
  bash: `
    (function_definition name: (word) @name) @function
  `,
};

interface ParserHandles {
  Parser: any;
  Language: any;
  Query: any;
}

let parserInitPromise: Promise<ParserHandles | null> | null = null;
const grammarCache = new Map<SupportedLanguage, Promise<any | null>>();

/**
 * Per-language `{ parser, query }` cache. One Parser allocation + setLanguage
 * + Query compile per language, reused across every parseFunctions() call for
 * that language. Avoids 32ms-per-file cold path slowdown in the perf bench
 * (internal design note).
 *
 * Safe for serial use; the dispatcher is single-threaded.
 */
const parserPool = new Map<SupportedLanguage, { parser: any; query: any }>();

function nodeRequire() {
  return createRequire(import.meta.url);
}

function resolveWebTreeSitterWasm(): string | null {
  try {
    const req = nodeRequire();
    // The package declares `./web-tree-sitter.wasm` as an exports subpath, so
    // `require.resolve` returns the absolute on-disk path directly.  Resolving
    // `./package.json` would fail under the modern exports map.
    const wasmPath = req.resolve("web-tree-sitter/web-tree-sitter.wasm");
    return existsSync(wasmPath) ? wasmPath : null;
  } catch {
    return null;
  }
}

async function initParser(): Promise<ParserHandles | null> {
  if (!parserInitPromise) {
    parserInitPromise = (async () => {
      try {
        const mod: any = await import("web-tree-sitter");
        const Parser = mod.Parser;
        const Language = mod.Language;
        const Query = mod.Query;
        if (!Parser || !Language || !Query) return null;
        const wasmPath = resolveWebTreeSitterWasm();
        await Parser.init(
          wasmPath
            ? {
                locateFile: (name: string) =>
                  name === "tree-sitter.wasm" || name === "web-tree-sitter.wasm" ? wasmPath : name,
              }
            : undefined,
        );
        return { Parser, Language, Query };
      } catch {
        return null;
      }
    })();
  }
  return parserInitPromise;
}

/**
 * Test-only override.  When set, `resolveGrammarPath` consults this function
 * before the real resolver — letting tests simulate "wasm fails to load" for
 * a supported extension (the GRAMMAR_UNAVAILABLE path).  Production NEVER
 * sets this; the variable stays `null` and the conditional adds one cheap
 * truthy check per call.
 */
let testGrammarPathOverride: ((pkg: WasmGrammarModule) => string | null) | null = null;

function resolveGrammarPath(pkg: WasmGrammarModule): string | null {
  if (testGrammarPathOverride) return testGrammarPathOverride(pkg);
  try {
    const req = nodeRequire();
    // Each grammar package declares the .wasm file under its `exports` map
    // (e.g. `"./tree-sitter-tsx.wasm": "./tree-sitter-tsx.wasm"`), so
    // `require.resolve` returns the absolute on-disk path directly.
    const wasmPath = req.resolve(GRAMMAR_WASM_SUBPATH[pkg]);
    return existsSync(wasmPath) ? wasmPath : null;
  } catch {
    return null;
  }
}

/**
 * Test-only — install a `resolveGrammarPath` override for the duration of a
 * test, then call `_setGrammarPathOverrideForTests(null)` in a `finally` to
 * restore production behavior.  Used by the GRAMMAR_UNAVAILABLE test to prove
 * `parseFunctions` returns `[]` when a supported language's wasm cannot be
 * located on disk.
 */
export function _setGrammarPathOverrideForTests(
  override: ((pkg: WasmGrammarModule) => string | null) | null,
): void {
  testGrammarPathOverride = override;
}

async function loadGrammar(language: SupportedLanguage): Promise<any | null> {
  const cached = grammarCache.get(language);
  if (cached) return cached;
  const promise = (async () => {
    const handles = await initParser();
    if (!handles) return null;
    const pkg = LANGUAGE_TO_GRAMMAR_PKG[language];
    const wasmPath = resolveGrammarPath(pkg);
    if (!wasmPath) return null;
    try {
      const bytes = readFileSync(wasmPath);
      // Pass a fresh Uint8Array — `readFileSync` returns a Buffer that
      // emscripten's wasm loader doesn't always recognise as a plain typed
      // array on older Node versions.
      const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return await handles.Language.load(u8);
    } catch {
      return null;
    }
  })();
  grammarCache.set(language, promise);
  return promise;
}

export function languageForFile(filePath: string): SupportedLanguage | null {
  const lower = filePath.toLowerCase();
  for (const [ext, lang] of Object.entries(EXTENSION_TO_LANGUAGE)) {
    if (lower.endsWith(ext)) return lang;
  }
  return null;
}

function findEnclosingClassName(node: any): string | undefined {
  let cur = node?.parent;
  while (cur) {
    const t = cur.type;
    if (
      t === "class_declaration" ||
      t === "abstract_class_declaration" ||
      t === "class_definition" ||
      // Java enum/interface bodies also enclose methods.
      t === "interface_declaration" ||
      t === "enum_declaration"
    ) {
      const nameNode = cur.childForFieldName?.("name");
      if (nameNode?.text) return nameNode.text;
      return undefined;
    }
    cur = cur.parent;
  }
  return undefined;
}

/**
 * Rust — methods are `function_item` nodes nested under an `impl_item`'s
 * `declaration_list`. The impl_item carries the target type as its
 * `type_identifier` child (e.g. `impl Greeter { fn greet(...) }`).
 */
function findRustImplTypeName(node: any): string | undefined {
  let cur = node?.parent;
  while (cur) {
    if (cur.type === "impl_item") {
      const typeNode = cur.childForFieldName?.("type") ?? null;
      if (typeNode?.text) return typeNode.text;
      // Fallback — walk named children for the first type_identifier.
      for (let i = 0; i < (cur.namedChildCount ?? 0); i++) {
        const child = cur.namedChild(i);
        if (child?.type === "type_identifier") return child.text;
      }
      return undefined;
    }
    cur = cur.parent;
  }
  return undefined;
}

/**
 * Go — method's receiver is a sibling: the first `parameter_list` child of
 * `method_declaration`. The receiver looks like `(g *Greeter)` or `(g Greeter)`;
 * we want "Greeter" as parent, ignoring pointer wrappers and identifiers.
 */
function findGoMethodReceiver(methodNode: any): string | undefined {
  if (!methodNode || methodNode.type !== "method_declaration") return undefined;
  // First named child of method_declaration is the receiver parameter_list.
  for (let i = 0; i < (methodNode.namedChildCount ?? 0); i++) {
    const child = methodNode.namedChild(i);
    if (child?.type !== "parameter_list") continue;
    // parameter_list → parameter_declaration → [pointer_type → type_identifier] | type_identifier.
    for (let j = 0; j < (child.namedChildCount ?? 0); j++) {
      const decl = child.namedChild(j);
      if (decl?.type !== "parameter_declaration") continue;
      for (let k = 0; k < (decl.namedChildCount ?? 0); k++) {
        const node = decl.namedChild(k);
        if (!node) continue;
        if (node.type === "type_identifier") return node.text;
        if (node.type === "pointer_type") {
          // pointer_type wraps another type_identifier.
          for (let m = 0; m < (node.namedChildCount ?? 0); m++) {
            const inner = node.namedChild(m);
            if (inner?.type === "type_identifier") return inner.text;
          }
        }
      }
    }
    // First parameter_list is the receiver — stop after inspecting it.
    return undefined;
  }
  return undefined;
}

/**
 * Per-language parent resolution. Returns the containing class / impl / receiver
 * type name when the function is a method, `undefined` for top-level functions.
 *
 * `classKind` is checked because for `kind === "class"` itself the parent walk
 * would (correctly) find nothing useful — skipping the work keeps things cheap.
 */
function resolveParent(language: SupportedLanguage, kind: CodeGraphFunction["kind"], node: any): string | undefined {
  if (kind === "class") return undefined;
  if (language === "rust") {
    const impl = findRustImplTypeName(node);
    if (impl) return impl;
    // Some Rust functions are not in an impl — fall through to the generic walk
    // so that struct/enum/trait don't accidentally claim parent attribution.
    return undefined;
  }
  if (language === "go") {
    const recv = findGoMethodReceiver(node);
    if (recv) return recv;
    return undefined;
  }
  if (language === "bash") {
    // Bash has no class concept.
    return undefined;
  }
  return findEnclosingClassName(node);
}

function buildAstAnchor(kind: CodeGraphFunction["kind"], name: string, startLine: number): string {
  return `${kind}:${name}@${startLine}`;
}

/**
 * Best-effort function extractor.
 *
 * Returns `[]` (never throws) for unsupported file types, when the WASM
 * runtime or grammar can't be loaded, or when parsing fails — callers treat an
 * empty list as "no function nodes available for this file" and fall back to
 * file-level edges.
 */
export async function parseFunctions(
  filePath: string,
  content: string,
): Promise<CodeGraphFunction[]> {
  const language = languageForFile(filePath);
  if (!language) return [];
  const handles = await initParser();
  if (!handles) return [];
  const grammar = await loadGrammar(language);
  if (!grammar) return [];

  let tree: any | null = null;
  try {
    // Reuse a cached Parser + Query for this language — saves ~10ms per file
    // versus allocating fresh handles on every call. The Parser is stateless
    // between `parse()` calls; the Query is by-design reusable for the life
    // of its language.
    let pool = parserPool.get(language);
    if (!pool) {
      const parser = new handles.Parser();
      parser.setLanguage(grammar);
      const query = new handles.Query(grammar, QUERIES[language]);
      pool = { parser, query };
      parserPool.set(language, pool);
    }
    tree = pool.parser.parse(content);
    if (!tree?.rootNode) return [];

    const matches: any[] = pool.query.matches(tree.rootNode);

    const results: CodeGraphFunction[] = [];
    const seen = new Set<string>();

    for (const match of matches) {
      const captures: any[] = match.captures ?? [];

      // Each pattern emits one "anchor" capture (the whole node) + one name
      // capture.  Find them by capture name.
      let bodyCapture: any | undefined;
      let nameCapture: any | undefined;
      let kind: CodeGraphFunction["kind"] | undefined;

      for (const c of captures) {
        switch (c.name) {
          case "function":
            bodyCapture = c; kind ??= "function"; break;
          case "method":
            bodyCapture = c; kind ??= "method"; break;
          case "class":
            bodyCapture = c; kind ??= "class"; break;
          case "generator":
            bodyCapture = c; kind ??= "generator"; break;
          case "arrow":
            bodyCapture = c; kind ??= "arrow"; break;
          case "name":
          case "arrow_name":
            nameCapture = c;
            break;
        }
      }

      if (!bodyCapture || !kind) continue;

      const startLine = (bodyCapture.node.startPosition?.row ?? 0) + 1;
      const endLine = (bodyCapture.node.endPosition?.row ?? startLine - 1) + 1;
      const rawName = nameCapture?.node?.text;
      const name = rawName && rawName.length > 0 ? rawName : `<anonymous>:L${startLine}`;

      // Per-language parent resolution. Python/TS/TSX/Java walk parent
      // chain to enclosing class; Rust walks to impl_item type; Go reads the
      // method's receiver type from a sibling parameter_list. See
      // resolveParent() for details.
      const parent = resolveParent(language, kind, bodyCapture.node);

      const dedupKey = `${kind}|${name}|${startLine}|${endLine}|${parent ?? ""}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      results.push({
        name,
        kind,
        startLine,
        endLine,
        language,
        parent,
        ast_anchor: buildAstAnchor(kind, name, startLine),
      });
    }

    results.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));
    return results;
  } catch {
    return [];
  } finally {
    try {
      tree?.delete?.();
    } catch {
      /* ignore */
    }
    // Parser + Query intentionally NOT deleted — they're pooled per language
    // and reused across calls.  _resetParserCacheForTests() disposes them.
  }
}

/** Test-only — clear the lazily-cached parser + grammars between fixture runs. */
export function _resetParserCacheForTests(): void {
  for (const pool of parserPool.values()) {
    try {
      pool.parser?.delete?.();
    } catch {
      /* ignore */
    }
    try {
      pool.query?.delete?.();
    } catch {
      /* ignore */
    }
  }
  parserPool.clear();
  parserInitPromise = null;
  grammarCache.clear();
}

/**
 * Test-only — `true` when the WASM runtime and grammar for `language` resolve
 * on disk.  Used by the test suite to decide between "happy-path assertion"
 * and "missing-dep skip" — production code must not branch on this; it should
 * always call `parseFunctions` and tolerate `[]`.
 */
export function _grammarAvailableForTests(language: SupportedLanguage): boolean {
  return resolveWebTreeSitterWasm() !== null && resolveGrammarPath(LANGUAGE_TO_GRAMMAR_PKG[language]) !== null;
}
