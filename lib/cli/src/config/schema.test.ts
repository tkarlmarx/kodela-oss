// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { KodelaConfigSchema, DEFAULT_CONFIG } from "./schema.js";

describe("KodelaConfigSchema", () => {
  test("parses empty object with all defaults", () => {
    const config = KodelaConfigSchema.parse({});
    assert.equal(config.ci.enforcement, "advisory");
    assert.equal(config.ci.thresholds.min_confidence_score, 0.8);
    assert.equal(config.ci.thresholds.max_orphaned_pct, 10);
    assert.equal(config.ci.thresholds.max_unresolved_critical_pct, 5);
    assert.equal(config.baseline.max_days_before_archive, 90);
    assert.equal(config.ai_detection.enabled, true);
    assert.equal(config.ai_detection.min_lines_added, 100);
  });

  test("accepts partial config and fills in defaults", () => {
    const config = KodelaConfigSchema.parse({
      ci: { enforcement: "enforcement" },
    });
    assert.equal(config.ci.enforcement, "enforcement");
    assert.equal(config.ci.thresholds.min_confidence_score, 0.8);
  });

  test("accepts fully specified config", () => {
    const config = KodelaConfigSchema.parse({
      ci: {
        enforcement: "enforcement",
        thresholds: {
          min_confidence_score: 0.9,
          max_orphaned_pct: 5,
          max_unresolved_critical_pct: 2,
        },
      },
      baseline: { max_days_before_archive: 30 },
      ai_detection: { enabled: false, min_lines_added: 50 },
    });
    assert.equal(config.ci.thresholds.min_confidence_score, 0.9);
    assert.equal(config.baseline.max_days_before_archive, 30);
    assert.equal(config.ai_detection.enabled, false);
  });

  test("rejects invalid enforcement value", () => {
    assert.throws(() =>
      KodelaConfigSchema.parse({ ci: { enforcement: "strict" } }),
    );
  });

  test("rejects min_confidence_score > 1", () => {
    assert.throws(() =>
      KodelaConfigSchema.parse({
        ci: { thresholds: { min_confidence_score: 1.5 } },
      }),
    );
  });

  test("DEFAULT_CONFIG is valid and fully populated", () => {
    assert.ok(DEFAULT_CONFIG.ci);
    assert.ok(DEFAULT_CONFIG.baseline);
    assert.ok(DEFAULT_CONFIG.ai_detection);
    assert.ok(Array.isArray(DEFAULT_CONFIG.baseline.ignore_patterns));
    assert.ok(DEFAULT_CONFIG.baseline.ignore_patterns.length > 0);
  });

  test("license field is optional and defaults to undefined", () => {
    const config = KodelaConfigSchema.parse({});
    assert.strictEqual(config.license, undefined);
  });

  test("accepts a license file path string", () => {
    const config = KodelaConfigSchema.parse({ license: "/etc/kodela/org.license.json" });
    assert.strictEqual(config.license, "/etc/kodela/org.license.json");
  });

  test("accepts a relative license file path", () => {
    const config = KodelaConfigSchema.parse({ license: "./licenses/kodela.license.json" });
    assert.strictEqual(config.license, "./licenses/kodela.license.json");
  });

  test("config with license path still parses other fields correctly", () => {
    const config = KodelaConfigSchema.parse({
      license: "/opt/licenses/kodela.license.json",
      ci: { enforcement: "enforcement" },
    });
    assert.strictEqual(config.license, "/opt/licenses/kodela.license.json");
    assert.strictEqual(config.ci.enforcement, "enforcement");
  });
});
