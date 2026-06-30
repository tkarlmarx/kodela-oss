// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildHoverMarkdown, getDaysOld } from "./hover-utils.js";
import type { ContextEntry } from "@kodela/core";

const HASH = "a".repeat(64);

function entry(
  overrides: Partial<ContextEntry> & { id: string },
): ContextEntry {
  const base: ContextEntry = {
    schemaVersion: "1.1.0",
    id: overrides.id,
    filePath: overrides.filePath ?? "src/auth.ts",
    astAnchor: null,
    contentHash: HASH,
    lineRange: overrides.lineRange ?? { start: 10, end: 20 },
    note: overrides.note ?? "Test note",
    author: overrides.author ?? "alice",
    createdAt: overrides.createdAt ?? "2024-01-15T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-03-02T00:00:00.000Z",
    severity: overrides.severity ?? "medium",
    tags: overrides.tags ?? [],
    source: overrides.source ?? "human",
    confidence: overrides.confidence ?? 0.9,
    status: overrides.status ?? "mapped",
    reviewRequired: overrides.reviewRequired ?? false,
  };
  if (overrides.aiTool !== undefined) base.aiTool = overrides.aiTool;
  if (overrides.link !== undefined) base.link = overrides.link;
  if (overrides.origin !== undefined) base.origin = overrides.origin;
  return base;
}

