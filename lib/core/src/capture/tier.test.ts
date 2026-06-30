// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readCaptureTier,
  writeCaptureTier,
  tierBlocksClose,
  DEFAULT_CAPTURE_TIER,
} from "./tier.js";

describe("capture tier", () => {
  let tmp: string;
  const savedEnv = process.env.KODELA_CAPTURE_TIER;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodela-tier-"));
    delete process.env.KODELA_CAPTURE_TIER;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.KODELA_CAPTURE_TIER;
    else process.env.KODELA_CAPTURE_TIER = savedEnv;
  });

  test("defaults to enforced when nothing is configured", () => {
    assert.equal(readCaptureTier(tmp), "enforced");
    assert.equal(DEFAULT_CAPTURE_TIER, "enforced");
  });

  test("round-trips through .kodela/config.json and preserves other keys", () => {
    fs.mkdirSync(path.join(tmp, ".kodela"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".kodela", "config.json"),
      JSON.stringify({ somethingElse: 42 }),
    );
    writeCaptureTier(tmp, "ambient");
    assert.equal(readCaptureTier(tmp), "ambient");
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmp, ".kodela", "config.json"), "utf8"),
    );
    assert.equal(parsed.captureTier, "ambient");
    assert.equal(parsed.somethingElse, 42); // unrelated keys preserved
  });

  test("env var overrides the config file", () => {
    writeCaptureTier(tmp, "assisted");
    process.env.KODELA_CAPTURE_TIER = "ambient";
    assert.equal(readCaptureTier(tmp), "ambient");
  });

  test("a malformed value falls back to the default", () => {
    fs.mkdirSync(path.join(tmp, ".kodela"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".kodela", "config.json"),
      JSON.stringify({ captureTier: "bogus" }),
    );
    assert.equal(readCaptureTier(tmp), "enforced");
  });

  test("only enforced blocks session close", () => {
    assert.equal(tierBlocksClose("enforced"), true);
    assert.equal(tierBlocksClose("assisted"), false);
    assert.equal(tierBlocksClose("ambient"), false);
  });
});
