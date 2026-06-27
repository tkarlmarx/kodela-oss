// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { LocalPolicySchema, LOCAL_POLICY_SCHEMA_VERSION } from "@kodela/core";
import type { LocalPolicy } from "@kodela/core";
import { localPolicyPath } from "../policy/localPolicy.js";

export type PolicyValidateOptions = {
  repoRoot: string;
  file?: string;
};

export type PolicyValidateResult = {
  valid: boolean;
  filePath: string;
  issueCount: number;
  issues: string[];
  ruleCount: number;
  sessionRuleCount: number;
};

/**
 * Gap 56 — `kodela policy validate`
 *
 * Reads the policy file (default: `.kodela/policy.json`) and validates it
 * against the `LocalPolicySchema`.  Reports each validation issue with the
 * JSON path and a human-readable message.
 */
export async function runPolicyValidate(
  opts: PolicyValidateOptions,
): Promise<PolicyValidateResult> {
  const { repoRoot } = opts;
  const filePath = opts.file
    ? path.isAbsolute(opts.file)
      ? opts.file
      : path.resolve(repoRoot, opts.file)
    : localPolicyPath(repoRoot);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        valid: false,
        filePath,
        issueCount: 1,
        issues: [`Policy file not found at ${filePath}. Run \`kodela policy init\` to create one.`],
        ruleCount: 0,
        sessionRuleCount: 0,
      };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      valid: false,
      filePath,
      issueCount: 1,
      issues: ["File is not valid JSON"],
      ruleCount: 0,
      sessionRuleCount: 0,
    };
  }

  const result = LocalPolicySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`,
    );
    return {
      valid: false,
      filePath,
      issueCount: issues.length,
      issues,
      ruleCount: 0,
      sessionRuleCount: 0,
    };
  }

  const policy = result.data;
  return {
    valid: true,
    filePath,
    issueCount: 0,
    issues: [],
    ruleCount: policy.rules.length,
    sessionRuleCount: policy.sessionRules.length,
  };
}

export function formatPolicyValidateResult(result: PolicyValidateResult): string {
  const lines: string[] = [`Policy file: ${result.filePath}`];
  if (result.valid) {
    lines.push(
      `✓ Valid — ${result.ruleCount} rule${result.ruleCount !== 1 ? "s" : ""}, ` +
        `${result.sessionRuleCount} session rule${result.sessionRuleCount !== 1 ? "s" : ""}`,
    );
  } else {
    lines.push(`✗ Invalid — ${result.issueCount} issue${result.issueCount !== 1 ? "s" : ""}:`);
    for (const issue of result.issues) {
      lines.push(`  • ${issue}`);
    }
  }
  return lines.join("\n");
}

export type PolicyInitOptions = {
  repoRoot: string;
  force?: boolean;
};

export type PolicyInitResult = {
  created: boolean;
  skipped: boolean;
  filePath: string;
};

const STARTER_POLICY: LocalPolicy = {
  schemaVersion: LOCAL_POLICY_SCHEMA_VERSION,
  rules: [
    {
      id: "require-context-auth",
      pathGlob: "src/auth/**",
      requireContext: true,
      minConfidence: 0.8,
      requireReview: true,
      scope: ["auth"],
    },
    {
      id: "require-context-payments",
      pathGlob: "src/payments/**",
      requireContext: true,
      minConfidence: 0.9,
      requireReview: true,
      scope: ["payments"],
    },
    {
      id: "min-confidence-global",
      pathGlob: "src/**",
      minConfidence: 0.7,
    },
  ],
  sessionRules: [
    {
      id: "max-ai-pct",
      maxAiPct: 80,
    },
  ],
};

/**
 * Gap 56 — `kodela policy init`
 *
 * Generates a starter `.kodela/policy.json` with sensible defaults covering
 * auth and payments paths.  Skips silently when the file already exists
 * unless `--force` is passed.
 */
export async function runPolicyInit(opts: PolicyInitOptions): Promise<PolicyInitResult> {
  const { repoRoot, force = false } = opts;
  const filePath = localPolicyPath(repoRoot);

  if (!force) {
    try {
      await fs.access(filePath);
      return { created: false, skipped: true, filePath };
    } catch {
      // file does not exist — proceed
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(STARTER_POLICY, null, 2) + "\n", "utf-8");

  return { created: true, skipped: false, filePath };
}

export function formatPolicyInitResult(result: PolicyInitResult): string {
  if (result.skipped) {
    return (
      `Policy file already exists at ${result.filePath}. ` +
      `Run with --force to overwrite.`
    );
  }
  return `✓ Created policy file at ${result.filePath}`;
}
