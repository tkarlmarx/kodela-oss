// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Invariant: MCP capture is FREE by design (internal design note).
 *
 * The capture/annotation/decision/graph MCP tools must never be gated behind a
 * license — capture is what builds the data moat, so it stays free. Monetization
 * lives at the API/dashboard layer (requireFeature / requireDashboardLicense),
 * NOT in the MCP server.
 *
 * This test fails if any MCP-server source file imports the license layer. If a
 * future tool is *intentionally* gated, that is a deliberate product decision —
 * update this test in the same change so the choice is explicit and reviewed,
 * never accidental.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = here; // artifacts/mcp-server/src

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|mts|js|mjs)$/.test(entry) && !/\.test\.[mc]?[tj]s$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// Patterns that indicate license-gating crept into the capture layer.
const FORBIDDEN = [
  /\bloadLicense\b/,
  /\blicenseHasFeature\b/,
  /\brequireFeature\b/,
  /\brequireDashboardLicense\b/,
  /\bhasFeature\s*\(/,
];

test("no MCP-server source imports or calls the license-gating layer", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC_ROOT)) {
    const text = readFileSync(file, "utf-8");
    for (const re of FORBIDDEN) {
      if (re.test(text)) {
        offenders.push(`${path.relative(SRC_ROOT, file)} matched ${re}`);
        break;
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `MCP capture must stay free — license gating found in:\n${offenders.join("\n")}\n` +
      `If gating a tool is intentional, update capture-free.invariant.test.ts deliberately.`,
  );
});
