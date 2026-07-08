// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela config-pull` — inherit the org-wide config from the central server.
 *
 * Closes the admin-panel → repo loop: an operator sets defaults once in the
 * dashboard (Admin → Configuration, stored server-side), and each repo pulls
 * them into its `kodela.config.json`. Canonical settings map to their real
 * config paths so the CLI/agents actually use them; the full org policy is also
 * recorded under `orgPolicy` for transparency.
 *
 * Precedence (per key):
 *   - LOCKED keys (org `locked[]`)     → the org value always wins.
 *   - non-locked, repo has NOT set it  → the org value fills it in.
 *   - non-locked, repo HAS set it      → the repo value is kept (repo overrides).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadLicense } from "@kodela/core";

/** The admin-managed org settings (mirror of the server's orgConfigValueSchema). */
export interface OrgConfigValue {
  serverUrl?: string;
  storageMode?: "local" | "central";
  readMode?: "local" | "remote" | "merge";
  ciEnforcement?: "advisory" | "enforcement";
  captureTier?: "enforced" | "assisted" | "ambient";
  retentionDays?: number;
  allowedAiTools?: string[];
  encryptionRequired?: boolean;
  locked?: string[];
}

type RawConfig = Record<string, unknown>;

export type MergeOutcome = "applied" | "locked-override" | "kept-repo-value";

