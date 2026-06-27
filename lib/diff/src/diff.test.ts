// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeDiff, isLargeInsertion, isLikelyAIChange, isPossibleRewrite, similarityRatio } from "./index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lines(...args: string[]): string {
  return args.join("\n");
}

// ─── Identical files ──────────────────────────────────────────────────────────

describe("identical files", () => {
  it("returns all empty arrays for identical non-empty content", () => {
    const r = computeDiff({ oldContent: "a\nb\nc", newContent: "a\nb\nc" });
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.modified, []);
    assert.deepEqual(r.moved, []);
  });

  it("returns zero-change stats for identical content", () => {
    const r = computeDiff({ oldContent: "a\nb\nc", newContent: "a\nb\nc" });
    assert.equal(r.stats.addedLines, 0);
    assert.equal(r.stats.removedLines, 0);
    assert.equal(r.stats.modifiedLines, 0);
    assert.equal(r.stats.changeDensity, 0);
    assert.equal(r.stats.totalLinesOld, 3);
    assert.equal(r.stats.totalLinesNew, 3);
  });

  it("returns all empty arrays for two empty strings", () => {
    const r = computeDiff({ oldContent: "", newContent: "" });
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.modified, []);
    assert.deepEqual(r.moved, []);
    assert.equal(r.stats.totalLinesOld, 0);
    assert.equal(r.stats.totalLinesNew, 0);
  });
});

// ─── Empty → non-empty (single added hunk) ────────────────────────────────────

describe("empty to non-empty", () => {
  it("produces a single added hunk covering all new lines", () => {
    const r = computeDiff({ oldContent: "", newContent: "a\nb\nc" });
    assert.equal(r.added.length, 1);
    assert.deepEqual(r.added[0]!.newRange, [1, 3]);
    assert.equal(r.removed.length, 0);
    assert.equal(r.modified.length, 0);
    assert.equal(r.stats.addedLines, 3);
    assert.equal(r.stats.totalLinesOld, 0);
  });

  it("changeDensity is 0 when old is empty", () => {
    const r = computeDiff({ oldContent: "", newContent: "x" });
    assert.equal(r.stats.changeDensity, 0);
  });
});

// ─── Non-empty → empty (single removed hunk) ──────────────────────────────────

describe("non-empty to empty", () => {
  it("produces a single removed hunk covering all old lines", () => {
    const r = computeDiff({ oldContent: "a\nb\nc", newContent: "" });
    assert.equal(r.removed.length, 1);
    assert.deepEqual(r.removed[0]!.oldRange, [1, 3]);
    assert.equal(r.added.length, 0);
    assert.equal(r.modified.length, 0);
    assert.equal(r.stats.removedLines, 3);
    assert.equal(r.stats.totalLinesNew, 0);
  });

  it("changeDensity is 1 when all lines removed", () => {
    const r = computeDiff({ oldContent: "a\nb", newContent: "" });
    assert.equal(r.stats.changeDensity, 1);
  });
});

// ─── Single-line changes ──────────────────────────────────────────────────────

describe("single-line changes", () => {
  it("detects a single-line addition at the end", () => {
    const r = computeDiff({ oldContent: "a\nb", newContent: "a\nb\nc" });
    assert.equal(r.added.length, 1);
    assert.deepEqual(r.added[0]!.newRange, [3, 3]);
    assert.equal(r.removed.length, 0);
  });

  it("detects a single-line removal at the start", () => {
    const r = computeDiff({ oldContent: "a\nb\nc", newContent: "b\nc" });
    assert.equal(r.removed.length, 1);
    assert.deepEqual(r.removed[0]!.oldRange, [1, 1]);
    assert.equal(r.added.length, 0);
  });

  it("detects a single-line modification", () => {
    const r = computeDiff({ oldContent: "a\nb\nc", newContent: "a\nX\nc" });
    assert.equal(r.modified.length, 1);
    assert.deepEqual(r.modified[0]!.oldRange, [2, 2]);
    assert.deepEqual(r.modified[0]!.newRange, [2, 2]);
  });
});

