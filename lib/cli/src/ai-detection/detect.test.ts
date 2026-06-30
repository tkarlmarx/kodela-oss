// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  detectAiCommits,
  formatAiDetectionResult,
  type AiDetectionResult,
} from "./detect.js";
import { DEFAULT_CONFIG } from "../config/schema.js";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

describe("formatAiDetectionResult", () => {
  test("shows disabled message when AI detection is off", () => {
    const result: AiDetectionResult = {
      enabled: false,
      scanned: 0,
      flagged: 0,
      signals: [],
    };
    const msg = formatAiDetectionResult(result);
    assert.ok(msg.includes("disabled"));
  });

  test("shows no commits message when scanned is 0", () => {
    const result: AiDetectionResult = {
      enabled: true,
      scanned: 0,
      flagged: 0,
      signals: [],
    };
    const msg = formatAiDetectionResult(result);
    assert.ok(msg.includes("No commits found"));
  });

  test("shows flagged count when signals present", () => {
    const result: AiDetectionResult = {
      enabled: true,
      scanned: 10,
      flagged: 2,
      signals: [
        {
          commit: "abc12345",
          author: "Alice",
          subject: "AI generated auth module",
          linesAdded: 250,
          linesDeleted: 0,
          isLikelyAi: true,
          reasons: ["large insertion: 250 lines added (threshold: 100)"],
          newFiles: [],
        },
        {
          commit: "def67890",
          author: "Bob",
          subject: "copilot: add payment service",
          linesAdded: 150,
          linesDeleted: 10,
          isLikelyAi: true,
          reasons: ['AI keyword in commit subject: "copilot: add payment service"'],
          newFiles: [],
        },
      ],
    };
    const msg = formatAiDetectionResult(result);
    assert.ok(msg.includes("2 flagged of 10 scanned"));
    assert.ok(msg.includes("abc12345"));
    assert.ok(msg.includes("large insertion"));
    assert.ok(msg.includes("AI keyword"));
  });

  test("json output is valid JSON with required fields", () => {
    const result: AiDetectionResult = {
      enabled: true,
      scanned: 5,
      flagged: 1,
      signals: [],
    };
    const json = formatAiDetectionResult(result, "json");
    const parsed = JSON.parse(json) as AiDetectionResult;
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.scanned, 5);
  });

  test("shows no AI-generated commits when signals empty but scanned > 0", () => {
    const result: AiDetectionResult = {
      enabled: true,
      scanned: 20,
      flagged: 0,
      signals: [],
    };
    const msg = formatAiDetectionResult(result);
    assert.ok(msg.includes("No likely AI-generated commits detected"));
  });

  test("shows new file details in text output", () => {
    const result: AiDetectionResult = {
      enabled: true,
      scanned: 3,
      flagged: 1,
      signals: [
        {
          commit: "aabbccdd",
          author: "Eve",
          subject: "add generated API client",
          linesAdded: 420,
          linesDeleted: 0,
          isLikelyAi: true,
          reasons: ["new file introduced: src/api/client.ts (420 lines)"],
          newFiles: [{ filename: "src/api/client.ts", linesAdded: 420 }],
        },
      ],
    };
    const msg = formatAiDetectionResult(result);
    assert.ok(msg.includes("new file introduced"));
    assert.ok(msg.includes("src/api/client.ts"));
    assert.ok(msg.includes("+ src/api/client.ts (420 lines)"));
  });

  test("shows multiple new files in text output", () => {
    const result: AiDetectionResult = {
      enabled: true,
      scanned: 1,
      flagged: 1,
      signals: [
        {
          commit: "11223344",
          author: "Frank",
          subject: "bulk add generated files",
          linesAdded: 800,
          linesDeleted: 0,
          isLikelyAi: true,
          reasons: ["2 new files introduced in a single commit (src/a.ts: 400 lines, src/b.ts: 400 lines)"],
          newFiles: [
            { filename: "src/a.ts", linesAdded: 400 },
            { filename: "src/b.ts", linesAdded: 400 },
          ],
        },
      ],
    };
    const msg = formatAiDetectionResult(result);
    assert.ok(msg.includes("2 new files introduced"));
    assert.ok(msg.includes("+ src/a.ts (400 lines)"));
    assert.ok(msg.includes("+ src/b.ts (400 lines)"));
  });
});

