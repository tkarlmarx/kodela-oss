// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela directive` (Phase 1) — manage standing instructions that every AI
 * session should honour. Thin wrapper over @kodela/core/directives; the value
 * is that these get injected into the Memory Bank agents read at task start.
 *
 *   kodela directive add "Always sign commits with GPG"
 *   kodela directive list
 *   kodela directive rm d-3f9a2c
 */
import {
  readDirectives,
  addDirective,
  removeDirective,
  type Directive,
} from "@kodela/core/directives";

export async function runDirectiveAdd(
  repoRoot: string,
  text: string,
  opts: { scope?: string; createdBy?: string } = {},
): Promise<Directive> {
  return addDirective(repoRoot, text, opts);
}

export async function runDirectiveList(repoRoot: string): Promise<Directive[]> {
  return readDirectives(repoRoot);
}

export async function runDirectiveRemove(repoRoot: string, id: string): Promise<boolean> {
  return removeDirective(repoRoot, id);
}

export function formatDirectiveList(directives: Directive[]): string {
  if (directives.length === 0) {
    return "No standing directives yet. Add one:\n  kodela directive add \"Always sign commits with GPG\"";
  }
  const lines = [`${directives.length} standing directive${directives.length === 1 ? "" : "s"}:`, ""];
  for (const d of directives) {
    const scope = d.scope && d.scope !== "global" ? `  (scope: ${d.scope})` : "";
    lines.push(`  ${d.id}  ${d.text}${scope}`);
  }
  lines.push("", "These are injected into the Memory Bank agents read at the start of every task.");
  return lines.join("\n");
}
