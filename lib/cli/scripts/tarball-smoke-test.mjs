#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Tarball smoke test — Phase 6 (distribution).
 *
 * Verifies that the published @kodela/cli npm tarball:
 *   1. Builds cleanly (delegated to `pnpm run build`).
 *   2. Packs to a single .tgz with the expected file set + no source leakage.
 *   3. Installs into a fresh tmpdir with NO repo context.
 *   4. The bundled `kodela` bin runs `--version` and `--help` end-to-end.
 *
 * Exits non-zero on any failure. The release GitHub Action invokes this before
 * `npm publish` so a broken tarball never reaches the registry.
 *
 * Usage: pnpm --filter @kodela/cli run smoke
 */

import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, statSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(HERE, "..");

function step(msg) {
  process.stdout.write(`▶ ${msg}\n`);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8", ...opts }).toString().trim();
}

function fail(msg) {
  process.stderr.write(`✖ ${msg}\n`);
  process.exit(1);
}

// ── 1. Build ───────────────────────────────────────────────────────────────
step("Build CLI bundles");
try {
  execFileSync("node", ["build.mjs"], { cwd: CLI_ROOT, stdio: "inherit" });
} catch (err) {
  fail(`build failed: ${err instanceof Error ? err.message : String(err)}`);
}

const requiredBundles = ["dist/bin.cjs", "dist/index.cjs", "dist/mcp-server.cjs"];
for (const f of requiredBundles) {
  const p = path.join(CLI_ROOT, f);
  if (!existsSync(p)) fail(`expected bundle missing: ${f}`);
  const size = statSync(p).size;
  if (size < 100_000) fail(`bundle ${f} is suspiciously small (${size} bytes) — likely an empty/broken build`);
}

// ── 2. Pack + inspect tarball contents ─────────────────────────────────────
step("Pack tarball and inspect contents");
let tarballName;
try {
  const out = execSync("npm pack --json", { cwd: CLI_ROOT, encoding: "utf8" });
  const parsed = JSON.parse(out);
  tarballName = parsed[0]?.filename;
  if (!tarballName) fail("npm pack returned no filename");
} catch (err) {
  fail(`npm pack failed: ${err instanceof Error ? err.message : String(err)}`);
}

const tarballPath = path.join(CLI_ROOT, tarballName);
if (!existsSync(tarballPath)) fail(`tarball not at expected path: ${tarballPath}`);

// List tarball contents and assert no source files leak in.
const tarContents = run("tar", ["-tzf", tarballPath]).split("\n").map((s) => s.trim()).filter(Boolean);
const FORBIDDEN_PATTERNS = [
  /\.ts$/,            // raw TypeScript source — bundles are cjs only
  /\.test\./,         // test files
  /node_modules\//,   // accidental node_modules inclusion
  /\.kodela\//,       // local Kodela state
  /\.git\//,          // git internals
  /\.env/,            // env files (any *.env*)
  /tsconfig.*\.json/, // tsconfig variants
];
const leaks = [];
for (const entry of tarContents) {
  for (const rx of FORBIDDEN_PATTERNS) {
    if (rx.test(entry)) leaks.push({ entry, pattern: rx.source });
  }
}
if (leaks.length > 0) {
  for (const { entry, pattern } of leaks) {
    process.stderr.write(`  forbidden in tarball: ${entry} (matched ${pattern})\n`);
  }
  fail(`tarball contains ${leaks.length} forbidden file(s) — review package.json#files`);
}

// Assert REQUIRED files present.
const REQUIRED_IN_TARBALL = [
  "package/dist/bin.cjs",
  "package/dist/index.cjs",
  "package/dist/mcp-server.cjs",
  "package/README.md",
  "package/package.json",
];
const tarSet = new Set(tarContents);
for (const required of REQUIRED_IN_TARBALL) {
  if (!tarSet.has(required)) fail(`tarball missing required file: ${required}`);
}