// ─── Multi-line changes ───────────────────────────────────────────────────────

describe("multi-line changes", () => {
  it("detects a multi-line block added in the middle", () => {
    const r = computeDiff({ oldContent: "a\ne", newContent: "a\nb\nc\nd\ne" });
    assert.equal(r.added.length, 1);
    assert.deepEqual(r.added[0]!.newRange, [2, 4]);
  });

  it("detects a multi-line removal", () => {
    const r = computeDiff({ oldContent: "a\nb\nc\nd\ne", newContent: "a\ne" });
    assert.equal(r.removed.length, 1);
    assert.deepEqual(r.removed[0]!.oldRange, [2, 4]);
  });

  it("detects separate added and removed blocks", () => {
    const old = lines("a", "b", "c", "d", "e");
    const next = lines("a", "X", "c", "Y", "e");
    const r = computeDiff({ oldContent: old, newContent: next });
    assert.equal(r.modified.length, 2);
    assert.deepEqual(r.modified[0]!.oldRange, [2, 2]);
    assert.deepEqual(r.modified[1]!.oldRange, [4, 4]);
  });
});

// ─── Full rewrite ─────────────────────────────────────────────────────────────

describe("full rewrite", () => {
  it("treats completely different content as removed + added", () => {
    const r = computeDiff({ oldContent: "a\nb", newContent: "c\nd" });
    const totalChanged = r.added.length + r.removed.length + r.modified.length;
    assert(totalChanged > 0, "should have changes");
    assert.equal(r.moved.length, 0);
  });

  it("changeDensity > 0.9 for near-complete rewrite", () => {
    const old = Array.from({ length: 10 }, (_, i) => `old${i}`).join("\n");
    const next = Array.from({ length: 10 }, (_, i) => `new${i}`).join("\n");
    const r = computeDiff({ oldContent: old, newContent: next });
    assert(r.stats.changeDensity > 0.9);
  });
});

// ─── Whitespace handling ──────────────────────────────────────────────────────

describe("ignoreWhitespace option", () => {
  it("emits a modified hunk for whitespace-only change when option is false (default)", () => {
    const r = computeDiff({ oldContent: "a\n  b\nc", newContent: "a\nb\nc" });
    const changed = r.modified.length + r.removed.length + r.added.length;
    assert(changed > 0, "should report the whitespace change");
  });

  it("ignores whitespace-only line differences when option is true", () => {
    const r = computeDiff(
      { oldContent: "a\n  b\nc", newContent: "a\nb\nc" },
      { ignoreWhitespace: true },
    );
    assert.equal(r.modified.length, 0);
    assert.equal(r.added.length, 0);
    assert.equal(r.removed.length, 0);
  });

  it("does not ignore meaningful changes even with ignoreWhitespace: true", () => {
    const r = computeDiff(
      { oldContent: "a\nb\nc", newContent: "a\nX\nc" },
      { ignoreWhitespace: true },
    );
    assert.equal(r.modified.length, 1);
  });

  it("ignoreWhitespace uses trim(): internal whitespace differences are still reported", () => {
    // "a  b" vs "a b" differs only in internal whitespace.
    // trim() removes leading/trailing space only, so internal changes ARE reported.
    const r = computeDiff(
      { oldContent: "a  b\nc", newContent: "a b\nc" },
      { ignoreWhitespace: true },
    );
    assert(
      r.modified.length > 0 || r.added.length > 0 || r.removed.length > 0,
      "internal whitespace changes must still be reported with ignoreWhitespace:true",
    );
  });
});

// ─── Move detection ───────────────────────────────────────────────────────────

