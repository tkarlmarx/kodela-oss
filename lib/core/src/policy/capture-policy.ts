// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * `.kodela/capture-policy.yaml` parser + enforcement — Phase 5 of doc 23.
 *
 * Governs which capture events are allowed to leave the host process.  Four
 * concerns, each independently optional:
 *
 *   - **agents**:    allow/deny list of AI tool names that can write annotations
 *   - **paths**:     glob exclusions (e.g. `secrets/**`, `.env*`) — drop any
 *                    capture targeting an excluded path
 *   - **redact**:    list of `{ field, pattern, replace }` rules that mutate
 *                    string values inside annotations before they're persisted
 *   - **synthesis**: model allowlist for the synthesis worker — keeps an org
 *                    from accidentally calling a non-approved LLM
 *
 * Loaded from `.kodela/capture-policy.yaml`.  If the file is absent the policy
 * is open ("nothing excluded, every agent allowed") — production behaviour
 * unchanged for repos that haven't opted in.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import * as YAML from "yaml";

// ── Schema ──────────────────────────────────────────────────────────────────

export const RedactRuleSchema = z.object({
  /** Field name inside annotation payload to apply this rule to. */
  field: z.string().min(1),
  /** ECMAScript regex source (no slashes). Applied with `g` flag. */
  pattern: z.string().min(1),
  /** Replacement string (supports $1 etc.). Defaults to "***". */
  replace: z.string().default("***"),
});
export type RedactRule = z.infer<typeof RedactRuleSchema>;

export const CapturePolicySchema = z.object({
  version: z.literal(1).default(1),
  agents: z
    .object({
      allow: z.array(z.string().min(1)).optional(),
      deny: z.array(z.string().min(1)).optional(),
    })
    .default({}),
  paths: z
    .object({
      exclude: z.array(z.string().min(1)).default([]),
    })
    .default({ exclude: [] }),
  redact: z.array(RedactRuleSchema).default([]),
  synthesis: z
    .object({
      model_allowlist: z.array(z.string().min(1)).optional(),
    })
    .default({}),
});
export type CapturePolicy = z.infer<typeof CapturePolicySchema>;

export const OPEN_POLICY: CapturePolicy = CapturePolicySchema.parse({});

// ── Loader ──────────────────────────────────────────────────────────────────

const POLICY_FILENAME = ".kodela/capture-policy.yaml";

/**
 * Resolve the on-disk policy file path for a repo root.  Public so callers can
 * surface "did this repo opt into a policy?" without reading the file.
 */
export function capturePolicyPathFor(repoRoot: string): string {
  return path.join(repoRoot, POLICY_FILENAME);
}

/**
 * Load + validate the policy YAML.  Returns:
 *   - `OPEN_POLICY` when the file is absent (production default; no policy file = no enforcement)
 *   - throws when the YAML parses but fails the zod schema
 *   - throws when the YAML is malformed
 *
 * Callers that should never throw on a bad policy file should wrap this.
 */
export async function loadCapturePolicy(repoRoot: string): Promise<CapturePolicy> {
  const filePath = capturePolicyPathFor(repoRoot);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return OPEN_POLICY;
    throw err;
  }
  const parsed = YAML.parse(raw);
  return CapturePolicySchema.parse(parsed ?? {});
}

// ── Enforcement primitives ──────────────────────────────────────────────────

/**
 * Match a repo-relative path against a glob.  Subset glob: supports
 * `*`, `**`, and `?`. No braces, no negation.  Deliberately small — the policy
 * file is human-authored and we want predictable semantics.
 */
export function globMatches(glob: string, repoRelativePath: string): boolean {
  const normalisedPath = repoRelativePath.replace(/^\.\//, "").replace(/\\/g, "/");
  // Translate glob to RegExp source.
  let rx = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*" && glob[i + 1] === "*") {
      rx += ".*";
      i++; // skip second *
      // Optional trailing "/" after ** so `secrets/**` matches `secrets/foo.txt` and `secrets`.
      if (glob[i + 1] === "/") {
        rx += "/?";
        i++;
      }
    } else if (ch === "*") {
      rx += "[^/]*";
    } else if (ch === "?") {
      rx += "[^/]";
    } else if (/[.+^$()|[\]{}\\]/.test(ch)) {
      rx += `\\${ch}`;
    } else {
      rx += ch;
    }
  }
  rx += "$";
  return new RegExp(rx).test(normalisedPath);
}

/** True when `repoRelativePath` is excluded by any glob in `policy.paths.exclude`. */
export function isPathExcluded(policy: CapturePolicy, repoRelativePath: string): boolean {
  for (const glob of policy.paths.exclude) {
    if (globMatches(glob, repoRelativePath)) return true;
  }
  return false;
}

/** True when `agentTool` is allowed by the policy. */
export function isAgentAllowed(policy: CapturePolicy, agentTool: string): boolean {
  const { allow, deny } = policy.agents;
  if (deny && deny.includes(agentTool)) return false;
  if (allow && allow.length > 0) return allow.includes(agentTool);
  return true;
}

/** True when the synthesis worker is permitted to invoke `model`. */
export function isModelAllowed(policy: CapturePolicy, model: string): boolean {
  const { model_allowlist } = policy.synthesis;
  if (!model_allowlist || model_allowlist.length === 0) return true;
  return model_allowlist.includes(model);
}

/**
 * Apply every redact rule that matches one of the supplied fields.  Mutates a
 * shallow copy — the input object is not modified.  Rules whose `field` is
 * absent from the payload are no-ops.
 */
export function applyRedactRules<T extends Record<string, unknown>>(
  policy: CapturePolicy,
  payload: T,
): T {
  if (policy.redact.length === 0) return payload;
  const out: Record<string, unknown> = { ...payload };
  for (const rule of policy.redact) {
    const value = out[rule.field];
    if (typeof value !== "string") continue;
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, "g");
    } catch {
      // Skip malformed regex rules silently — surface via tests / lint, not at
      // runtime, since a bad rule shouldn't break capture.
      continue;
    }
    out[rule.field] = value.replace(regex, rule.replace);
  }
  return out as T;
}

// ── Decision API ────────────────────────────────────────────────────────────

export type CaptureDecision =
  | { allow: true }
  | { allow: false; reason: "path_excluded" | "agent_denied" | "agent_not_allowed"; detail: string };

/**
 * Single-call gate the MCP server / synthesis worker uses before persisting a
 * capture event. Returns a tagged result so callers can log the reason into
 * the hash-chain audit log.
 */
export function evaluateCapture(
  policy: CapturePolicy,
  args: { filePath?: string; agentTool?: string },
): CaptureDecision {
  if (args.filePath && isPathExcluded(policy, args.filePath)) {
    return { allow: false, reason: "path_excluded", detail: `path matches an excluded glob` };
  }
  if (args.agentTool && !isAgentAllowed(policy, args.agentTool)) {
    const { allow, deny } = policy.agents;
    if (deny && deny.includes(args.agentTool)) {
      return { allow: false, reason: "agent_denied", detail: `tool '${args.agentTool}' is in deny list` };
    }
    return { allow: false, reason: "agent_not_allowed", detail: `tool '${args.agentTool}' is not in allow list` };
  }
  return { allow: true };
}
