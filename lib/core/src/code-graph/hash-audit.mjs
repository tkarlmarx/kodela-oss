// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 4.5 prerequisite — regex-vs-Tree-sitter astAnchor compatibility audit.
 *
 * **Run 2026-06-25 result (200 real TS files, 845 paired nodes):**
 *   - bodyHash match rate:    0 / 845  (0.00 %)
 *   - paramCount match rate:  841 / 845 (99.53 %)
 *
 * Conclusion: the two extractors disagree on body slicing for every single
 * function — the regex layer walks brace depth and often terminates the body
 * early; Tree-sitter follows AST boundaries. As a result, a direct swap
 * silently regresses the `bodyHash` matching tier in `mapWithAstLayer` for
 * 100 % of persisted entries on the first post-swap heal. Per the user's
 * 2026-06-25 decision, Phase 4.5 stays deferred until a re-anchor migration
 * strategy is agreed (see doc 23 §Phase 4.5).
 *
 * **Purpose of keeping this file in-tree:** any future attempt to revisit the
 * swap should re-run it to confirm the incompatibility still holds (the
 * regex patterns, the Tree-sitter grammars, and the `normaliseBody`
 * algorithm all evolve independently).  If a future run reports a high
 * match rate the heal-engine deferral can be reconsidered.
 *
 * Usage:
 *   node --import tsx lib/core/src/code-graph/hash-audit.mjs
 *
 * Output: a single JSON object on stdout summarising the audit.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");

// Reuse the production normaliseBody + paramCount logic by importing from the
// transpiled engine source — keeps the audit honest against what mapWithAstLayer
// actually computes.
const astLayerModule = await import(path.join(REPO_ROOT, "lib/core/src/engine/ast-layer.ts"));
const { computeBodyHash } = astLayerModule;

// We need access to extractAstNodes + countParams, which are not exported. The
// simplest workaround: re-implement the body-hash slice + countParams as the
// regex layer does, side-by-side with the Tree-sitter version, so the audit
// is self-contained.

function normaliseBodyLocal(lines) {
  return lines
    .join("\n")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/#[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function hashBody(lines) {
  return createHash("sha256").update(normaliseBodyLocal(lines)).digest("hex");
}

function countParamsLocal(signatureLine) {
  const open = signatureLine.indexOf("(");
  if (open === -1) return 0;
  let depth = 0, commas = 0, hasContent = false;
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
    if (depth === 1 && ch !== "(" && ch !== " " && ch !== "\t") hasContent = true;
    if (depth === 1 && ch === ",") commas++;
  }
  if (!hasContent) return 0;
  return commas + 1;
}

// Reproduces the regex layer's extractAstNodes exactly (kept in lockstep with
// lib/core/src/engine/ast-layer.ts).
const FUNCTION_PATTERNS = [
  { kind: "function", pattern: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/ },
  { kind: "method", pattern: /^\s+(?:(?:public|private|protected|static|async|override)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(/ },
  { kind: "class", pattern: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/ },
  { kind: "function", pattern: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*\S+\s*)?=\s*(?:async\s+)?\(/ },
  { kind: "function", pattern: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*\S+\s*)?=\s*(?:async\s+)?(?:\w+|\([^)]*\))\s*=>/ },
];

function extractAstNodesRegex(content) {
  const lines = content.split("\n");
  const braceDepths = new Array(lines.length).fill(0);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    braceDepths[i] = depth;
  }
  const nodes = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    for (const { kind, pattern } of FUNCTION_PATTERNS) {
      const match = pattern.exec(line);
      if (match && match[1] !== undefined) {
        const name = match[1];
        const startDepth = braceDepths[i] ?? 0;
        let endLine = i;
        for (let j = i + 1; j < lines.length; j++) {
          if ((braceDepths[j] ?? 0) <= startDepth) {
            endLine = j;
            break;
          }
          endLine = j;
        }
        const bodyLines = lines.slice(i + 1, endLine + 1);
        const paramCount = countParamsLocal(line);
        nodes.push({
          kind, name,
          startLine: i + 1,
          endLine: endLine + 1,
          bodyLines, paramCount,
          signatureLine: line,
        });
        break;
      }
    }
  }
  return nodes;
}

// Tree-sitter layer.
const { parseFunctions, _grammarAvailableForTests } = await import(
  path.join(REPO_ROOT, "lib/core/src/code-graph/treesitter-layer.ts")
);

function extractBodyLinesTreeSitter(content, fn) {
  // CodeGraphFunction.startLine / endLine are 1-based inclusive.
  // Regex layer's bodyLines = lines.slice(signatureRow0 + 1, closingRow0 + 1)
  //                        = lines.slice(startLine_1based, endLine_1based)  (after re-indexing)
  // So the matching Tree-sitter body slice is lines.slice(startLine, endLine).
  const lines = content.split("\n");
  return lines.slice(fn.startLine, fn.endLine);
}