describe("move detection", () => {
  it("detects a block that moved from the top to the bottom", () => {
    const old = lines("moved_line", "a", "b", "c");
    const next = lines("a", "b", "c", "moved_line");
    const r = computeDiff({ oldContent: old, newContent: next });
    assert.equal(r.moved.length, 1);
    assert.equal(r.moved[0]!.type, "moved");
    assert.ok(r.moved[0]!.oldRange, "oldRange should exist");
    assert.ok(r.moved[0]!.newRange, "newRange should exist");
  });

  it("moved hunk is not duplicated in added or removed arrays", () => {
    const old = lines("moved_line", "a", "b");
    const next = lines("a", "b", "moved_line");
    const r = computeDiff({ oldContent: old, newContent: next });
    assert.equal(r.moved.length, 1);
    // The moved block should not appear in added or removed
    const hash = r.moved[0]!.contentHash!;
    assert.ok(!r.added.some((h) => h.contentHash === hash));
    assert.ok(!r.removed.some((h) => h.contentHash === hash));
  });

  it("does not incorrectly classify a change as a move when content differs", () => {
    const old = lines("block_A", "x", "y");
    const next = lines("x", "y", "block_B");
    const r = computeDiff({ oldContent: old, newContent: next });
    // block_A and block_B have different content → no move
    assert.equal(r.moved.length, 0);
  });
});

// ─── Large-file fallback ──────────────────────────────────────────────────────

describe("large-file fallback", () => {
  it("uses histogram fallback for files above the threshold", () => {
    const bigOld = Array.from({ length: 5 }, (_, i) => `line${i}`).join("\n");
    const bigNew = Array.from({ length: 5 }, (_, i) => `line${i + 10}`).join("\n");
    // threshold=3 forces histogram path
    const r = computeDiff({ oldContent: bigOld, newContent: bigNew }, { largeFileThreshold: 3 });
    const totalChanged = r.added.length + r.removed.length + r.modified.length;
    assert(totalChanged > 0, "should report changes via histogram path");
  });

  it("histogram: identical content produces no changes", () => {
    const content = Array.from({ length: 5 }, (_, i) => `line${i}`).join("\n");
    const r = computeDiff({ oldContent: content, newContent: content }, { largeFileThreshold: 2 });
    assert.equal(r.added.length + r.removed.length + r.modified.length, 0);
  });

  it("histogram fallback: reversed file produces no overlapping old ranges", () => {
    // All lines unique in both files, but in reversed order — a pathological
    // case that exposed a sort-then-LIS bug where ai was not monotone.
    const r = computeDiff(
      { oldContent: "A\nB\nC", newContent: "C\nB\nA" },
      { largeFileThreshold: 2 },
    );
    const allOld = [...r.removed, ...r.modified].map((h) => h.oldRange!).sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < allOld.length; i++) {
      const prev = allOld[i - 1]!;
      const cur = allOld[i]!;
      assert(cur[0] > prev[1], `oldRange [${cur}] overlaps with [${prev}]`);
    }
  });

  it("histogram fallback: changeDensity is always in [0, 1] for reversed input", () => {
    const r = computeDiff(
      { oldContent: "A\nB\nC", newContent: "C\nB\nA" },
      { largeFileThreshold: 2 },
    );
    assert(r.stats.changeDensity >= 0, "changeDensity must be >= 0");
    assert(r.stats.changeDensity <= 1, `changeDensity must be <= 1, got ${r.stats.changeDensity}`);
  });

  it("histogram fallback: changeDensity is always in [0, 1] for large full rewrite", () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `old_${i}`).join("\n");
    const newLines = Array.from({ length: 20 }, (_, i) => `new_${i}`).join("\n");
    const r = computeDiff({ oldContent: oldLines, newContent: newLines }, { largeFileThreshold: 10 });
    assert(r.stats.changeDensity >= 0);
    assert(r.stats.changeDensity <= 1, `changeDensity must be <= 1, got ${r.stats.changeDensity}`);
  });
});

// ─── Deterministic ordering ───────────────────────────────────────────────────

describe("deterministic ordering", () => {
  it("result arrays are sorted ascending by line number", () => {
    const old = lines("a", "b", "c", "d", "e", "f");
    const next = lines("a", "X", "c", "Y", "e", "Z");
    const r = computeDiff({ oldContent: old, newContent: next });
    const firstLines = r.modified.map((h) => h.oldRange![0]);
    const sorted = [...firstLines].sort((x, y) => x - y);
    assert.deepEqual(firstLines, sorted);
  });

  it("running computeDiff twice on the same input produces identical output", () => {
    const old = lines("a", "b", "c");
    const next = lines("a", "X", "c");
    const r1 = computeDiff({ oldContent: old, newContent: next });
    const r2 = computeDiff({ oldContent: old, newContent: next });
    assert.deepEqual(r1, r2);
  });
});

