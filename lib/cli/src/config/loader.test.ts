// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  loadConfig,
  loadConfigSafe,
  findConfigFile,
  writeDefaultConfig,
  CONFIG_FILE_NAME,
  KODELA_METADATA_SCHEMA_VERSION,
  setCaptureMode,
  refreshKodelaMetadata,
  writeGettingStartedMd,
} from "./loader.js";
import { DEFAULT_CONFIG } from "./schema.js";

describe("findConfigFile", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-config-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns null when no config file exists", async () => {
    const result = await findConfigFile(tmpDir);
    assert.equal(result, null);
  });

  test("finds config file in the start directory", async () => {
    const configPath = path.join(tmpDir, CONFIG_FILE_NAME);
    await fs.writeFile(configPath, JSON.stringify({}), "utf-8");
    const result = await findConfigFile(tmpDir);
    assert.equal(result, configPath);
    await fs.unlink(configPath);
  });

  test("finds config file in a parent directory", async () => {
    const subDir = path.join(tmpDir, "sub", "dir");
    await fs.mkdir(subDir, { recursive: true });
    const configPath = path.join(tmpDir, CONFIG_FILE_NAME);
    await fs.writeFile(configPath, JSON.stringify({}), "utf-8");
    const result = await findConfigFile(subDir);
    assert.equal(result, configPath);
    await fs.rm(subDir, { recursive: true });
    await fs.unlink(configPath);
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-loadconfig-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns default config when no config file exists", async () => {
    const config = await loadConfig(tmpDir);
    assert.equal(config.ci.enforcement, "advisory");
    assert.equal(config.ci.thresholds.min_confidence_score, 0.8);
  });

  test("loads and parses a valid config file", async () => {
    const configData = {
      ci: { enforcement: "enforcement", thresholds: { min_confidence_score: 0.9 } },
    };
    await fs.writeFile(
      path.join(tmpDir, CONFIG_FILE_NAME),
      JSON.stringify(configData),
      "utf-8",
    );
    const config = await loadConfig(tmpDir);
    assert.equal(config.ci.enforcement, "enforcement");
    assert.equal(config.ci.thresholds.min_confidence_score, 0.9);
  });

  test("throws on invalid config file content", async () => {
    await fs.writeFile(
      path.join(tmpDir, CONFIG_FILE_NAME),
      "not json at all!!!",
      "utf-8",
    );
    await assert.rejects(() => loadConfig(tmpDir), Error);
  });
});

describe("loadConfigSafe", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-loadconfigsafe-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("returns default config and writes a warning when config file is malformed JSON", async () => {
    await fs.writeFile(path.join(tmpDir, CONFIG_FILE_NAME), "{ this is not json }", "utf-8");

    const warnings: string[] = [];
    const fakeStderr = { write: (msg: string) => { warnings.push(msg); } };

    const config = await loadConfigSafe(tmpDir, fakeStderr);

    assert.deepStrictEqual(config, DEFAULT_CONFIG, "falls back to DEFAULT_CONFIG");
    assert.equal(warnings.length, 1, "exactly one warning emitted");
    assert.ok(warnings[0]!.includes("Warning:"), "warning starts with 'Warning:'");
    assert.ok(warnings[0]!.includes("using built-in defaults"), "warning mentions built-in defaults");
  });

  test("returns default config and writes a warning when config file fails schema validation", async () => {
    await fs.writeFile(
      path.join(tmpDir, CONFIG_FILE_NAME),
      JSON.stringify({ ci: { enforcement: 999 } }),
      "utf-8",
    );

    const warnings: string[] = [];
    const fakeStderr = { write: (msg: string) => { warnings.push(msg); } };

    const config = await loadConfigSafe(tmpDir, fakeStderr);

    assert.deepStrictEqual(config, DEFAULT_CONFIG, "falls back to DEFAULT_CONFIG on schema error");
    assert.equal(warnings.length, 1, "exactly one warning emitted");
    assert.ok(warnings[0]!.includes("Warning:"), "warning starts with 'Warning:'");
  });

  test("returns loaded config and emits no warnings when config file is valid", async () => {
    await fs.writeFile(
      path.join(tmpDir, CONFIG_FILE_NAME),
      JSON.stringify({ ci: { enforcement: "enforcement", thresholds: { min_confidence_score: 0.7 } } }),
      "utf-8",
    );

    const warnings: string[] = [];
    const fakeStderr = { write: (msg: string) => { warnings.push(msg); } };

    const config = await loadConfigSafe(tmpDir, fakeStderr);

    assert.equal(config.ci.enforcement, "enforcement", "loaded custom enforcement value");
    assert.equal(config.ci.thresholds.min_confidence_score, 0.7, "loaded custom threshold");
    assert.equal(warnings.length, 0, "no warnings emitted for valid config");
  });
});

