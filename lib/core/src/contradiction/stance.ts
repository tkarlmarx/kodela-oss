// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Stance extraction — the transparent, no-LLM, no-network topic + polarity gate.
 *
 * This is Tier 1 (topic gate) + the polarity read of Tier 2 from the Phase-0
 * prototype (`prototypes/contradiction-detection/detect.mjs`), ported to typed
 * TS and hardened for real-world text. The topic gate is what keeps false
 * positives at ~0%: a change is only ever compared to a decision that ruled on
 * the *same entity*, so a change that merely mentions a technology is never
 * flagged against an unrelated decision.
 *
 * Two robustness rules beyond the prototype (both raise precision):
 *   1. WORD-BOUNDARY matching — "ast" no longer matches inside "datastore",
 *      "mongo" no longer matches inside a larger token, etc.
 *   2. NEAREST-ENTITY cue assignment — a polarity/primary cue is claimed by the
 *      entity mention closest to it, so "reject MongoDB but adopt Postgres" reads
 *      MongoDB=reject and Postgres=adopt instead of bleeding one cue onto both.
 *
 * Deliberately keyword/regex-based (hand-auditable). The semantic upgrade
 * (ONNX-embedding topic match + LLM-judge on gate survivors) layers on top in a
 * later phase; this stays the high-precision default.
 */
import type { EntityStance, DetectOptions } from "./types.js";

/**
 * Entities decisions commonly rule on, mapped to a canonical name. Callers can
 * extend this per-repo via `DetectOptions.aliases`.
 */
export const BUILTIN_ALIASES: Record<string, string> = {
  mongodb: "MongoDB",
  mongo: "MongoDB",
  postgres: "Postgres",
  postgresql: "Postgres",
  sqlite: "SQLite",
  mcp: "MCP",
  watcher: "watcher",
  watchers: "watcher",
  "passive watcher": "watcher",
  hook: "hook",
  hooks: "hook",
  "tree-sitter": "tree-sitter",
  treesitter: "tree-sitter",
  ast: "tree-sitter",
  proxy: "proxy",
};

// Polarity cues → does the text ADOPT the entity, or REJECT / DEFER it?
const POS_SRC =
  "adopt|use|choose|chose|move (?:the )?primary|primary (?:write )?path|make .* primary|stay on|standardi[sz]e on|reintroduce|re-introduce|bring back|switch to|go with|enable|ship";
const NEG_SRC =
  "reject|avoid|drop|remove|stay off|not use|never|move away|deprecate|replace|instead of|rip out|disable";
const DEFER_SRC = "defer|postpone|later sprint|not (?:yet|now)|hold off|punt";
const PRIMARY_SRC = "primary";

/** Cue must be within this many characters of the entity to count. */
const MAX_CUE_DISTANCE = 64;

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Mention {
  entity: string;
  pos: number;
  len: number;
}
interface Cue {
  kind: "adopt" | "reject" | "defer" | "primary";
  pos: number;
}

/** Collect every word-boundary occurrence of a cue pattern. */
function collectCues(text: string, src: string, kind: Cue["kind"]): Cue[] {
  const re = new RegExp(`\\b(?:${src})\\b`, "gi");
  const out: Cue[] = [];
  for (const m of text.matchAll(re)) out.push({ kind, pos: m.index ?? 0 });
  return out;
}

/** The entity mention nearest to a position, or null past the distance cap. */
function nearestMention(mentions: Mention[], pos: number): Mention | null {
  let best: Mention | null = null;
  let bestDist = Infinity;
  for (const m of mentions) {
    const d = Math.abs(m.pos - pos);
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return best && bestDist <= MAX_CUE_DISTANCE ? best : null;
}

/**
 * Extract the stance a piece of text takes on every entity it mentions. Each
 * polarity/primary cue is assigned to the entity mention nearest to it (within
 * MAX_CUE_DISTANCE), and an entity's polarity is the kind of the closest cue
 * that claimed it.
 */
export function stanceOf(text: string, options: DetectOptions = {}): EntityStance[] {
  const aliases = options.aliases ? { ...BUILTIN_ALIASES, ...options.aliases } : BUILTIN_ALIASES;

  // 1. Word-boundary entity mentions with positions.
  const mentions: Mention[] = [];
  for (const raw of Object.keys(aliases)) {
    const pattern = escapeRegex(raw).replace(/\\?\s+/g, "\\s+");
    const re = new RegExp(`\\b${pattern}\\b`, "gi");
    for (const m of text.matchAll(re)) {
      mentions.push({ entity: aliases[raw]!, pos: m.index ?? 0, len: m[0].length });
    }
  }
  if (mentions.length === 0) return [];

  // 2. All cue occurrences.
  const cues: Cue[] = [
    ...collectCues(text, POS_SRC, "adopt"),
    ...collectCues(text, NEG_SRC, "reject"),
    ...collectCues(text, DEFER_SRC, "defer"),
    ...collectCues(text, PRIMARY_SRC, "primary"),
  ];

  // 3. Aggregate per canonical entity; each cue is claimed by its NEAREST mention
  //    (kills cross-entity bleed). Among the cues an entity claims, resolve
  //    polarity by precedence NEG > DEFER > POS — negation dominates, matching the
  //    prototype's window semantics so "Do not use X" reads reject, not adopt.
  interface Agg {
    entity: string;
    kinds: Set<Cue["kind"]>;
    primary: boolean;
    pos: number;
  }
  const byEntity = new Map<string, Agg>();
  for (const m of mentions) {
    if (!byEntity.has(m.entity)) {
      byEntity.set(m.entity, { entity: m.entity, kinds: new Set(), primary: false, pos: m.pos });
    }
  }

  for (const cue of cues) {
    const owner = nearestMention(mentions, cue.pos);
    if (!owner) continue;
    const agg = byEntity.get(owner.entity)!;
    if (cue.kind === "primary") agg.primary = true;
    else agg.kinds.add(cue.kind);
  }

  const resolve = (kinds: Set<Cue["kind"]>): EntityStance["polarity"] =>
    kinds.has("reject") ? "reject" : kinds.has("defer") ? "defer" : kinds.has("adopt") ? "adopt" : "mention";

  return [...byEntity.values()].map((a) => {
    const evStart = Math.max(0, a.pos - 60);
    return {
      entity: a.entity,
      polarity: resolve(a.kinds),
      primary: a.primary,
      evidence: text.slice(evStart, a.pos + 80).trim().replace(/\s+/g, " ").slice(0, 120),
    };
  });
}

/** Stances that oppose one another on the same entity. */
export const OPPOSED: Record<string, ReadonlySet<string>> = {
  adopt: new Set(["reject", "defer"]),
  reject: new Set(["adopt"]),
  defer: new Set(["adopt"]),
};
