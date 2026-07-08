// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import * as esbuild from "esbuild";
import { chmodSync, readFileSync, cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

// Inject the package.json version at build time so `kodela --version` always
// matches what npm published.  Source code reads `process.env.__KODELA_CLI_VERSION__`
// (declared in config/loader.ts) which esbuild's `define` replaces with the
// real string literal — no runtime dep on reading package.json at startup.
const PKG_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

// We emit CJS, but bundled ESM dependencies reference `import.meta.url` (e.g.
// `createRequire(import.meta.url)`). In a CJS bundle that evaluates to undefined
// and throws at load. esbuild's `define` only accepts identifiers/literals (not
// expressions), so we declare a shim in the banner and point `import.meta.url`
// at it — making every command (embed, search, watch, …) actually run as
// `node dist/bin.cjs`.
const importMetaShim =
  "const importMetaUrl = require('node:url').pathToFileURL(__filename).href;";
const define = {
  "import.meta.url": "importMetaUrl",
  "process.env.__KODELA_CLI_VERSION__": JSON.stringify(PKG_VERSION),
};

await esbuild.build({
  entryPoints: ["src/bin.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/bin.cjs",
  banner: { js: "#!/usr/bin/env node\n" + importMetaShim },
  define,
  sourcemap: true,
});

chmodSync("dist/bin.cjs", 0o755);

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/index.cjs",
  banner: { js: importMetaShim },
  define,
  sourcemap: true,
});

// Bundle the MCP server alongside the CLI so the published package is
// self-contained — `kodela mcp serve` runs this, and `kodela connect --npx`
// writes an entry that launches it via `npx`. node:sqlite is a builtin;
// typescript is the lazy AST parser (resolved at runtime where present).
await esbuild.build({
  entryPoints: ["../../artifacts/mcp-server/src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/mcp-server.cjs",
  banner: { js: importMetaShim },
  define,
  external: ["node:sqlite", "typescript"],
  sourcemap: true,
});

console.log(`Build complete: dist/bin.cjs, dist/index.cjs, dist/mcp-server.cjs (version ${PKG_VERSION})`);

// ── Copy tree-sitter WASM files into dist/ ─────────────────────────────────
// The bundled CLI uses require.resolve("web-tree-sitter/web-tree-sitter.wasm")
// to locate the WASM runtime at runtime. We copy the WASM files from
// node_modules into dist/ so they ship in the npm tarball and are resolvable
// after npm install.
//
// In a pnpm monorepo these packages live as transitive deps of @kodela/core.
// We resolve them from @kodela/core's own node_modules via a require chain.

import { fileURLToPath } from "node:url";
import { resolve as pathResolve, dirname } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve from @kodela/core package which directly depends on web-tree-sitter
const coreDir = pathResolve(__dirname, "..", "core");
const reqFromCore = createRequire(pathResolve(coreDir, "package.json"));

mkdirSync("dist", { recursive: true });

// Copy the main tree-sitter runtime WASM
try {
  const wasmSrc = reqFromCore.resolve("web-tree-sitter/web-tree-sitter.wasm");
  cpSync(wasmSrc, "dist/web-tree-sitter.wasm");
  console.log("Copied: dist/web-tree-sitter.wasm");
} catch {
  console.warn("Warning: could not copy web-tree-sitter.wasm (optional dep not installed)");
}

// Copy per-language grammar WASM files
const grammars = [
  ["@lumis-sh/wasm-typescript", "tree-sitter-typescript.wasm"],
  ["@lumis-sh/wasm-tsx",        "tree-sitter-tsx.wasm"],
  ["@lumis-sh/wasm-python",     "tree-sitter-python.wasm"],
  ["@lumis-sh/wasm-go",         "tree-sitter-go.wasm"],
  ["@lumis-sh/wasm-rust",       "tree-sitter-rust.wasm"],
  ["@lumis-sh/wasm-java",       "tree-sitter-java.wasm"],
  ["@lumis-sh/wasm-bash",       "tree-sitter-bash.wasm"],
];
for (const [pkg, wasm] of grammars) {
  try {
    const src = reqFromCore.resolve(`${pkg}/${wasm}`);
    cpSync(src, `dist/${wasm}`);
    console.log(`Copied: dist/${wasm}`);
  } catch {
    // Grammar packages are optional — skip silently if not installed
  }
}