// ─── Stats ────────────────────────────────────────────────────────────────────

describe("stats", () => {
  it("totalLinesOld and totalLinesNew reflect line counts", () => {
    const r = computeDiff({ oldContent: "a\nb\nc", newContent: "a\nb\nc\nd\ne" });
    assert.equal(r.stats.totalLinesOld, 3);
    assert.equal(r.stats.totalLinesNew, 5);
  });

  it("addedLines matches the lines in added hunks", () => {
    const r = computeDiff({ oldContent: "a\nb", newContent: "a\nb\nc\nd" });
    assert.equal(r.stats.addedLines, 2);
  });

  it("removedLines matches the lines in removed hunks", () => {
    const r = computeDiff({ oldContent: "a\nb\nc\nd", newContent: "a\nb" });
    assert.equal(r.stats.removedLines, 2);
  });

  it("changeDensity = changedLines / totalLinesOld", () => {
    // 3 old lines, 1 removed → density = 1/3
    const r = computeDiff({ oldContent: "a\nb\nc", newContent: "a\nc" });
    assert(Math.abs(r.stats.changeDensity - 1 / 3) < 0.001);
  });

  it("changeDensity is 0 for a pure append (no old lines removed or modified)", () => {
    // Only insertions; the old file's lines are all preserved unchanged.
    // changeDensity = (removedLines + modifiedLines) / totalLinesOld = 0/3 = 0.
    // This is intentional: density measures change to the old file, not insertion volume.
    // Use stats.addedLines or isLargeInsertion() for insertion-heavy detection.
    const r = computeDiff({ oldContent: "a\nb\nc", newContent: "a\nb\nc\nd\ne\nf" });
    assert.equal(r.stats.changeDensity, 0);
    assert.equal(r.stats.addedLines, 3);
  });
});

// ─── contentHash ─────────────────────────────────────────────────────────────

describe("contentHash", () => {
  it("same content produces the same hash", () => {
    const r1 = computeDiff({ oldContent: "a\nb", newContent: "a\nb\nc" });
    const r2 = computeDiff({ oldContent: "x\ny", newContent: "x\ny\nc" });
    assert.equal(r1.added[0]!.contentHash, r2.added[0]!.contentHash);
  });

  it("different content produces different hashes", () => {
    const r1 = computeDiff({ oldContent: "a", newContent: "a\nb" });
    const r2 = computeDiff({ oldContent: "a", newContent: "a\nc" });
    assert.notEqual(r1.added[0]!.contentHash, r2.added[0]!.contentHash);
  });
});

// ─── Classification helpers ───────────────────────────────────────────────────

describe("isLargeInsertion", () => {
  it("returns false when added lines are below the threshold", () => {
    const r = computeDiff({ oldContent: "a", newContent: "a\nb\nc" });
    assert.equal(isLargeInsertion(r, 5), false);
  });

  it("returns false at the exact threshold (not strictly greater)", () => {
    const r = computeDiff({ oldContent: "a", newContent: "a\nb\nc" });
    assert.equal(isLargeInsertion(r, 2), false); // 2 added, threshold=2
  });

  it("returns true when added lines exceed the threshold", () => {
    const r = computeDiff({ oldContent: "a", newContent: "a\nb\nc" });
    assert.equal(isLargeInsertion(r, 1), true); // 2 > 1
  });
});

