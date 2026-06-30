// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatStatus, formatEntry, formatEntries } from "./formatters.js";
import type { StatusResult } from "../status/metrics.js";
import type { ContextEntry } from "@kodela/core";

const PLACEHOLDER_HASH = "a".repeat(64);

const SAMPLE_ENTRY: ContextEntry = {
  schemaVersion: "1.1.0",
  id: "550e8400-e29b-41d4-a716-446655440000",
  filePath: "src/auth/login.ts",
  astAnchor: null,
  contentHash: PLACEHOLDER_HASH,
  lineRange: { start: 10, end: 20 },
  note: "Token validation logic",
  author: "alice",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  severity: "high",
  tags: ["security"],
  source: "human",
  confidence: 0.95,
  status: "mapped",
  reviewRequired: false,
};

const SAMPLE_STATUS: StatusResult = {
  total: 10,
  mapped: 7,
  uncertain: 2,
  orphaned: 1,
  confidence_score: 0.85,
  orphaned_pct: 10,
  unresolved_critical_pct: 0,
  highContentDrift: 0,
  ci_pass: true,
};

describe("formatStatus", () => {
  test("text output contains trust signal numbers", () => {
    const output = formatStatus(SAMPLE_STATUS, "text");
    assert.ok(output.includes("10"), "should include total count");
    assert.ok(output.includes("85.0%"), "should include confidence %");
    assert.ok(output.includes("Mapped"), "should include Mapped label");
  });

  test("json output is valid JSON with required fields", () => {
    const output = formatStatus(SAMPLE_STATUS, "json");
    const parsed = JSON.parse(output) as Record<string, unknown>;
    assert.equal(parsed["total"], 10);
    assert.equal(parsed["confidence_score"], 0.85);
    assert.ok("orphaned_pct" in parsed);
    assert.ok("unresolved_critical_pct" in parsed);
  });

  test("junit output is valid XML structure", () => {
    const output = formatStatus(SAMPLE_STATUS, "junit");
    assert.ok(output.includes("<?xml"), "should start with XML declaration");
    assert.ok(output.includes("<testsuites"), "should have testsuites tag");
    assert.ok(output.includes("kodela-status"), "should have suite name");
  });
});

describe("formatEntry", () => {
  test("text output includes file path and line range", () => {
    const output = formatEntry(SAMPLE_ENTRY, "text");
    assert.ok(output.includes("src/auth/login.ts"));
    assert.ok(output.includes("10-20"));
    assert.ok(output.includes("Token validation logic"));
    // Gap 20d: author is hidden by default — framing annotations as "notes to future you"
    assert.ok(!output.includes("alice"), "author should be hidden by default (Gap 20d)");
  });

  test("text output shows author when showAuthor: true is passed (Gap 20d)", () => {
    const output = formatEntry(SAMPLE_ENTRY, "text", { showAuthor: true });
    assert.ok(output.includes("alice"), "author should appear when showAuthor is true");
  });

  test("json output is the serialized entry", () => {
    const output = formatEntry(SAMPLE_ENTRY, "json");
    const parsed = JSON.parse(output) as ContextEntry;
    assert.equal(parsed.id, SAMPLE_ENTRY.id);
    assert.equal(parsed.filePath, SAMPLE_ENTRY.filePath);
  });

  test("text output shows severity tag for non-normal severity", () => {
    const output = formatEntry(SAMPLE_ENTRY, "text");
    assert.ok(output.includes("[high]"));
  });

  // Gap 57 — scope display
  test("text output shows Scope label when entry.scope is set and not general", () => {
    const entry: ContextEntry = { ...SAMPLE_ENTRY, scope: "auth" };
    const output = formatEntry(entry, "text");
    assert.ok(output.includes("Scope: auth"), "should show Scope: auth in info line");
  });

  test("text output omits Scope label when entry.scope is general", () => {
    const entry: ContextEntry = { ...SAMPLE_ENTRY, scope: "general" };
    const output = formatEntry(entry, "text");
    assert.ok(!output.includes("Scope:"), "should omit Scope label for general scope");
  });

  test("text output omits Scope label when entry.scope is undefined", () => {
    const output = formatEntry(SAMPLE_ENTRY, "text");
    assert.ok(!output.includes("Scope:"), "should omit Scope label when scope is absent");
  });
});

describe("formatEntries", () => {
  test("returns empty message for empty array in text mode", () => {
    const output = formatEntries([], "text");
    assert.ok(output.includes("No context entries found"));
  });

  test("json output is a JSON array", () => {
    const output = formatEntries([SAMPLE_ENTRY], "json");
    const parsed = JSON.parse(output) as ContextEntry[];
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.id, SAMPLE_ENTRY.id);
  });
});

// Gap 69 — license_enforcement field in JSON output
describe("formatStatus — license_enforcement in JSON output", () => {
  test("JSON omits license_enforcement when field is absent on result", () => {
    const result: StatusResult = { ...SAMPLE_STATUS };
    delete result.license_enforcement;
    const output = formatStatus(result, "json");
    const parsed = JSON.parse(output) as Record<string, unknown>;
    assert.equal(parsed["license_enforcement"], undefined);
    assert.equal(parsed["license_enforcement_reason"], undefined);
  });

  test("JSON includes license_enforcement: 'advisory' when set on result", () => {
    const result: StatusResult = {
      ...SAMPLE_STATUS,
      license_enforcement: "advisory",
      license_enforcement_reason: "ci_enforcement feature requires a Team or Enterprise license",
    };
    const output = formatStatus(result, "json");
    const parsed = JSON.parse(output) as Record<string, unknown>;
    assert.equal(parsed["license_enforcement"], "advisory");
    assert.equal(
      parsed["license_enforcement_reason"],
      "ci_enforcement feature requires a Team or Enterprise license",
    );
  });

  test("JSON includes license_enforcement: 'enforcement' and no reason when licensed", () => {
    const result: StatusResult = {
      ...SAMPLE_STATUS,
      license_enforcement: "enforcement",
    };
    const output = formatStatus(result, "json");
    const parsed = JSON.parse(output) as Record<string, unknown>;
    assert.equal(parsed["license_enforcement"], "enforcement");
    assert.equal(parsed["license_enforcement_reason"], undefined);
  });

  test("text output is unaffected by license_enforcement field", () => {
    const result: StatusResult = {
      ...SAMPLE_STATUS,
      license_enforcement: "advisory",
      license_enforcement_reason: "ci_enforcement feature requires a Team or Enterprise license",
    };
    const output = formatStatus(result, "text");
    // Text output should still contain the normal trust-signal section
    assert.ok(output.includes("Mapped"), "text output should still contain Mapped label");
    // The JSON field name should not leak into text output
    assert.ok(
      !output.includes("license_enforcement"),
      "text output should not expose the JSON field name",
    );
  });
});
