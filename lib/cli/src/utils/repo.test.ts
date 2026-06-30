// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeFilePath, resolveRelativePath } from "./repo.js";

describe("normalizeFilePath", () => {
  test("converts backslashes to forward slashes", () => {
    assert.equal(normalizeFilePath("src\\auth\\login.ts"), "src/auth/login.ts");
  });

  test("removes leading ./", () => {
    assert.equal(normalizeFilePath("./src/auth/login.ts"), "src/auth/login.ts");
  });

  test("leaves clean paths unchanged", () => {
    assert.equal(normalizeFilePath("src/auth/login.ts"), "src/auth/login.ts");
  });

  test("handles empty string", () => {
    assert.equal(normalizeFilePath(""), "");
  });
});

describe("resolveRelativePath", () => {
  test("resolves relative path against repo root", () => {
    const result = resolveRelativePath("/repo", "src/auth/login.ts");
    assert.equal(result, "src/auth/login.ts");
  });

  test("normalizes the path", () => {
    const result = resolveRelativePath("/repo", "./src/auth/login.ts");
    assert.equal(result, "src/auth/login.ts");
  });
});
