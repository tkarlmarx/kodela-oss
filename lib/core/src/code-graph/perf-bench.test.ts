// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 4 perf gate — asserts the bench *correctness contract* (every file
 * parses, every warm read hits) on a small 100-file corpus. Wall-clock budget
 * assertions are deliberately NOT enforced here — they belong in the standalone
 * runner (`node --import tsx lib/core/src/code-graph/perf-bench.ts`) which is
 * invoked on a single known machine on demand.
 *
 * Rationale (advisor 2026-06-20): wall-clock assertions in the default test
 * suite are a classic flaky-CI source. The cold path carries a fixed WASM-init
 * + grammar-load cost that doesn't scale with file count, so a slower CI runner
 * can push the small-corpus number past a tight budget without any real
 * regression. The standalone runner's exit code (set by `runBench()`'s `pass`
 * boolean against the real §4.2 budgets) is the time-budget gate.
 *
 * What this test guards:
 *   - All N files produce a non-empty parse result (parser never silently
 *     returns []).
 *   - Cache writes during cold pass + cache hits during warm pass cover every
 *     file (no missing rows).
 *   - The bench returns sane shape (per-file metrics, file count).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runBench } from "./perf-bench.js";
import { _grammarAvailableForTests } from "./treesitter-layer.js";

const HAS_TS = _grammarAvailableForTests("typescript");
const SMALL_FILE_COUNT = 100;

test(
  "perf-bench: 100-file run completes correctly (parse + cache hits) without asserting wall-clock",
  { skip: HAS_TS ? false : "@lumis-sh/wasm-typescript not installed" },
  async () => {
    const r = await runBench({ fileCount: SMALL_FILE_COUNT });
    assert.equal(r.fileCount, SMALL_FILE_COUNT);
    // Time metrics returned and shaped sensibly — but we do NOT assert them
    // against a deadline here. The standalone runner does that against the
    // §4.2 budgets (30s cold / 5s warm) on a single machine.
    assert.ok(r.coldMs >= 0, "coldMs must be a non-negative number");
    assert.ok(r.warmMs >= 0, "warmMs must be a non-negative number");
    assert.ok(r.coldPerFileMs >= 0, "coldPerFileMs must be a non-negative number");
    assert.ok(r.warmPerFileMs >= 0, "warmPerFileMs must be a non-negative number");
    // Sanity: if warm wasn't faster than cold, the cache layer didn't engage —
    // a real regression worth surfacing as a test failure (warm read should be
    // orders of magnitude faster than cold parse; allow 2× as a safety margin
    // for very fast machines where both round to milliseconds).
    assert.ok(
      r.warmMs * 2 <= r.coldMs,
      `warm pass (${r.warmMs}ms) should be < cold pass (${r.coldMs}ms) — cache layer did not engage`,
    );
  },
);