describe("detectAiCommits (live git repo)", () => {
  test("returns enabled:false when ai_detection.enabled is false", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ai-test-"));
    try {
      const config = {
        ...DEFAULT_CONFIG,
        ai_detection: {
          ...DEFAULT_CONFIG.ai_detection,
          enabled: false,
        },
      };
      const result = await detectAiCommits(dir, config);
      assert.equal(result.enabled, false);
      assert.equal(result.scanned, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("returns 0 scanned for non-git directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ai-nogit-"));
    try {
      const result = await detectAiCommits(dir, DEFAULT_CONFIG);
      assert.equal(result.enabled, true);
      assert.equal(result.scanned, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("detects new large file as AI signal in a real git repo", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ai-newfile-"));
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);

      await exec("git", ["init"], { cwd: dir });
      await exec("git", ["config", "user.email", "test@kodela.dev"], { cwd: dir });
      await exec("git", ["config", "user.name", "Test"], { cwd: dir });

      const bigFile = Array.from({ length: 80 }, (_, i) => `const x${i} = ${i};`).join("\n");
      await fs.writeFile(path.join(dir, "generated.ts"), bigFile);
      await exec("git", ["add", "."], { cwd: dir });
      await exec("git", ["commit", "-m", "initial commit"], { cwd: dir });

      const config = {
        ...DEFAULT_CONFIG,
        ai_detection: {
          ...DEFAULT_CONFIG.ai_detection,
          new_file_flag: true,
          new_file_min_lines: 50,
          min_lines_added: 9999,
        },
      };

      const result = await detectAiCommits(dir, config);
      assert.equal(result.enabled, true);
      assert.equal(result.scanned, 1);
      assert.equal(result.flagged, 1);
      assert.ok(result.signals[0]!.reasons.some((r) => r.includes("new file")));
      assert.ok(
        result.signals[0]!.newFiles.some((f) => f.filename === "generated.ts"),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("new_file_flag: false skips new file detection", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ai-noflag-"));
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);

      await exec("git", ["init"], { cwd: dir });
      await exec("git", ["config", "user.email", "test@kodela.dev"], { cwd: dir });
      await exec("git", ["config", "user.name", "Test"], { cwd: dir });

      const bigFile = Array.from({ length: 80 }, (_, i) => `const y${i} = ${i};`).join("\n");
      await fs.writeFile(path.join(dir, "big.ts"), bigFile);
      await exec("git", ["add", "."], { cwd: dir });
      await exec("git", ["commit", "-m", "add a big file"], { cwd: dir });

      const config = {
        ...DEFAULT_CONFIG,
        ai_detection: {
          ...DEFAULT_CONFIG.ai_detection,
          new_file_flag: false,
          min_lines_added: 9999,
        },
      };

      const result = await detectAiCommits(dir, config);
      assert.equal(result.flagged, 0, "should not flag when new_file_flag is false");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("small new file below new_file_min_lines is not flagged", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-ai-small-"));
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);

      await exec("git", ["init"], { cwd: dir });
      await exec("git", ["config", "user.email", "test@kodela.dev"], { cwd: dir });
      await exec("git", ["config", "user.name", "Test"], { cwd: dir });

      await fs.writeFile(path.join(dir, "tiny.ts"), "export const x = 1;\n");
      await exec("git", ["add", "."], { cwd: dir });
      await exec("git", ["commit", "-m", "add tiny file"], { cwd: dir });

      const config = {
        ...DEFAULT_CONFIG,
        ai_detection: {
          ...DEFAULT_CONFIG.ai_detection,
          new_file_flag: true,
          new_file_min_lines: 50,
          min_lines_added: 9999,
        },
      };

      const result = await detectAiCommits(dir, config);
      assert.equal(result.flagged, 0, "small file should not trigger new-file signal");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("DEFAULT_CONFIG includes new file heuristic fields", () => {
  test("new_file_flag defaults to true", () => {
    assert.equal(DEFAULT_CONFIG.ai_detection.new_file_flag, true);
  });

  test("new_file_min_lines defaults to 50", () => {
    assert.equal(DEFAULT_CONFIG.ai_detection.new_file_min_lines, 50);
  });
});