describe("isPossibleRewrite", () => {
  it("returns false for low changeDensity with default ratio", () => {
    const r = computeDiff({ oldContent: "a\nb\nc\nd\ne", newContent: "a\nb\nc\nd\nX" });
    assert.equal(isPossibleRewrite(r), false); // density = 0.2 < 0.6
  });

  it("returns true for high changeDensity with default ratio", () => {
    const old = Array.from({ length: 5 }, (_, i) => `old${i}`).join("\n");
    const next = Array.from({ length: 5 }, (_, i) => `new${i}`).join("\n");
    const r = computeDiff({ oldContent: old, newContent: next });
    assert.equal(isPossibleRewrite(r), true); // density ≥ 1 > 0.6
  });

  it("respects a custom ratio", () => {
    const r = computeDiff({ oldContent: "a\nb\nc\nd\ne", newContent: "a\nb\nc\nd\nX" });
    assert.equal(isPossibleRewrite(r, 0.1), true); // density ≈ 0.2 > 0.1
  });
});

describe("similarityRatio", () => {
  it("returns 1 for identical content", () => {
    assert.equal(similarityRatio("a\nb\nc", "a\nb\nc"), 1);
  });

  it("returns 0 for completely different content", () => {
    assert.equal(similarityRatio("a\nb", "c\nd"), 0);
  });

  it("returns 1 for two empty strings", () => {
    assert.equal(similarityRatio("", ""), 1);
  });

  it("returns 0 when one side is empty", () => {
    assert.equal(similarityRatio("a\nb", ""), 0);
  });

  it("returns a value strictly between 0 and 1 for partial overlap", () => {
    const ratio = similarityRatio("a\nb\nc\nd", "a\nb\ne\nf");
    assert(ratio > 0 && ratio < 1);
  });

  it("Sørensen–Dice numerator uses deduplicated line sets", () => {
    // "a" appears twice in old but should count once in the set
    const ratio = similarityRatio("a\na\nb", "a\nc");
    const expected = (2 * 1) / (2 + 2); // old set {a,b}, new set {a,c}, intersection {a}
    assert(Math.abs(ratio - expected) < 0.001);
  });
});

describe("isLikelyAIChange", () => {
  it("returns false for a minimal single-line change", () => {
    const r = computeDiff({ oldContent: "a\nb\nc", newContent: "a\nX\nc" });
    assert.equal(isLikelyAIChange(r), false);
  });

  it("returns true for a large insertion with low similarity", () => {
    // 5 base lines preserved; 40 completely new lines appended.
    // Triggers largeInsert (40>20) AND lowSimilarity (shared=5/50 lines, Dice≈0.2<0.4).
    const old = Array.from({ length: 5 }, (_, i) => `base${i}`).join("\n");
    const bigBlock = Array.from({ length: 40 }, (_, i) => `generated${i}`).join("\n");
    const next = old + "\n" + bigBlock;
    const r = computeDiff({ oldContent: old, newContent: next });
    assert.equal(isLikelyAIChange(r), true);
  });
});

// ─── Fuzzy move detection ─────────────────────────────────────────────────────