export interface MergeResult {
  config: RawConfig;
  changes: Array<{ key: string; target: string; outcome: MergeOutcome; value: unknown }>;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

/** One canonical org-key → config-path mapping. */
interface Mapping {
  key: keyof OrgConfigValue;
  target: string;
  isSet: (raw: RawConfig) => boolean;
  apply: (raw: RawConfig, value: unknown) => void;
}

const MAPPINGS: Mapping[] = [
  {
    key: "serverUrl",
    target: "storage.server.url",
    isSet: (raw) => Boolean((obj(raw.storage).server as Record<string, unknown> | undefined)?.url),
    apply: (raw, value) => {
      const storage = obj(raw.storage);
      const server = obj(storage.server);
      server.url = value;
      if (!server.api_key_env) server.api_key_env = "KODELA_API_KEY";
      storage.server = server;
      raw.storage = storage;
    },
  },
  {
    key: "storageMode",
    target: "storage.mode",
    isSet: (raw) => obj(raw.storage).mode !== undefined,
    apply: (raw, value) => {
      const storage = obj(raw.storage);
      storage.mode = value;
      raw.storage = storage;
    },
  },
  {
    key: "readMode",
    target: "storage.readMode",
    isSet: (raw) => obj(raw.storage).readMode !== undefined,
    apply: (raw, value) => {
      const storage = obj(raw.storage);
      storage.readMode = value;
      raw.storage = storage;
    },
  },
  {
    key: "ciEnforcement",
    target: "ci.enforcement",
    isSet: (raw) => obj(raw.ci).enforcement !== undefined,
    apply: (raw, value) => {
      const ci = obj(raw.ci);
      ci.enforcement = value;
      raw.ci = ci;
    },
  },
];

/**
 * Merge an org config into a raw kodela.config.json object. Pure — returns a new
 * object and the list of what changed. Locked keys override; otherwise org
 * values only fill fields the repo hasn't set.
 */
export function mergeOrgConfig(rawConfig: RawConfig, org: OrgConfigValue): MergeResult {
  const config: RawConfig = { ...rawConfig };
  const locked = new Set(org.locked ?? []);
  const changes: MergeResult["changes"] = [];

  for (const m of MAPPINGS) {
    const value = org[m.key];
    if (value === undefined) continue;
    const repoHasIt = m.isSet(config);
    if (locked.has(m.key)) {
      m.apply(config, value);
      changes.push({ key: m.key, target: m.target, outcome: "locked-override", value });
    } else if (!repoHasIt) {
      m.apply(config, value);
      changes.push({ key: m.key, target: m.target, outcome: "applied", value });
    } else {
      changes.push({ key: m.key, target: m.target, outcome: "kept-repo-value", value });
    }
  }

  // Record the full org policy for transparency + fields without a canonical
  // config path (captureTier, retentionDays, allowedAiTools, encryptionRequired).
  config.orgPolicy = { ...org };

  return { config, changes };
}

export class ConfigPullError extends Error {
  constructor(message: string, public readonly remediation?: string) {
    super(message);
    this.name = "ConfigPullError";
  }
}

export interface ConfigPullOptions {
  repoRoot: string;
  serverUrl?: string;
  apiKey?: string;
  orgId?: string;
  dryRun?: boolean;
}

export interface ConfigPullResult {
  orgId: string;
  serverUrl: string;
  updatedAt: string | null;
  changes: MergeResult["changes"];
  dryRun: boolean;
}

async function readRawConfig(repoRoot: string): Promise<RawConfig> {
  try {
    const raw = await readFile(join(repoRoot, "kodela.config.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as RawConfig) : {};
  } catch {
    return {};
  }
}

export async function runConfigPull(opts: ConfigPullOptions): Promise<ConfigPullResult> {
  const { repoRoot } = opts;
  const raw = await readRawConfig(repoRoot);

  const serverUrl =
    opts.serverUrl ??
    ((obj(raw.storage).server as Record<string, unknown> | undefined)?.url as string | undefined);
  const apiKey = opts.apiKey ?? process.env.KODELA_API_KEY;
  const orgId =
    opts.orgId ?? process.env.KODELA_ORG_ID ?? (await loadLicense(repoRoot))?.orgId ?? undefined;

  if (!serverUrl) {
    throw new ConfigPullError(
      "No server URL — cannot fetch org config.",
      "→ pass --server, or set storage.server.url in kodela.config.json",
    );
  }
  if (!apiKey) {
    throw new ConfigPullError(
      "No API key.",
      "→ pass --api-key or set KODELA_API_KEY",
    );
  }
  if (!orgId) {
    throw new ConfigPullError(
      "No organization id for the X-Kodela-Org-Id header.",
      "→ pass --org-id, set KODELA_ORG_ID, or install your org license",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${serverUrl.replace(/\/$/, "")}/api/admin/org-config`, {
      headers: { Authorization: `Bearer ${apiKey}`, "X-Kodela-Org-Id": orgId },
    });
  } catch (err) {
    throw new ConfigPullError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ConfigPullError(`Server returned HTTP ${res.status}: ${body || "(empty)"}`);
  }
  const payload = (await res.json()) as { orgId?: string; config?: OrgConfigValue; updatedAt?: string | null };
  const org = payload.config ?? {};

  const { config, changes } = mergeOrgConfig(raw, org);

  if (!opts.dryRun) {
    await writeFile(join(repoRoot, "kodela.config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
  }

  return {
    orgId: payload.orgId ?? orgId,
    serverUrl,
    updatedAt: payload.updatedAt ?? null,
    changes,
    dryRun: opts.dryRun ?? false,
  };
}

export function formatConfigPullResult(result: ConfigPullResult): string {
  const lines: string[] = [];
  lines.push(result.dryRun ? "Dry-run — org config fetched, nothing written:" : "Org config pulled into kodela.config.json:");
  lines.push("");
  lines.push(`  Org    : ${result.orgId}`);
  lines.push(`  Server : ${result.serverUrl}`);
  if (result.updatedAt) lines.push(`  Policy updated: ${result.updatedAt}`);
  lines.push("");
  if (result.changes.length === 0) {
    lines.push("  No inheritable settings in the org config.");
  } else {
    for (const c of result.changes) {
      const mark = c.outcome === "locked-override" ? "🔒 locked → set" : c.outcome === "applied" ? "✓ applied" : "• kept repo value";
      lines.push(`  ${mark.padEnd(18)} ${c.target} = ${JSON.stringify(c.value)}`);
    }
  }
  return lines.join("\n");
}

export function handleConfigPullError(err: unknown): never {
  if (err instanceof ConfigPullError) {
    process.stderr.write(`Error: ${err.message}\n`);
    if (err.remediation) process.stderr.write(`${err.remediation}\n`);
    process.exit(1);
  }
  throw err;
}