describe("buildHoverMarkdown", () => {
  test("returns null when no entry covers the line", () => {
    const entries = [entry({ id: "1", lineRange: { start: 1, end: 5 } })];
    assert.equal(buildHoverMarkdown(entries, 10), null);
  });

  test("returns null for empty entries array", () => {
    assert.equal(buildHoverMarkdown([], 5), null);
  });

  test("returns markdown when line is within range", () => {
    const entries = [entry({ id: "1", lineRange: { start: 5, end: 15 } })];
    const result = buildHoverMarkdown(entries, 10);
    assert.ok(result !== null);
    assert.ok(result.includes("Kodela Annotation"));
  });

  test("includes severity badge in header", () => {
    const entries = [entry({ id: "1", severity: "critical", lineRange: { start: 1, end: 10 } })];
    const result = buildHoverMarkdown(entries, 5);
    assert.ok(result?.includes("[critical]"));
  });

  test("includes review required badge when set", () => {
    const entries = [entry({ id: "1", reviewRequired: true, lineRange: { start: 1, end: 5 } })];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("[review required]"));
  });

  test("does not include review required badge when not set", () => {
    const entries = [entry({ id: "1", reviewRequired: false, lineRange: { start: 1, end: 5 } })];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(!result?.includes("[review required]"));
  });

  test("shows orphaned warning for orphaned entries", () => {
    const entries = [entry({ id: "1", status: "orphaned", lineRange: { start: 1, end: 10 } })];
    const result = buildHoverMarkdown(entries, 5);
    assert.ok(result?.includes("orphaned"));
    assert.ok(result?.includes("kodela heal"));
  });

  test("shows uncertainty warning for uncertain entries", () => {
    const entries = [
      entry({ id: "1", status: "uncertain", confidence: 0.72, lineRange: { start: 1, end: 10 } }),
    ];
    const result = buildHoverMarkdown(entries, 5);
    assert.ok(result?.includes("72%"));
    assert.ok(result?.includes("uncertain"));
  });

  test("includes note text in output", () => {
    const entries = [
      entry({ id: "1", note: "JWT validation logic", lineRange: { start: 1, end: 5 } }),
    ];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("JWT validation logic"));
  });

  test("includes tags when present", () => {
    const entries = [
      entry({ id: "1", tags: ["security", "auth"], lineRange: { start: 1, end: 5 } }),
    ];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("security"));
    assert.ok(result?.includes("auth"));
  });

  test("includes author and source", () => {
    const entries = [
      entry({ id: "1", author: "bob", source: "ai", lineRange: { start: 1, end: 5 } }),
    ];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("bob"));
    assert.ok(result?.includes("ai"));
  });

  test("includes dates", () => {
    const entries = [entry({ id: "1", lineRange: { start: 1, end: 5 } })];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("2024-01-15"));
    assert.ok(result?.includes("2024-03-02"));
  });

  test("includes confidence bar with correct fill", () => {
    const entries = [entry({ id: "1", confidence: 0.9, lineRange: { start: 1, end: 5 } })];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("90%"));
    assert.ok(result?.includes("█"));
  });

  test("covers line exactly at range boundary (start)", () => {
    const entries = [entry({ id: "1", lineRange: { start: 10, end: 20 } })];
    assert.ok(buildHoverMarkdown(entries, 10) !== null);
  });

  test("covers line exactly at range boundary (end)", () => {
    const entries = [entry({ id: "1", lineRange: { start: 10, end: 20 } })];
    assert.ok(buildHoverMarkdown(entries, 20) !== null);
  });

  test("does not cover line just outside range", () => {
    const entries = [entry({ id: "1", lineRange: { start: 10, end: 20 } })];
    assert.equal(buildHoverMarkdown(entries, 21), null);
    assert.equal(buildHoverMarkdown(entries, 9), null);
  });

  test("combines multiple matching entries with separator", () => {
    const entries = [
      entry({ id: "1", note: "First annotation", lineRange: { start: 1, end: 20 } }),
      entry({ id: "2", note: "Second annotation", lineRange: { start: 5, end: 15 } }),
    ];
    const result = buildHoverMarkdown(entries, 10);
    assert.ok(result?.includes("First annotation"));
    assert.ok(result?.includes("Second annotation"));
    assert.ok(result?.includes("---"));
  });

  test("uses ✓ icon for mapped status", () => {
    const entries = [entry({ id: "1", status: "mapped", lineRange: { start: 1, end: 5 } })];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("✓"));
  });

  test("uses ⚠ icon for uncertain status", () => {
    const entries = [entry({ id: "1", status: "uncertain", lineRange: { start: 1, end: 5 } })];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("⚠"));
  });

  test("uses ✗ icon for orphaned status", () => {
    const entries = [entry({ id: "1", status: "orphaned", lineRange: { start: 1, end: 5 } })];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("✗"));
  });

  test("appends AI warning when isFileAIChanged is true and entries match", () => {
    const entries = [entry({ id: "1", lineRange: { start: 1, end: 10 } })];
    const result = buildHoverMarkdown(entries, 5, true);
    assert.ok(result?.includes("⚡"));
    assert.ok(result?.includes("AI-generated changes"));
    assert.ok(result?.includes("annotation"));
  });

  test("does not append AI warning when isFileAIChanged is false", () => {
    const entries = [entry({ id: "1", lineRange: { start: 1, end: 10 } })];
    const result = buildHoverMarkdown(entries, 5, false);
    assert.ok(!result?.includes("AI-generated changes"));
  });

  test("does not append AI warning when isFileAIChanged is omitted", () => {
    const entries = [entry({ id: "1", lineRange: { start: 1, end: 10 } })];
    const result = buildHoverMarkdown(entries, 5);
    assert.ok(!result?.includes("AI-generated changes"));
  });

  test("returns null (not AI warning alone) when no entries match even if isFileAIChanged is true", () => {
    const entries = [entry({ id: "1", lineRange: { start: 20, end: 30 } })];
    assert.equal(buildHoverMarkdown(entries, 5, true), null);
  });

  test("AI warning appears after all annotation content", () => {
    const entries = [entry({ id: "1", note: "Important note", lineRange: { start: 1, end: 10 } })];
    const result = buildHoverMarkdown(entries, 5, true);
    assert.ok(result !== null);
    const aiIdx = result.indexOf("AI-generated");
    const noteIdx = result.indexOf("Important note");
    assert.ok(noteIdx < aiIdx, "AI warning should appear after the entry content");
  });
});

// ---------------------------------------------------------------------------
// Gap 14 — aiTool badge, age in days, AI link status
// ---------------------------------------------------------------------------

describe("buildHoverMarkdown — Gap 14: aiTool badge", () => {
  test("shows aiTool badge in header when aiTool is set", () => {
    const entries = [
      entry({ id: "1", aiTool: "claude", lineRange: { start: 1, end: 5 } }),
    ];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("`claude`"), `Expected \`claude\` in: ${result}`);
  });

  test("shows aiTool badge for copilot", () => {
    const entries = [
      entry({ id: "1", aiTool: "copilot", lineRange: { start: 1, end: 5 } }),
    ];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("`copilot`"), `Expected \`copilot\` in: ${result}`);
  });

  test("no aiTool badge when aiTool is absent", () => {
    const entries = [entry({ id: "1", lineRange: { start: 1, end: 5 } })];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("Kodela Annotation"));
    assert.ok(!result?.includes("` `"), "no spurious backtick badge");
  });
});