step(`Tarball OK: ${tarContents.length} files, ${(statSync(tarballPath).size / 1e6).toFixed(2)} MB`);

// ── 3. Install into a fresh tmpdir and smoke-test the bin ──────────────────
step("Install tarball into clean tmpdir + smoke test `kodela` bin");
const playground = mkdtempSync(path.join(tmpdir(), "kodela-cli-smoke-"));
try {
  // Copy the tarball into the playground so npm install can find it without
  // an absolute path containing repo-root state.
  const tarballInPlayground = path.join(playground, tarballName);
  copyFileSync(tarballPath, tarballInPlayground);

  run("npm", ["init", "-y"], { cwd: playground });
  run("npm", ["install", `./${tarballName}`], { cwd: playground });

  // bin: package.json declares bin.kodela → ./dist/bin.cjs
  const binPath = path.join(playground, "node_modules", ".bin", "kodela");
  if (!existsSync(binPath)) fail(`expected bin link missing: ${binPath}`);

  const version = run(binPath, ["--version"]);
  if (!/^\d+\.\d+\.\d+/.test(version)) fail(`unexpected version output: "${version}"`);

  const help = run(binPath, ["--help"]);
  if (!help.includes("Usage: kodela")) fail("--help output missing 'Usage: kodela' header");

  // Regression guard: `embed` and `search` must be TOP-LEVEL commands. A
  // commander chaining slip (`.command("connect").action(...).command("embed")`)
  // silently nests them as subcommands, making `kodela embed`/`kodela search`
  // unreachable in the published bin — which --version/--help alone won't catch.
  for (const cmd of ["embed", "search"]) {
    const re = new RegExp(`^\\s*${cmd}\\b`, "m");
    if (!re.test(help)) {
      fail(`--help does not list top-level command "${cmd}" — it may be mis-nested as a subcommand`);
    }
  }

  step(`Bin smoke OK: --version → ${version}`);

  // ── 4. Offline embed/search path from the installed artifact ──────────────
  // The privacy-first default (`auto`) must degrade to the dependency-free hash
  // embedder when @huggingface/transformers is absent (it is, in this clean
  // install). This is what keeps semantic search from breaking for every
  // Community user the moment they `npm i -g @kodela/cli`.
  step("Offline embed/search in a clean repo (hash-embedder fallback)");
  const repoDir = path.join(playground, "repo");
  mkdirSync(repoDir, { recursive: true });
  run(binPath, ["init"], { cwd: repoDir });

  const embedOut = run(binPath, ["embed", "-o", "json"], { cwd: repoDir });
  let embed;
  try {
    embed = JSON.parse(embedOut);
  } catch {
    fail(`kodela embed did not return JSON: ${embedOut}`);
  }
  if (!embed.degraded) {
    fail(`expected the hash-embedder fallback (degraded=true) with no ONNX runtime, got: ${embedOut}`);
  }
  if (typeof embed.embedderId !== "string" || !embed.embedderId.startsWith("local-hash")) {
    fail(`expected a local-hash embedderId, got: ${embed.embedderId}`);
  }

  const searchOut = run(binPath, ["search", "auth token", "--semantic", "-o", "json"], { cwd: repoDir });
  let search;
  try {
    search = JSON.parse(searchOut);
  } catch {
    fail(`kodela search --semantic did not return JSON: ${searchOut}`);
  }
  if (!Array.isArray(search.hits)) {
    fail(`kodela search --semantic returned no hits array: ${searchOut}`);
  }

  step(`Offline embed/search OK: embedder=${embed.embedderId}, search returned ${search.hits.length} hit(s)`);
} finally {
  rmSync(playground, { recursive: true, force: true });
  // Leave the tarball at CLI_ROOT so CI uploads it as an artifact; the release
  // workflow can consume it directly instead of re-packing.
}

process.stdout.write("\n✓ tarball smoke test passed\n");
