// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runCaptureTier, formatCaptureTierResult } from "./capture-tier.js";

describe("kodela capture-tier", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodela-tier-cmd-"));
    delete process.env.KODELA_CAPTURE_TIER;
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("with no arg reports the current tier without changing it", async () => {
    const r = await runCaptureTier({ repoRoot: tmp });
    assert.equal(r.tier, "enforced");
    assert.equal(r.changed, false);
    assert.equal(fs.existsSync(path.join(tmp, ".kodela", "config.json")), false);
  });

  test("sets a valid tier and persists it", async () => {
    const r = await runCaptureTier({ repoRoot: tmp, tier: "ambient" });
    assert.equal(r.tier, "ambient");
    assert.equal(r.changed, true);
    assert.equal(r.previous, "enforced");
    const again = await runCaptureTier({ repoRoot: tmp });
    assert.equal(again.tier, "ambient");
  });

  test("is case-insensitive", async () => {
    const r = await runCaptureTier({ repoRoot: tmp, tier: "Ambient" });
    assert.equal(r.tier, "ambient");
  });

  test("rejects an unknown tier", async () => {
    await assert.rejects(
      () => runCaptureTier({ repoRoot: tmp, tier: "yolo" }),
      /Unknown capture tier/,
    );
  });

  test("text output names the active tier and lists all tiers", async () => {
    const r = await runCaptureTier({ repoRoot: tmp, tier: "assisted" });
    const text = formatCaptureTierResult(r, "text");
    assert.match(text, /assisted/);
    assert.match(text, /enforced/);
    assert.match(text, /ambient/);
    const json = JSON.parse(formatCaptureTierResult(r, "json"));
    assert.equal(json.tier, "assisted");
  });
});