describe("writeDefaultConfig", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-writeconfig-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("writes a parseable default config file", async () => {
    await writeDefaultConfig(tmpDir);
    const config = await loadConfig(tmpDir);
    assert.equal(config.ci.enforcement, "advisory");
    assert.ok(typeof config.ci.thresholds.min_confidence_score === "number");
  });

  test("injects a `_kodela` block at the top of the file with current schema_version", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-meta-write-"));
    try {
      await writeDefaultConfig(dir);
      const raw = await fs.readFile(path.join(dir, CONFIG_FILE_NAME), "utf-8");
      // The very first non-whitespace key must be `_kodela`.
      const firstKey = raw.match(/"([^"]+)"/);
      assert.ok(firstKey);
      assert.equal(firstKey![1], "_kodela");
      const parsed = JSON.parse(raw) as { _kodela?: { schema_version?: number; capture_mode?: string; next_steps?: unknown[] } };
      assert.ok(parsed._kodela);
      assert.equal(parsed._kodela!.schema_version, KODELA_METADATA_SCHEMA_VERSION);
      assert.equal(parsed._kodela!.capture_mode, "unset");
      assert.ok(Array.isArray(parsed._kodela!.next_steps));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("captureMode option is reflected in the `_kodela` block", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-meta-mode-"));
    try {
      await writeDefaultConfig(dir, { captureMode: "watcher" });
      const raw = await fs.readFile(path.join(dir, CONFIG_FILE_NAME), "utf-8");
      const parsed = JSON.parse(raw) as { _kodela?: { capture_mode?: string } };
      assert.equal(parsed._kodela?.capture_mode, "watcher");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("setCaptureMode", () => {
  test("updates only the capture_mode field, preserving other config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-set-mode-"));
    try {
      await writeDefaultConfig(dir);
      await setCaptureMode(dir, "hooks");
      const config = await loadConfig(dir);
      const meta = (config as unknown as { _kodela?: { capture_mode?: string } })._kodela;
      assert.equal(meta?.capture_mode, "hooks");
      // Other settings preserved.
      assert.equal(config.ci.enforcement, "advisory");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("returns false (no-op) when no config file exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-set-mode-empty-"));
    try {
      const ok = await setCaptureMode(dir, "watcher");
      assert.equal(ok, false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("refreshKodelaMetadata", () => {
  test("refreshes when schema_version is older", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-refresh-"));
    try {
      const configPath = path.join(dir, CONFIG_FILE_NAME);
      const stale = {
        _kodela: {
          schema_version: 0,
          last_updated_cli_version: "0.0.0",
          capture_mode: "watcher",
          next_steps: ["old"],
          docs_url: "https://old.example",
        },
        hooks: { line_threshold: 50, minimum_summary_length: 10, required_fields: ["note"] },
      };
      await fs.writeFile(configPath, JSON.stringify(stale, null, 2), "utf-8");
      const refreshed = await refreshKodelaMetadata(dir);
      assert.equal(refreshed, true);
      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as { _kodela: { schema_version: number; capture_mode: string; next_steps: unknown[] } };
      assert.equal(parsed._kodela.schema_version, KODELA_METADATA_SCHEMA_VERSION);
      // Capture mode preserved.
      assert.equal(parsed._kodela.capture_mode, "watcher");
      // Next-steps replaced with current canonical list.
      assert.notDeepEqual(parsed._kodela.next_steps, ["old"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("returns false when schema_version is already current", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-refresh-current-"));
    try {
      await writeDefaultConfig(dir);
      const refreshed = await refreshKodelaMetadata(dir);
      assert.equal(refreshed, false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadConfig with future schema_version", () => {
  test("does not throw when an unknown _kodela.schema_version is present (forward-compat)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-future-version-"));
    try {
      await fs.writeFile(
        path.join(dir, CONFIG_FILE_NAME),
        JSON.stringify({
          _kodela: {
            schema_version: 999,
            future_field: "ignored gracefully",
          },
          ci: { enforcement: "advisory" },
        }),
        "utf-8",
      );
      const config = await loadConfig(dir);
      assert.equal(config.ci.enforcement, "advisory");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("writeGettingStartedMd", () => {
  test("creates .kodela/GETTING_STARTED.md and refuses to overwrite without --force", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-gs-"));
    try {
      const created = await writeGettingStartedMd(dir);
      assert.equal(created, true);
      const dest = path.join(dir, ".kodela", "GETTING_STARTED.md");
      const first = await fs.readFile(dest, "utf-8");
      assert.match(first, /Getting Started/);
      assert.match(first, /Claude Code hooks/);

      // Mutate then re-call without force — must not overwrite.
      await fs.writeFile(dest, "user edit", "utf-8");
      const recreated = await writeGettingStartedMd(dir);
      assert.equal(recreated, false);
      assert.equal(await fs.readFile(dest, "utf-8"), "user edit");

      // With force — must overwrite.
      const forced = await writeGettingStartedMd(dir, { force: true });
      assert.equal(forced, true);
      const after = await fs.readFile(dest, "utf-8");
      assert.match(after, /Getting Started/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
