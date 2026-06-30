// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * kodela metrics — does your agent actually get smarter every session?
 *
 * Instruments the retention loop locally (no telemetry leaves the machine):
 * from the captured graph it derives the signals that show memory compounding —
 * how much context has accumulated, the per-session capture rate and its trend,
 * and how often a session worked on files that *already* had captured context
 * (i.e. the agent had memory to read before editing — the "smarter" signal).
 *
 *   kodela metrics            → human-readable report
 *   kodela metrics -o json    → machine-readable for dashboards / CI
 */
import { readAllEntries } from "./status.js";

export type MetricsOptions = {
  repoRoot: string;
  output?: "text" | "json";
};

export type WeeklyPoint = { week: string; added: number; cumulative: number };

export type MetricsResult = {
  memorySize: number;
  sessions: number;
  filesCovered: number;
  capturesPerSession: number;
  earlierPerSession: number;
  recentPerSession: number;
  trendPct: number | null;
  reuseSessions: number;
  reusePct: number;
  weekly: WeeklyPoint[];
  growthRatePct: number | null;
};

interface EntryLike {
  filePath: string;
  createdAt?: string;
  updatedAt?: string;
  sessionId?: string;
  source?: string;
}

/** ISO-ish year-week key (UTC), e.g. "2026-W26". Stable, sortable. */
export function isoWeek(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dt = new Date(day);
  // Thursday-of-week determines the ISO year/week.
  const dayNum = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dayNum + 3);
  const firstThursday = Date.UTC(dt.getUTCFullYear(), 0, 4);
  const week =
    1 +
    Math.round(
      (dt.getTime() - firstThursday) / 86400000 / 7,
    );
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Group entries into sessions; entries without a sessionId fall back to their capture day. */
function groupSessions(entries: EntryLike[]): { id: string; t: string; entries: EntryLike[] }[] {
  const groups = new Map<string, EntryLike[]>();
  for (const e of entries) {
    const key = e.sessionId || `day:${(e.createdAt ?? e.updatedAt ?? "").slice(0, 10)}`;
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }
  return [...groups.entries()]
    .map(([id, es]) => {
      const t = es
        .map((e) => e.createdAt ?? e.updatedAt ?? "")
        .filter(Boolean)
        .sort()[0] ?? "";
      return { id, t, entries: es };
    })
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}

function round(n: number, p = 1): number {
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

export async function runMetrics(opts: MetricsOptions): Promise<MetricsResult> {
  const entries = (await readAllEntries(opts.repoRoot).catch(() => [])) as unknown as EntryLike[];
  const sessions = groupSessions(entries);
  const n = sessions.length;

  const filesCovered = new Set(entries.map((e) => e.filePath)).size;
  const capturesPerSession = n ? round(entries.length / n) : 0;

  // Trend: average captures/session in the earlier third vs the recent third.
  const third = Math.max(1, Math.floor(n / 3));
  const earlier = sessions.slice(0, third);
  const recent = sessions.slice(n - third);
  const avg = (gs: typeof sessions) =>
    gs.length ? gs.reduce((s, g) => s + g.entries.length, 0) / gs.length : 0;
  const earlierPerSession = round(avg(earlier));
  const recentPerSession = round(avg(recent));
  const trendPct =
    n >= 3 && earlierPerSession > 0
      ? round(((recentPerSession - earlierPerSession) / earlierPerSession) * 100)
      : null;

  // Reuse: a session "stands on prior memory" if it touched a file that already
  // had captured context before that session ran — the agent had something to read.
  const seen = new Set<string>();
  let reuseSessions = 0;
  for (const g of sessions) {
    const touched = new Set(g.entries.map((e) => e.filePath));
    if ([...touched].some((f) => seen.has(f))) reuseSessions += 1;
    for (const f of touched) seen.add(f);
  }
  const reusePct = n ? round((reuseSessions / n) * 100) : 0;

  // Weekly accumulation curve.
  const byWeek = new Map<string, number>();
  for (const e of entries) {
    const w = isoWeek(e.createdAt ?? e.updatedAt ?? "");
    byWeek.set(w, (byWeek.get(w) ?? 0) + 1);
  }
  let cumulative = 0;
  const weekly: WeeklyPoint[] = [...byWeek.entries()]
    .filter(([w]) => w !== "unknown")
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([week, added]) => {
      cumulative += added;
      return { week, added, cumulative };
    });

  // Growth rate: entries added in the last 4 weeks vs the prior 4 weeks.
  const last4 = weekly.slice(-4).reduce((s, w) => s + w.added, 0);
  const prev4 = weekly.slice(-8, -4).reduce((s, w) => s + w.added, 0);
  const growthRatePct = prev4 > 0 ? round(((last4 - prev4) / prev4) * 100) : null;

  return {
    memorySize: entries.length,
    sessions: n,
    filesCovered,
    capturesPerSession,
    earlierPerSession,
    recentPerSession,
    trendPct,
    reuseSessions,
    reusePct,
    weekly,
    growthRatePct,
  };
}

function arrow(pct: number | null): string {
  if (pct == null) return "";
  if (pct > 0) return ` ▲ +${pct}%`;
  if (pct < 0) return ` ▼ ${pct}%`;
  return " ─ flat";
}

export function formatMetricsResult(r: MetricsResult, output: "text" | "json" = "text"): string {
  if (output === "json") return JSON.stringify(r, null, 2);
  if (r.memorySize === 0) {
    return "No captured context yet. Run `kodela connect` and work a few sessions — this report fills in as memory accumulates.";
  }
  const lines = [
    "Kodela memory — is your agent getting smarter?",
    "",
    `  Memory size        ${r.memorySize} captured changes across ${r.filesCovered} files`,
    `  Sessions           ${r.sessions}`,
    `  Captures/session   ${r.capturesPerSession}  (earlier ${r.earlierPerSession} → recent ${r.recentPerSession}${arrow(r.trendPct)})`,
    `  Memory reuse       ${r.reusePct}% of sessions built on files with prior context (${r.reuseSessions}/${r.sessions})`,
  ];
  if (r.growthRatePct != null) {
    lines.push(`  4-week growth      ${arrow(r.growthRatePct).trim()} vs the prior 4 weeks`);
  }
  lines.push("");
  lines.push(
    r.reusePct >= 50
      ? "Most sessions stand on prior memory — the loop is compounding."
      : "Memory is still building. As reuse climbs, agents start each task with more context.",
  );
  return lines.join("\n");
}
