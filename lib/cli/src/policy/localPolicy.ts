// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { LocalPolicySchema } from "@kodela/core";
import type { LocalPolicy } from "@kodela/core";

const LOCAL_POLICY_FILE = ".kodela/policy.json";

/**
 * Gap 56 — Load the local policy file from `<repoRoot>/.kodela/policy.json`.
 *
 * Returns `null` when the file does not exist (policy is optional).
 * Throws a descriptive `Error` when the file exists but fails schema validation
 * or JSON parsing, so callers can surface the issue to the user.
 */
export async function loadLocalPolicy(repoRoot: string): Promise<LocalPolicy | null> {
  const policyPath = path.join(repoRoot, LOCAL_POLICY_FILE);

  let raw: string;
  try {
    raw = await fs.readFile(policyPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(
      `Failed to read local policy file at ${policyPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Local policy file at ${policyPath} is not valid JSON. Run \`kodela policy validate\` for details.`,
    );
  }

  const result = LocalPolicySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".")} — ${i.message}`)
      .join("\n");
    throw new Error(
      `Local policy file at ${policyPath} failed schema validation:\n${issues}`,
    );
  }

  return result.data;
}

/**
 * Return the canonical path where the local policy file should be written.
 */
export function localPolicyPath(repoRoot: string): string {
  return path.join(repoRoot, LOCAL_POLICY_FILE);
}