describe("fuzzy move detection", () => {
  // Test fixture: a 3-line block moves from the top to the bottom of the file
  // and has one line changed (block_C_old → block_C_new).
  // Dice similarity = 4/6 ≈ 0.667
  //   old set: {unique_prefix_A, unique_prefix_B, unique_prefix_C_old}
  //   new set: {unique_prefix_A, unique_prefix_B, unique_prefix_C_new}
  //   intersection: {unique_prefix_A, unique_prefix_B} → 2 items
  const OLD = lines("unique_prefix_A", "unique_prefix_B", "unique_prefix_C_old", "separator", "other1", "other2");
  const NEW = lines("separator", "other1", "other2", "unique_prefix_A", "unique_prefix_B", "unique_prefix_C_new");

  it("classifies a near-identical relocated block as moved at relaxed threshold", () => {
    const r = computeDiff({ oldContent: OLD, newContent: NEW }, { fuzzyMoveThreshold: 0.6 });
    assert.equal(r.moved.length, 1, "should have exactly one moved hunk");
    assert.equal(r.moved[0]!.type, "moved");
    assert.ok(r.moved[0]!.oldRange, "moved hunk must have oldRange");
    assert.ok(r.moved[0]!.newRange, "moved hunk must have newRange");
    assert.equal(r.removed.length, 0, "removed block must be consumed by fuzzy move");
    assert.equal(r.added.length, 0, "added block must be consumed by fuzzy move");
  });

  it("keeps near-identical block as remove+add when similarity is below threshold", () => {
    const r = computeDiff({ oldContent: OLD, newContent: NEW }, { fuzzyMoveThreshold: 0.7 });
    assert.equal(r.moved.length, 0, "no fuzzy move at threshold above similarity");
    assert.equal(r.removed.length, 1, "removed hunk must remain");
    assert.equal(r.added.length, 1, "added hunk must remain");
  });

  it("default threshold (1.0) does not promote near-identical blocks to moved", () => {
    const r = computeDiff({ oldContent: OLD, newContent: NEW });
    assert.equal(r.moved.length, 0, "default exact-only threshold must not fire on near-move");
    assert.equal(r.removed.length, 1);
    assert.equal(r.added.length, 1);
  });

  it("exact move is still detected correctly when fuzzyMoveThreshold is set", () => {
    const old = lines("exact_moved_line", "a", "b", "c");
    const next = lines("a", "b", "c", "exact_moved_line");
    const r = computeDiff({ oldContent: old, newContent: next }, { fuzzyMoveThreshold: 0.5 });
    assert.equal(r.moved.length, 1);
    assert.equal(r.moved[0]!.type, "moved");
    assert.equal(r.removed.length, 0);
    assert.equal(r.added.length, 0);
  });

  it("fuzzy moved hunk is not duplicated in added or removed arrays", () => {
    const r = computeDiff({ oldContent: OLD, newContent: NEW }, { fuzzyMoveThreshold: 0.6 });
    assert.equal(r.moved.length, 1);
    const oldRange = r.moved[0]!.oldRange!;
    assert.ok(!r.removed.some((h) => h.oldRange?.[0] === oldRange[0]));
    assert.ok(!r.added.some((h) => h.newRange?.[0] === r.moved[0]!.newRange?.[0]));
  });

  it("fuzzy move detection is deterministic across two runs", () => {
    const r1 = computeDiff({ oldContent: OLD, newContent: NEW }, { fuzzyMoveThreshold: 0.6 });
    const r2 = computeDiff({ oldContent: OLD, newContent: NEW }, { fuzzyMoveThreshold: 0.6 });
    assert.deepEqual(r1, r2);
  });

  it("movedLines stat equals old-side line span of fuzzy moved hunk", () => {
    const r = computeDiff({ oldContent: OLD, newContent: NEW }, { fuzzyMoveThreshold: 0.6 });
    assert.equal(r.moved.length, 1);
    const [start, end] = r.moved[0]!.oldRange!;
    assert.equal(r.stats.movedLines, end - start + 1);
    assert.equal(r.stats.movedLines, 3);
  });

  it("movedLines stat is zero when no moves are detected", () => {
    const r = computeDiff({ oldContent: OLD, newContent: NEW }, { fuzzyMoveThreshold: 0.7 });
    assert.equal(r.stats.movedLines, 0);
  });

  it("movedLines stat counts old-side lines for exact moves", () => {
    const old = lines("moved_line_1", "moved_line_2", "ctx_a", "ctx_b");
    const next = lines("ctx_a", "ctx_b", "moved_line_1", "moved_line_2");
    const r = computeDiff({ oldContent: old, newContent: next });
    assert.equal(r.moved.length, 1);
    const [start, end] = r.moved[0]!.oldRange!;
    assert.equal(r.stats.movedLines, end - start + 1);
    assert.equal(r.stats.movedLines, 2);
  });
});

// ─── Golden snapshot tests (pin full JSON output) ─────────────────────────────
// Hashes are FNV-1a 32-bit over the line content; hardcoded here so the test
// will catch any regression that silently alters the hash function or the
// content routed into each hunk.

