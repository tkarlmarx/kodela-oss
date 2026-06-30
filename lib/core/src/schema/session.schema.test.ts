// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Phase 1 of the project design docs
 *
 * Pins the contract of the new `provenance` / `synthesisTemplateVersion` /
 * `supersededByEntryId` fields on FileChangeContext so future regressions get
 * a loud signal rather than a silent default-applied-everywhere.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FileChangeContextSchema, type FileChangeContext } from "./session.schema.js";

const BASE: Omit<FileChangeContext, "provenance"> = {
  path: "src/foo.ts",
  linesAdded: 4,
  linesRemoved: 1,
  modifiedBy: {
    source: "ai",
    tool: "claude-code",
    model: "claude-opus-4-7",
    author: "ai-agent",
  },
  whyChanged: "Added a missing null guard so the upstream parser does not crash on empty input.",
  problemSolved: "Without this guard the parser threw on the empty-body branch in production.",
  relatedFiles: [],
  relatedEntryIds: [],
  risk: "low",
  reviewRequired: false,
  entryIds: ["entry-1"],
  firstAnnotatedAt: "2026-06-19T10:00:00.000Z",
  lastUpdatedAt: "2026-06-19T10:00:00.000Z",
};

describe("FileChangeContext provenance (Phase 1)", () => {
  test("defaults provenance to 'agent-authored' when missing on disk", () => {
    // Simulate a legacy session JSON that was written before the field existed.
    const legacy = { ...BASE };
    delete (legacy as Partial<typeof legacy>)["provenance" as keyof typeof legacy];

    const parsed = FileChangeContextSchema.parse(legacy);
    assert.equal(parsed.provenance, "agent-authored");
  });

  test("accepts the three provenance values and rejects anything else", () => {
    for (const value of ["agent-authored", "synthesized", "human-authored"] as const) {
      const parsed = FileChangeContextSchema.parse({ ...BASE, provenance: value });
      assert.equal(parsed.provenance, value);
    }
    assert.throws(
      () => FileChangeContextSchema.parse({ ...BASE, provenance: "made-up" }),
      /Invalid enum value/,
    );
  });

  test("synthesisTemplateVersion is optional and round-trips when set", () => {
    const parsed = FileChangeContextSchema.parse({
      ...BASE,
      provenance: "synthesized",
      synthesisTemplateVersion: "v1",
    });
    assert.equal(parsed.synthesisTemplateVersion, "v1");
  });

  test("supersededByEntryId is optional and round-trips when set", () => {
    const parsed = FileChangeContextSchema.parse({
      ...BASE,
      provenance: "synthesized",
      supersededByEntryId: "entry-newer",
    });
    assert.equal(parsed.supersededByEntryId, "entry-newer");
  });
});
