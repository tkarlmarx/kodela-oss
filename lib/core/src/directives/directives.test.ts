// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  readDirectives,
  addDirective,
  removeDirective,
  formatDirectivesBlock,
  DIRECTIVES_FILE,
} from "./index.js";

describe("directives", () => {
  let tmp: string;
  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-directives-"));
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("empty when no file", async () => {
    assert.deepEqual(await readDirectives(tmp), []);
  });

  test("add → read round-trips and assigns an id + defaults scope global", async () => {
    const d = await addDirective(tmp, "Always sign commits with GPG", { createdAt: "2026-06-01T00:00:00.000Z" });
    assert.match(d.id, /^d-[0-9a-f]{6}$/);
    assert.equal(d.scope, "global");
    const all = await readDirectives(tmp);
    assert.equal(all.length, 1);
    assert.equal(all[0]?.text, "Always sign commits with GPG");
    // persisted at the documented path
    const raw = JSON.parse(await fs.readFile(path.join(tmp, DIRECTIVES_FILE), "utf-8"));
    assert.equal(raw.version, 1);
  });

  test("idempotent on identical text + scope (no duplicates)", async () => {
    const a = await addDirective(tmp, "Always sign commits with GPG");
    const all = await readDirectives(tmp);
    assert.equal(all.length, 1, "same text/scope does not duplicate");
    assert.equal(a.id, all[0]?.id);
  });

  test("same text under a different scope is a distinct directive", async () => {
    await addDirective(tmp, "Always sign commits with GPG", { scope: "src/auth/**" });
    const all = await readDirectives(tmp);
    assert.equal(all.length, 2);
  });

  test("empty text is rejected", async () => {
    await assert.rejects(() => addDirective(tmp, "   "));
  });

  test("remove by id", async () => {
    const before = await readDirectives(tmp);
    const removed = await removeDirective(tmp, before[0]!.id);
    assert.equal(removed, true);
    assert.equal((await readDirectives(tmp)).length, before.length - 1);
    assert.equal(await removeDirective(tmp, "d-nope00"), false);
  });

  test("formatDirectivesBlock renders markdown; empty for none", () => {
    assert.equal(formatDirectivesBlock([]), "");
    const block = formatDirectivesBlock([
      { id: "d-1", text: "Use ed25519, never RSA", scope: "global", createdAt: "x" },
      { id: "d-2", text: "No console.log in prod", scope: "src/**", createdAt: "x" },
    ]);
    assert.match(block, /## Standing directives/);
    assert.match(block, /- Use ed25519, never RSA/);
    assert.match(block, /_\(scope: src\/\*\*\)_/);
  });
});