function getSignatureLine(content, startLine1Based) {
  const lines = content.split("\n");
  return (lines[startLine1Based - 1] ?? "").trimEnd();
}

// Discover sample files: every .ts file in lib/core/src, lib/cli/src, artifacts/.
async function findTsFiles(dir, acc = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git" || e.name === ".kodela") continue;
      await findTsFiles(p, acc);
    } else if (e.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx")) && !p.endsWith(".test.ts") && !p.endsWith(".test.tsx") && !p.endsWith(".d.ts")) {
      acc.push(p);
    }
  }
  return acc;
}

const SAMPLE_DIRS = [
  path.join(REPO_ROOT, "lib/core/src"),
  path.join(REPO_ROOT, "lib/cli/src"),
  path.join(REPO_ROOT, "artifacts/api-server/src"),
];

if (!_grammarAvailableForTests("typescript")) {
  console.log(JSON.stringify({ error: "@lumis-sh/wasm-typescript not installed" }));
  process.exit(2);
}

const allFiles = [];
for (const d of SAMPLE_DIRS) await findTsFiles(d, allFiles);
// Sample down to 200 files (deterministic by sorted order).
allFiles.sort();
const sample = allFiles.slice(0, 200);

let nodesRegex = 0, nodesTreeSitter = 0, paired = 0;
let bodyHashMatches = 0, bodyHashMisses = 0;
let paramCountMatches = 0, paramCountMisses = 0;
const sampleMisses = [];

for (const file of sample) {
  const content = await fs.readFile(file, "utf8");
  const regex = extractAstNodesRegex(content);
  const ts = await parseFunctions(file, content);

  // Tree-sitter emits class/method/function/arrow/generator kinds; regex emits
  // function/method/class/block. For pairing we map ts.arrow → "function" and
  // ts.generator → "function" to match the regex taxonomy (the swap adapter
  // will do the same mapping in production).
  const tsAsAstNodes = ts.map((fn) => ({
    kind: fn.kind === "method" ? "method" : fn.kind === "class" ? "class" : "function",
    name: fn.name,
    startLine: fn.startLine,
    endLine: fn.endLine,
    bodyLines: extractBodyLinesTreeSitter(content, fn),
    paramCount: countParamsLocal(getSignatureLine(content, fn.startLine)),
  }));

  nodesRegex += regex.length;
  nodesTreeSitter += tsAsAstNodes.length;

  // Pair by (kind, name) — accept first match.  This is what mapWithAstLayer
  // does (per-file name lookup before any further matching).
  const tsByKey = new Map();
  for (const node of tsAsAstNodes) {
    const key = `${node.kind}:${node.name}`;
    if (!tsByKey.has(key)) tsByKey.set(key, node);
  }

  for (const rNode of regex) {
    const key = `${rNode.kind}:${rNode.name}`;
    const tNode = tsByKey.get(key);
    if (!tNode) continue;
    paired++;

    const rHash = hashBody(rNode.bodyLines);
    const tHash = hashBody(tNode.bodyLines);
    if (rHash === tHash) bodyHashMatches++;
    else {
      bodyHashMisses++;
      if (sampleMisses.length < 5) {
        sampleMisses.push({
          file: path.relative(REPO_ROOT, file),
          kind: rNode.kind, name: rNode.name,
          regexLines: `${rNode.startLine}-${rNode.endLine} (body ${rNode.bodyLines.length}L)`,
          tsLines:    `${tNode.startLine}-${tNode.endLine} (body ${tNode.bodyLines.length}L)`,
          regexBodyPreview: rNode.bodyLines.slice(0, 2).join(" / "),
          tsBodyPreview:    tNode.bodyLines.slice(0, 2).join(" / "),
        });
      }
    }
    if (rNode.paramCount === tNode.paramCount) paramCountMatches++;
    else paramCountMisses++;
  }
}

const summary = {
  filesScanned: sample.length,
  totalNodesRegex: nodesRegex,
  totalNodesTreeSitter: nodesTreeSitter,
  pairedByKindAndName: paired,
  bodyHashMatchRate: paired === 0 ? null : +(bodyHashMatches / paired).toFixed(4),
  paramCountMatchRate: paired === 0 ? null : +(paramCountMatches / paired).toFixed(4),
  bodyHashMatches, bodyHashMisses,
  paramCountMatches, paramCountMisses,
  sampleMisses,
};
console.log(JSON.stringify(summary, null, 2));