describe("buildHoverMarkdown — Gap 14: age in days", () => {
  test("shows age in days based on createdAt", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const entries = [
      entry({ id: "1", createdAt: twoDaysAgo, lineRange: { start: 1, end: 5 } }),
    ];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("2d ago") || result?.includes("(2d ago)"), `Expected 2d ago in: ${result}`);
  });

  test("shows 0d ago for a very recent entry", () => {
    const justNow = new Date(Date.now() - 10 * 1000).toISOString(); // 10 seconds ago
    const entries = [
      entry({ id: "1", createdAt: justNow, lineRange: { start: 1, end: 5 } }),
    ];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("0d ago"), `Expected 0d ago in: ${result}`);
  });

  test("createdAt date is still shown alongside age", () => {
    const entries = [entry({ id: "1", lineRange: { start: 1, end: 5 } })];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("2024-01-15"), "raw date still present");
    assert.ok(result?.includes("d ago"), "age in days also present");
  });
});

describe("buildHoverMarkdown — Gap 14: AI link status", () => {
  test("shows clickable AI link when link is present and aiTool set", () => {
    const entries = [
      entry({
        id: "1",
        source: "ai",
        aiTool: "claude",
        link: "https://claude.ai/share/abc123",
        lineRange: { start: 1, end: 5 },
      }),
    ];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("Open claude Chat"), `Expected 'Open claude Chat' in: ${result}`);
    assert.ok(result?.includes("https://claude.ai/share/abc123"), "link URL present");
    assert.ok(result?.includes("✅"), "checkmark present");
  });

  test("shows None warning when aiTool is set but no link", () => {
    const entries = [
      entry({
        id: "1",
        source: "ai",
        aiTool: "copilot",
        lineRange: { start: 1, end: 5 },
      }),
    ];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("None. Summary above is the only context."), `Expected None message in: ${result}`);
    assert.ok(result?.includes("⚠️"), "warning emoji present");
  });

  test("shows None warning when source is ai but no aiTool and no link", () => {
    const entries = [
      entry({
        id: "1",
        source: "ai",
        lineRange: { start: 1, end: 5 },
      }),
    ];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("AI Link:"), "AI Link line present");
    assert.ok(result?.includes("None"), "None message present");
  });

  test("shows None warning uses 'AI' as label when no aiTool", () => {
    const entries = [
      entry({
        id: "1",
        source: "ai",
        link: "https://chat.openai.com/share/xyz",
        lineRange: { start: 1, end: 5 },
      }),
    ];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("Open AI Chat"), `Expected 'Open AI Chat' in: ${result}`);
    assert.ok(result?.includes("✅"), "checkmark present");
  });

  test("no AI link section for human-sourced entry without aiTool", () => {
    const entries = [
      entry({
        id: "1",
        source: "human",
        lineRange: { start: 1, end: 5 },
      }),
    ];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(!result?.includes("AI Link:"), "no AI Link line for human entry");
  });

  test("link section appears when human-sourced entry has aiTool set", () => {
    const entries = [
      entry({
        id: "1",
        source: "human",
        aiTool: "chatgpt",
        link: "https://chatgpt.com/share/abc",
        lineRange: { start: 1, end: 5 },
      }),
    ];
    const result = buildHoverMarkdown(entries, 3);
    assert.ok(result?.includes("Open chatgpt Chat"), "link shown when aiTool present even for human source");
    assert.ok(result?.includes("✅"), "checkmark present");
  });
});

describe("getDaysOld", () => {
  test("returns 0 for a timestamp just now", () => {
    const now = new Date().toISOString();
    assert.equal(getDaysOld(now), 0);
  });

  test("returns correct days for a past timestamp", () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(getDaysOld(sevenDaysAgo), 7);
  });

  test("returns floor of fractional days", () => {
    const almostTwoDays = new Date(Date.now() - (2 * 24 * 60 * 60 * 1000 - 1000)).toISOString();
    assert.equal(getDaysOld(almostTwoDays), 1);
  });
});

// ---------------------------------------------------------------------------
// Gap 18 — Link rot detection
// ---------------------------------------------------------------------------

