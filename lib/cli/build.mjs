// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import * as esbuild from "esbuild";
import { chmodSync, readFileSync } from "node:fs";

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