describe("golden snapshots", () => {
  it("snapshot: single-line addition at end", () => {
    const r = computeDiff({ oldContent: "alpha\nbeta", newContent: "alpha\nbeta\ngamma" });
    assert.deepEqual(r.added, [{ type: "added", newRange: [3, 3], contentHash: "b0aa7c00" }]);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.modified, []);
    assert.deepEqual(r.moved, []);
    assert.equal(r.stats.totalLinesOld, 2);
    assert.equal(r.stats.totalLinesNew, 3);
    assert.equal(r.stats.addedLines, 1);
    assert.equal(r.stats.removedLines, 0);
    assert.equal(r.stats.modifiedLines, 0);
    assert.equal(r.stats.changeDensity, 0);
    // oldSet={alpha,beta}=2, newSet={alpha,beta,gamma}=3, intersection=2 → Dice=4/5
    assert(Math.abs(r.stats.contentSimilarity - 4 / 5) < 0.001);
  });

  it("snapshot: single-line removal in the middle", () => {
    const r = computeDiff({ oldContent: "a\nb\nc", newContent: "a\nc" });
    assert.deepEqual(r.removed, [{ type: "removed", oldRange: [2, 2], contentHash: "a72c4f3d" }]);
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.modified, []);
    assert.deepEqual(r.moved, []);
    assert.equal(r.stats.totalLinesOld, 3);
    assert.equal(r.stats.totalLinesNew, 2);
    assert.equal(r.stats.removedLines, 1);
    assert.equal(r.stats.addedLines, 0);
    assert.equal(r.stats.modifiedLines, 0);
    assert(Math.abs(r.stats.changeDensity - 1 / 3) < 0.001);
    // oldSet={a,b,c}=3, newSet={a,c}=2, intersection=2 → Dice=4/5
    assert(Math.abs(r.stats.contentSimilarity - 4 / 5) < 0.001);
  });

  it("snapshot: single-line modification", () => {
    const r = computeDiff({ oldContent: "a\nb\nc", newContent: "a\nB\nc" });
    assert.deepEqual(r.modified, [{ type: "modified", oldRange: [2, 2], newRange: [2, 2], contentHash: "220d17a5" }]);
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.moved, []);
    assert.equal(r.stats.totalLinesOld, 3);
    assert.equal(r.stats.totalLinesNew, 3);
    assert.equal(r.stats.modifiedLines, 1);
    assert(Math.abs(r.stats.changeDensity - 1 / 3) < 0.001);
    // oldSet={a,b,c}=3, newSet={a,B,c}=3, intersection={a,c}=2 → Dice=4/6
    assert(Math.abs(r.stats.contentSimilarity - 4 / 6) < 0.001);
  });

  it("snapshot: move detection", () => {
    const old = lines("header", "body", "footer");
    const next = lines("body", "header", "footer");
    const r = computeDiff({ oldContent: old, newContent: next });
    assert.deepEqual(r.moved, [{ type: "moved", oldRange: [1, 1], newRange: [2, 2], contentHash: "2d6662de" }]);
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.modified, []);
    assert.equal(r.stats.totalLinesOld, 3);
    assert.equal(r.stats.totalLinesNew, 3);
    assert.equal(r.stats.changeDensity, 0);
    // all 3 lines shared → Dice=1
    assert.equal(r.stats.contentSimilarity, 1);
  });

  it("snapshot: stats for partial change", () => {
    const old = lines("a", "b", "c", "d", "e");
    const next = lines("a", "b", "X", "d", "e");
    const r = computeDiff({ oldContent: old, newContent: next });
    assert.deepEqual(r.modified, [{ type: "modified", oldRange: [3, 3], newRange: [3, 3], contentHash: "ca55030e" }]);
    assert.deepEqual(r.added, []);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.moved, []);
    assert.equal(r.stats.totalLinesOld, 5);
    assert.equal(r.stats.totalLinesNew, 5);
    assert.equal(r.stats.modifiedLines, 1);
    assert.equal(r.stats.addedLines, 0);
    assert.equal(r.stats.removedLines, 0);
    assert(Math.abs(r.stats.changeDensity - 0.2) < 0.001);
    // oldSet={a,b,c,d,e}=5, newSet={a,b,X,d,e}=5, intersection={a,b,d,e}=4 → Dice=8/10
    assert(Math.abs(r.stats.contentSimilarity - 8 / 10) < 0.001);
  });
});
