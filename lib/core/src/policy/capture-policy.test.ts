// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadCapturePolicy,
  OPEN_POLICY,
  globMatches,
  isPathExcluded,
  isAgentAllowed,
  isModelAllowed,
  applyRedactRules,
  evaluateCapture,
  CapturePolicySchema,
} from "./capture-policy.js";

async function withRepo(yaml: string | null, fn: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-policy-"));
  try {
    if (yaml !== null) {
      await fs.mkdir(path.join(repoRoot, ".kodela"), { recursive: true });
      await fs.writeFile(path.join(repoRoot, ".kodela/capture-policy.yaml"), yaml, "utf8");
    }
    await fn(repoRoot);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
}

// ── globMatches ─────────────────────────────────────────────────────────────

test("globMatches: `secrets/**` matches files under secrets/", () => {
  assert.equal(globMatches("secrets/**", "secrets/foo.txt"), true);
  assert.equal(globMatches("secrets/**", "secrets/sub/nested/foo.txt"), true);
  // `secrets/**` does NOT match the dir name alone — capture events always
  // carry a file path, never a bare directory.  Match-the-dir is an explicit
  // non-goal; users wanting it can write `secrets` AND `secrets/**`.
  assert.equal(globMatches("secrets/**", "secrets"), false);
  assert.equal(globMatches("secrets/**", "other/foo.txt"), false);
});

test("globMatches: `*.env` matches dotted top-level files", () => {
  assert.equal(globMatches("*.env", "prod.env"), true);
  assert.equal(globMatches(".env*", ".env"), true);
  assert.equal(globMatches(".env*", ".env.local"), true);
  assert.equal(globMatches(".env*", "sub/.env"), false); // not recursive
});

test("globMatches: `*` does not cross slashes; `**` does", () => {
  assert.equal(globMatches("src/*.ts", "src/foo.ts"), true);
  assert.equal(globMatches("src/*.ts", "src/sub/foo.ts"), false);
  assert.equal(globMatches("src/**/foo.ts", "src/sub/foo.ts"), true);
});

// ── loadCapturePolicy ───────────────────────────────────────────────────────

test("loadCapturePolicy: missing file returns OPEN_POLICY (no enforcement)", async () => {
  await withRepo(null, async (repoRoot) => {
    const policy = await loadCapturePolicy(repoRoot);
    assert.deepEqual(policy, OPEN_POLICY);
  });
});

test("loadCapturePolicy: parses a complete file", async () => {
  const yaml = `
version: 1
agents:
  allow: ["claude-code", "cursor"]
  deny: ["unknown-tool"]
paths:
  exclude:
    - "secrets/**"
    - ".env*"
redact:
  - field: "ai_reasoning"
    pattern: "API_KEY=[\\\\w-]+"
    replace: "API_KEY=***"
synthesis:
  model_allowlist: ["claude-haiku-4-5", "gpt-4o-mini"]
`;
  await withRepo(yaml, async (repoRoot) => {
    const policy = await loadCapturePolicy(repoRoot);
    assert.deepEqual(policy.agents.allow, ["claude-code", "cursor"]);
    assert.deepEqual(policy.agents.deny, ["unknown-tool"]);
    assert.deepEqual(policy.paths.exclude, ["secrets/**", ".env*"]);
    assert.equal(policy.redact.length, 1);
    assert.equal(policy.redact[0]!.field, "ai_reasoning");
    assert.deepEqual(policy.synthesis.model_allowlist, ["claude-haiku-4-5", "gpt-4o-mini"]);
  });
});

test("CapturePolicySchema rejects unknown version", () => {
  const r = CapturePolicySchema.safeParse({ version: 99 });
  assert.equal(r.success, false);
});

// ── isPathExcluded ──────────────────────────────────────────────────────────

test("isPathExcluded: secrets/** excludes a real path", () => {
  const policy = CapturePolicySchema.parse({ paths: { exclude: ["secrets/**", "test-fixtures/**"] } });
  assert.equal(isPathExcluded(policy, "secrets/foo.txt"), true);
  assert.equal(isPathExcluded(policy, "test-fixtures/auth.json"), true);
  assert.equal(isPathExcluded(policy, "src/auth.ts"), false);
});

// ── isAgentAllowed ──────────────────────────────────────────────────────────

test("isAgentAllowed: empty allow list = allow all", () => {
  const policy = OPEN_POLICY;
  assert.equal(isAgentAllowed(policy, "claude-code"), true);
  assert.equal(isAgentAllowed(policy, "anything"), true);
});

test("isAgentAllowed: deny list overrides allow", () => {
  const policy = CapturePolicySchema.parse({
    agents: { allow: ["claude-code", "cursor"], deny: ["claude-code"] },
  });
  assert.equal(isAgentAllowed(policy, "claude-code"), false);
  assert.equal(isAgentAllowed(policy, "cursor"), true);
});

test("isAgentAllowed: when allow list present, anything outside it is rejected", () => {
  const policy = CapturePolicySchema.parse({ agents: { allow: ["claude-code"] } });
  assert.equal(isAgentAllowed(policy, "claude-code"), true);
  assert.equal(isAgentAllowed(policy, "cursor"), false);
});

// ── isModelAllowed ──────────────────────────────────────────────────────────

test("isModelAllowed: no allowlist = allow all", () => {
  assert.equal(isModelAllowed(OPEN_POLICY, "claude-opus-4-7"), true);
});

test("isModelAllowed: allowlist enforced", () => {
  const policy = CapturePolicySchema.parse({ synthesis: { model_allowlist: ["claude-haiku-4-5"] } });
  assert.equal(isModelAllowed(policy, "claude-haiku-4-5"), true);
  assert.equal(isModelAllowed(policy, "gpt-4o"), false);
});

// ── applyRedactRules ────────────────────────────────────────────────────────

test("applyRedactRules: rewrites matching fields, leaves others alone", () => {
  const policy = CapturePolicySchema.parse({
    redact: [
      { field: "ai_reasoning", pattern: "sk-ant-[\\w-]+", replace: "<ANTHROPIC>" },
      { field: "why_changed", pattern: "AWS_SECRET_ACCESS_KEY=\\S+", replace: "AWS=***" },
    ],
  });
  const before = {
    ai_reasoning: "used sk-ant-xyz123 to sign requests",
    why_changed: "Set AWS_SECRET_ACCESS_KEY=ABC to fix the deploy",
    note: "untouched",
  };
  const after = applyRedactRules(policy, before);
  assert.equal(after.ai_reasoning, "used <ANTHROPIC> to sign requests");
  assert.equal(after.why_changed, "Set AWS=*** to fix the deploy");
  assert.equal(after.note, "untouched");
  // Original object is not mutated.
  assert.equal(before.ai_reasoning, "used sk-ant-xyz123 to sign requests");
});

test("applyRedactRules: malformed regex is skipped silently, doesn't throw", () => {
  const policy = CapturePolicySchema.parse({
    redact: [{ field: "note", pattern: "[unclosed", replace: "x" }],
  });
  const out = applyRedactRules(policy, { note: "hi" });
  assert.equal(out.note, "hi"); // unchanged
});

test("applyRedactRules: non-string field values are ignored", () => {
  const policy = CapturePolicySchema.parse({
    redact: [{ field: "count", pattern: "\\d+", replace: "X" }],
  });
  const out = applyRedactRules(policy, { count: 42 });
  assert.equal(out.count, 42); // untouched, not coerced to string
});

// ── evaluateCapture ─────────────────────────────────────────────────────────

test("evaluateCapture: open policy allows everything", () => {
  const r = evaluateCapture(OPEN_POLICY, { filePath: "secrets/foo", agentTool: "claude-code" });
  assert.equal(r.allow, true);
});

test("evaluateCapture: path exclusion wins (returned before agent check)", () => {
  const policy = CapturePolicySchema.parse({
    paths: { exclude: ["secrets/**"] },
    agents: { allow: ["claude-code"] },
  });
  const r = evaluateCapture(policy, { filePath: "secrets/x", agentTool: "claude-code" });
  assert.equal(r.allow, false);
  if (!r.allow) assert.equal(r.reason, "path_excluded");
});

test("evaluateCapture: denied agent returns agent_denied reason", () => {
  const policy = CapturePolicySchema.parse({ agents: { deny: ["bad-tool"] } });
  const r = evaluateCapture(policy, { filePath: "src/foo.ts", agentTool: "bad-tool" });
  assert.equal(r.allow, false);
  if (!r.allow) assert.equal(r.reason, "agent_denied");
});

test("evaluateCapture: not-in-allow-list returns agent_not_allowed reason", () => {
  const policy = CapturePolicySchema.parse({ agents: { allow: ["claude-code"] } });
  const r = evaluateCapture(policy, { filePath: "src/foo.ts", agentTool: "cursor" });
  assert.equal(r.allow, false);
  if (!r.allow) assert.equal(r.reason, "agent_not_allowed");
});