describe("buildHoverMarkdown — Gap 18: link rot detection", () => {
  const URL = "https://claude.ai/share/abc123";

  test("shows ✅ when link status is 'live'", () => {
    const e = entry({
      id: "1",
      source: "ai",
      aiTool: "claude",
      link: URL,
      lineRange: { start: 1, end: 5 },
    });
    const statusMap = new Map<string, "live" | "dead" | "unknown">([[URL, "live"]]);
    const result = buildHoverMarkdown([e], 3, false, statusMap);
    assert.ok(result?.includes("✅"), `Expected ✅ for live link. Got: ${result}`);
    assert.ok(!result?.includes("may be dead"), "no dead warning for live link");
  });

  test("shows ⚠ Link may be dead when link status is 'dead'", () => {
    const e = entry({
      id: "1",
      source: "ai",
      aiTool: "claude",
      link: URL,
      lineRange: { start: 1, end: 5 },
    });
    const statusMap = new Map<string, "live" | "dead" | "unknown">([[URL, "dead"]]);
    const result = buildHoverMarkdown([e], 3, false, statusMap);
    assert.ok(
      result?.includes("⚠ Link may be dead"),
      `Expected dead-link warning. Got: ${result}`,
    );
  });

  test("shows ✅ (optimistic) when link status is 'unknown' (check in progress)", () => {
    const e = entry({
      id: "1",
      source: "ai",
      aiTool: "claude",
      link: URL,
      lineRange: { start: 1, end: 5 },
    });
    const statusMap = new Map<string, "live" | "dead" | "unknown">([[URL, "unknown"]]);
    const result = buildHoverMarkdown([e], 3, false, statusMap);
    assert.ok(result?.includes("✅"), `Expected optimistic ✅. Got: ${result}`);
    assert.ok(!result?.includes("may be dead"), "no dead warning for unknown status");
  });

  test("shows ✅ when no linkStatusMap provided (optimistic default)", () => {
    const e = entry({
      id: "1",
      source: "ai",
      aiTool: "claude",
      link: URL,
      lineRange: { start: 1, end: 5 },
    });
    const result = buildHoverMarkdown([e], 3);
    assert.ok(result?.includes("✅"), `Expected optimistic ✅ with no status map. Got: ${result}`);
    assert.ok(!result?.includes("may be dead"), "no dead warning when no map");
  });

  test("link URL is always included in the output regardless of status", () => {
    for (const status of ["live", "dead", "unknown"] as const) {
      const e = entry({
        id: "1",
        source: "ai",
        aiTool: "claude",
        link: URL,
        lineRange: { start: 1, end: 5 },
      });
      const statusMap = new Map<string, "live" | "dead" | "unknown">([[URL, status]]);
      const result = buildHoverMarkdown([e], 3, false, statusMap);
      assert.ok(result?.includes(URL), `URL should be present for status=${status}`);
    }
  });
});

describe("buildHoverMarkdown — Gap 18: origin.summary fallback", () => {
  test("renders origin.summary when present", () => {
    const e = entry({
      id: "1",
      source: "ai",
      aiTool: "claude",
      link: "https://claude.ai/share/xyz",
      origin: { type: "ai", summary: "Auth refactor — handle refresh token rotation" },
      lineRange: { start: 1, end: 5 },
    });
    const result = buildHoverMarkdown([e], 3);
    assert.ok(
      result?.includes("Auth refactor — handle refresh token rotation"),
      `Expected origin.summary in output. Got: ${result}`,
    );
  });

  test("origin.summary is shown even when link is dead (serves as fallback context)", () => {
    const URL2 = "https://claude.ai/share/gone";
    const e = entry({
      id: "1",
      source: "ai",
      aiTool: "claude",
      link: URL2,
      origin: { type: "ai", summary: "JWT edge-case fix — expired token handling" },
      lineRange: { start: 1, end: 5 },
    });
    const statusMap = new Map<string, "live" | "dead" | "unknown">([[URL2, "dead"]]);
    const result = buildHoverMarkdown([e], 3, false, statusMap);
    assert.ok(result?.includes("⚠ Link may be dead"), "dead-link badge present");
    assert.ok(
      result?.includes("JWT edge-case fix — expired token handling"),
      `Expected origin.summary as fallback. Got: ${result}`,
    );
  });

  test("origin.summary appears before the link status line", () => {
    const URL3 = "https://claude.ai/share/order";
    const e = entry({
      id: "1",
      source: "ai",
      aiTool: "claude",
      link: URL3,
      origin: { type: "ai", summary: "Context summary text" },
      lineRange: { start: 1, end: 5 },
    });
    const result = buildHoverMarkdown([e], 3);
    assert.ok(result !== null);
    const summaryIdx = result.indexOf("Context summary text");
    const linkIdx = result.indexOf("AI Link:");
    assert.ok(summaryIdx < linkIdx, "origin.summary should appear before AI Link section");
  });

  test("no origin.summary section when origin is absent", () => {
    const e = entry({ id: "1", source: "human", lineRange: { start: 1, end: 5 } });
    const result = buildHoverMarkdown([e], 3);
    assert.ok(!result?.includes("Context summary"), "no summary section for entry without origin");
  });

  test("no origin.summary section when origin has no summary field", () => {
    const e = entry({
      id: "1",
      source: "ai",
      aiTool: "claude",
      origin: { type: "ai" },
      lineRange: { start: 1, end: 5 },
    });
    const result = buildHoverMarkdown([e], 3);
    assert.ok(result !== null);
    // The origin block should not produce "*undefined*" or an empty italic line "**"
    assert.ok(!result.includes("*undefined*"), "no *undefined* rendered");
    // An empty italic (from a missing summary field) would produce a line that
    // starts and ends with a single asterisk with nothing between them.
    assert.ok(
      !result.split("\n").some((l) => l.trim() === "**" || l.trim() === "* *"),
      "no empty italic line rendered",
    );
  });
});

