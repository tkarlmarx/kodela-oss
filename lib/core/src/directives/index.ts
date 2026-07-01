// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Directives (Phase 1) — standing instructions the developer wants every AI
 * session to honour, auto-loaded so nobody has to re-paste "always sign commits
 * with GPG" or "we use ed25519, never RSA" into each new chat.
 *
 * A directive is durable, human-authored project memory (it does NOT auto-create
 * decisions — it's a lighter, always-on instruction). Stored as a small JSON
 * file at `.kodela/directives.json` so it travels with the repo and is injected
 * into the Memory Bank / context every agent reads at the start of a task.
 *
 * Pure I/O over the file; no network, no key — the local-first default.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const DIRECTIVES_FILE = ".kodela/directives.json";

export interface Directive {
  /** Short stable id, e.g. `d-3f9a2c`. */
  id: string;
  /** The standing instruction text. */
  text: string;
  /**
   * Where it applies. `global` (default) = every session. A repo-relative path
   * or glob scopes it to matching files (advisory — consumers may honour it).
   */
  scope: string;
  createdAt: string;
  /** Who added it (actor id / email); optional. */
  createdBy?: string;
}

interface DirectivesFile {
  version: 1;
  directives: Directive[];
}

function shortId(): string {
  return `d-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
}

/** Read all directives (empty when the file is missing or malformed). */
export async function readDirectives(repoRoot: string): Promise<Directive[]> {
  try {
    const raw = await fs.readFile(path.join(repoRoot, DIRECTIVES_FILE), "utf-8");
    const parsed = JSON.parse(raw) as Partial<DirectivesFile>;
    return Array.isArray(parsed.directives) ? parsed.directives.filter(isDirective) : [];
  } catch {
    return [];
  }
}

function isDirective(d: unknown): d is Directive {
  return (
    typeof d === "object" &&
    d !== null &&
    typeof (d as Directive).id === "string" &&
    typeof (d as Directive).text === "string"
  );
}

async function writeDirectives(repoRoot: string, directives: Directive[]): Promise<void> {
  const file = path.join(repoRoot, DIRECTIVES_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body: DirectivesFile = { version: 1, directives };
  await fs.writeFile(file, JSON.stringify(body, null, 2) + "\n", "utf-8");
}

export interface AddDirectiveOptions {
  scope?: string;
  createdBy?: string;
  /** ISO timestamp; defaults to now. Pass for deterministic tests. */
  createdAt?: string;
}

/**
 * Add a directive. Returns the created (or existing, if the exact text +
 * scope already exists) directive — idempotent on text so re-running a setup
 * script doesn't pile up duplicates.
 */
export async function addDirective(
  repoRoot: string,
  text: string,
  opts: AddDirectiveOptions = {},
): Promise<Directive> {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("Directive text must not be empty.");
  const scope = (opts.scope ?? "global").trim() || "global";
  const existing = await readDirectives(repoRoot);

  const dup = existing.find((d) => d.text === trimmed && d.scope === scope);
  if (dup) return dup;

  const directive: Directive = {
    id: shortId(),
    text: trimmed,
    scope,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
  };
  await writeDirectives(repoRoot, [...existing, directive]);
  return directive;
}

/** Remove a directive by id. Returns true if one was removed. */
export async function removeDirective(repoRoot: string, id: string): Promise<boolean> {
  const existing = await readDirectives(repoRoot);
  const next = existing.filter((d) => d.id !== id);
  if (next.length === existing.length) return false;
  await writeDirectives(repoRoot, next);
  return true;
}

/**
 * Render directives as a markdown block for injection into the Memory Bank /
 * agent context. Returns an empty string when there are none (so callers can
 * concatenate unconditionally without leaving an empty heading).
 */
export function formatDirectivesBlock(
  directives: Directive[],
  opts: { heading?: string } = {},
): string {
  if (directives.length === 0) return "";
  const heading = opts.heading ?? "## Standing directives";
  const lines = directives.map((d) => {
    const scope = d.scope && d.scope !== "global" ? `  _(scope: ${d.scope})_` : "";
    return `- ${d.text}${scope}`;
  });
  return `${heading}\n\nInstructions to honour in every session:\n\n${lines.join("\n")}\n`;
}
