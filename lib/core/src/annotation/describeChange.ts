// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Change describer — turns diff signals into a meaningful auto-capture *why*
 * when no AI summary is available, so the fallback is specific ("Added
 * `rotateToken` in session.ts") instead of a generic template ("AI change — 2
 * hunks"). Deepens the shallow auto-capture the competitive audit flagged.
 *
 * Pure and deterministic. Callers pass the file path, the symbols the change
 * added/touched (extracted from the hunk regions), and coarse size signals.
 */

export type FileRole = "test" | "config" | "docs" | "ci" | "types" | "styles" | "schema" | "source";

const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** Classify a file by path so the description can name what kind of change it is. */
export function fileRole(path: string): FileRole {
  const p = path.toLowerCase();
  const base = basename(p);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base) || /(^|\/)(tests?|__tests__)\//.test(p)) return "test";
  if (/(^|\/)\.github\//.test(p) || /\.ya?ml$/.test(base) && p.includes("workflow")) return "ci";
  if (/\.d\.ts$/.test(base)) return "types";
  if (/\.(css|scss|sass|less)$/.test(base)) return "styles";
  if (/\.(md|mdx|rst|txt)$/.test(base)) return "docs";
  if (/\.(sql)$/.test(base) || /(^|\/)(migrations?|schema)\//.test(p) || /schema\.[jt]s$/.test(base)) return "schema";
  if (
    base === "package.json" ||
    base === "tsconfig.json" ||
    /\.config\.[cm]?[jt]s$/.test(base) ||
    /\.(ya?ml|toml|ini|env)$/.test(base) ||
    /^\.[a-z]/.test(base)
  ) {
    return "config";
  }
  return "source";
}

/** Symbol-definition patterns to pull names out of an added/changed region. */
const SYMBOL_PATTERNS: RegExp[] = [
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /\b(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /\bdef\s+([A-Za-z_][\w]*)\s*\(/g, // python
];

/** Extract up to `limit` symbol names defined in the given lines of code. */
export function extractSymbols(lines: string[], limit = 3): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const text = lines.join("\n");
  for (const re of SYMBOL_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      if (name && !seen.has(name)) {
        seen.add(name);
        found.push(name);
        if (found.length >= limit) return found;
      }
    }
  }
  return found;
}

export interface ChangeSignals {
  filePath: string;
  /** Symbols defined in the changed region (from extractSymbols). */
  addedSymbols?: string[];
  hunkCount: number;
  /** Nearest enclosing symbol/heading, if known. */
  nearestHeading?: string | null;
}

const ROLE_PHRASE: Record<Exclude<FileRole, "source">, string> = {
  test: "Adjusted tests",
  config: "Updated configuration",
  docs: "Edited documentation",
  ci: "Updated CI workflow",
  types: "Updated type declarations",
  styles: "Updated styles",
  schema: "Changed the schema",
};

/**
 * Produce a concise, specific description of a change from its signals. Never
 * throws; always returns a non-empty string.
 */
export function describeChange(sig: ChangeSignals): string {
  const base = basename(sig.filePath);
  const role = fileRole(sig.filePath);
  const symbols = (sig.addedSymbols ?? []).filter(Boolean).slice(0, 3);

  if (symbols.length > 0) {
    const verb = role === "test" ? "Added test" : "Added";
    const names = symbols.map((s) => `\`${s}\``).join(", ");
    return `${verb} ${names} in ${base}`;
  }

  if (role !== "source") {
    const hunkPart = sig.hunkCount > 1 ? ` (${sig.hunkCount} hunks)` : "";
    return `${ROLE_PHRASE[role]} in ${base}${hunkPart}`;
  }

  if (sig.nearestHeading) {
    return `Modified \`${sig.nearestHeading}\` in ${base}`;
  }
  const hunkPart = sig.hunkCount === 1 ? "1 hunk" : `${sig.hunkCount} hunks`;
  return `Modified ${base} — ${hunkPart}`;
}