describe("Gap 16 — Line-number drift warnings", () => {
  test("shows no drift warning when driftedEntryIds is undefined", () => {
    const e = entry({ id: "drift-1", lineRange: { start: 1, end: 3 } });
    const result = buildHoverMarkdown([e], 2);
    assert.ok(result !== null);
    assert.ok(!result.includes("drifted"), "no drift warning when set is not provided");
  });

  test("shows no drift warning when driftedEntryIds is an empty set", () => {
    const e = entry({ id: "drift-2", lineRange: { start: 1, end: 3 } });
    const result = buildHoverMarkdown([e], 2, false, undefined, new Set());
    assert.ok(result !== null);
    assert.ok(!result.includes("drifted"), "no drift warning for empty drifted set");
  });

  test("shows no drift warning when entry is not in driftedEntryIds", () => {
    const e = entry({ id: "drift-3", lineRange: { start: 1, end: 3 } });
    const result = buildHoverMarkdown([e], 2, false, undefined, new Set(["other-id"]));
    assert.ok(result !== null);
    assert.ok(!result.includes("drifted"), "no drift warning for non-drifted entry");
  });

  test("shows drift warning when entry ID is in driftedEntryIds", () => {
    const e = entry({ id: "drift-4", lineRange: { start: 1, end: 3 } });
    const drifted = new Set(["drift-4"]);
    const result = buildHoverMarkdown([e], 2, false, undefined, drifted);
    assert.ok(result !== null, "result should not be null");
    assert.ok(result.includes("drifted"), `expected drift warning. Got: ${result}`);
  });

  test("drift warning message mentions kodela heal", () => {
    const e = entry({ id: "drift-5", lineRange: { start: 5, end: 10 } });
    const drifted = new Set(["drift-5"]);
    const result = buildHoverMarkdown([e], 7, false, undefined, drifted);
    assert.ok(result?.includes("kodela heal"), "drift warning should mention kodela heal");
  });

  test("drift warning appears for drifted entry but not for non-drifted entry in same hover", () => {
    const e1 = entry({ id: "drift-6a", lineRange: { start: 1, end: 3 } });
    const e2 = entry({ id: "drift-6b", lineRange: { start: 1, end: 3 } });
    const drifted = new Set(["drift-6a"]);
    const result = buildHoverMarkdown([e1, e2], 2, false, undefined, drifted);
    assert.ok(result !== null);
    const blocks = result.split("---");
    const blockWithDrift = blocks.find((b) => b.includes("drifted"));
    const blockWithoutDrift = blocks.find((b) => !b.includes("drifted"));
    assert.ok(blockWithDrift, "one block should have the drift warning");
    assert.ok(blockWithoutDrift, "one block should not have the drift warning");
  });

  test("drift warning is shown alongside orphaned status warning", () => {
    const e = entry({ id: "drift-7", status: "orphaned", lineRange: { start: 1, end: 5 } });
    const drifted = new Set(["drift-7"]);
    const result = buildHoverMarkdown([e], 3, false, undefined, drifted);
    assert.ok(result?.includes("orphaned"), "orphaned warning present");
    assert.ok(result?.includes("drifted"), "drift warning also present");
  });

  test("drift warning includes 'annotated code no longer matches' message", () => {
    const e = entry({ id: "drift-8", lineRange: { start: 1, end: 2 } });
    const drifted = new Set(["drift-8"]);
    const result = buildHoverMarkdown([e], 1, false, undefined, drifted);
    assert.ok(
      result?.includes("no longer matches"),
      `Expected 'no longer matches' in drift warning. Got: ${result}`,
    );
  });
});
