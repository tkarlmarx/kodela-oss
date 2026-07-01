// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Plain-English descriptions for comprehension nodes (Phase 2 — P2.1).
 *
 * Offline-first: the community edition must produce readable descriptions with
 * **no API key** (project DNA: "we do not require a cloud account for local
 * single-developer use"). So the default describer is a deterministic heuristic
 * that turns a name + kind + any captured note into a sentence. An AI describer
 * can be layered on later behind the same `Describer` seam; when a node already
 * has a human-written note we prefer that verbatim over any guess.
 */

import type { CodeGraphFunction } from "../code-graph/types.js";

/** camelCase / snake_case / PascalCase / kebab → lower-case words. */
export function humanizeIdentifier(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Verb phrases inferred from a leading verb in the identifier. */
const VERB_HINTS: Record<string, string> = {
  get: "reads",
  fetch: "fetches",
  read: "reads",
  load: "loads",
  list: "lists",
  find: "looks up",
  search: "searches",
  query: "queries",
  set: "sets",
  update: "updates",
  write: "writes",
  save: "persists",
  store: "stores",
  create: "creates",
  make: "builds",
  build: "builds",
  add: "adds",
  insert: "inserts",
  remove: "removes",
  delete: "deletes",
  del: "deletes",
  drop: "drops",
  parse: "parses",
  format: "formats",
  render: "renders",
  compute: "computes",
  calculate: "computes",
  validate: "validates",
  check: "checks",
  ensure: "ensures",
  resolve: "resolves",
  handle: "handles",
  run: "runs",
  exec: "executes",
  init: "initialises",
  is: "reports whether",
  has: "reports whether",
  should: "decides whether",
  to: "converts to",
  on: "responds to",
};

/**
 * Heuristic one-line description of a function/class/method from its name (+
 * optional file context). Deterministic and dependency-free.
 */
export function heuristicFunctionDescription(fn: CodeGraphFunction): string {
  const words = humanizeIdentifier(fn.name);
  const [first, ...rest] = words.split(" ");
  const restPhrase = rest.join(" ").trim();

  if (fn.kind === "class") {
    return `The \`${fn.name}\` class${restPhrase ? ` — models ${words}` : ""}.`;
  }

  // Object.hasOwn guards against prototype-chain names like "constructor" or
  // "toString", which would otherwise resolve to inherited Object.prototype
  // members (truthy) and crash the describer on every class constructor.
  const verb = first && Object.hasOwn(VERB_HINTS, first) ? VERB_HINTS[first] : undefined;
  const subjectRole = fn.kind === "method" && fn.parent ? ` on \`${fn.parent}\`` : "";
  if (verb) {
    const object = restPhrase || "its input";
    return `${cap(verb)} ${object}${subjectRole}.`;
  }
  // No known verb — describe by role.
  const roleWord =
    fn.kind === "method" ? "method" : fn.kind === "generator" ? "generator" : "function";
  return `The \`${fn.name}\` ${roleWord}${subjectRole ? subjectRole : ""} — handles ${words}.`;
}

/** Heuristic description of a file node from its path. */
export function heuristicFileDescription(
  filePath: string,
  functionCount: number,
  classNames: string[],
): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  const area = dir ? ` in \`${dir}\`` : "";
  const parts: string[] = [];
  if (classNames.length > 0) {
    parts.push(`defines ${classNames.length === 1 ? "the" : ""} ${classNames.map((c) => `\`${c}\``).join(", ")} ${classNames.length === 1 ? "class" : "classes"}`);
  }
  if (functionCount > 0) {
    parts.push(`${functionCount} function${functionCount === 1 ? "" : "s"}`);
  }
  const body = parts.length ? ` — ${parts.join(" and ")}` : "";
  return `\`${base}\`${area}${body}.`;
}

function cap(s: string): string {
  return s && s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * Pick the best available description for a node, preferring a human note over a
 * heuristic guess. Returns the text plus its provenance so the UI can badge it.
 */
export function bestDescription(
  heuristic: string,
  note: string | undefined,
): { description: string; source: "heuristic" | "note" } {
  const trimmed = note?.trim();
  if (trimmed && trimmed.length >= 12) {
    // A captured note is ground truth — use it, capped so a huge note doesn't
    // blow up the graph payload.
    const capped = trimmed.length > 280 ? `${trimmed.slice(0, 280).trimEnd()}…` : trimmed;
    return { description: capped, source: "note" };
  }
  return { description: heuristic, source: "heuristic" };
}
