// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 55 Phase C — `kodela sessions` CLI command group
 *
 *   kodela sessions list
 *     List all sessions in .kodela/sessions/, sorted newest first.
 *     Shows: session_id | started | files | risk | status (open/closed)
 *
 *   kodela sessions show <session_id>
 *     Detailed view: goal, model, files changed, entries, aggregated risk.
 *
 *   kodela sessions show <session_id> --output json
 *     Same as above in machine-readable JSON.
 */

import { listSessions, readSession } from "@kodela/core";
import { getSessionEntries } from "@kodela/core/sessions";

export type SessionsListOptions = {
  repoRoot: string;
  format?: "table" | "json";
};

export type SessionsShowOptions = {
  repoRoot: string;
  sessionId: string;
  format?: "table" | "json";
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").slice(0, 16);
}

function riskBadge(risk: string): string {
  switch (risk) {
    case "critical": return "🔴 critical";
    case "high":     return "🟠 high";
    case "medium":   return "🟡 medium";
    default:         return "🟢 low";
  }
}

export async function runSessionsList(opts: SessionsListOptions): Promise<string> {
  const { repoRoot, format = "table" } = opts;
  const sessions = await listSessions(repoRoot);

  if (format === "json") {
    return JSON.stringify(sessions, null, 2);
  }

  if (sessions.length === 0) {
    return "No sessions found in .kodela/sessions/";
  }

  const reversed = [...sessions].reverse();

  const header = [
    "Session ID".padEnd(38),
    "Started".padEnd(17),
    "Files".padEnd(6),
    "Risk".padEnd(14),
    "Status",
  ].join("  ");
  const divider = "─".repeat(header.length);

  const rows = reversed.map((s) => {
    const id = s.id.length > 36 ? s.id.slice(0, 33) + "…" : s.id.padEnd(38);
    const started = formatDate(s.startedAt).padEnd(17);
    const files = String(s.filesChanged.length).padEnd(6);
    const risk = riskBadge(s.aggregatedRisk).padEnd(14);
    const status = s.endedAt ? "closed" : "open";
    return [id, started, files, risk, status].join("  ");
  });

  return [header, divider, ...rows].join("\n");
}

export async function runSessionsShow(opts: SessionsShowOptions): Promise<string> {
  const { repoRoot, sessionId, format = "table" } = opts;

  const result = await getSessionEntries(repoRoot, sessionId);
  if (!result) {
    return `Session not found: ${sessionId}`;
  }

  const { session, entries } = result;

  if (format === "json") {
    return JSON.stringify(
      {
        ...session,
        entryCount: entries.length,
        entries: entries.map((e) => ({
          id: e.id,
          filePath: e.filePath,
          severity: e.severity,
          note: e.note,
          status: e.status,
        })),
      },
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push(`Session: ${session.id}`);
  lines.push("═".repeat(60));
  if (session.goal) {
    lines.push(`Goal:    ${session.goal}`);
  }
  if (session.model) {
    lines.push(`Model:   ${session.model}`);
  }
  lines.push(`Started: ${formatDate(session.startedAt)}`);
  if (session.endedAt) {
    lines.push(`Ended:   ${formatDate(session.endedAt)}`);
  } else {
    lines.push(`Status:  open`);
  }
  lines.push(`Risk:    ${riskBadge(session.aggregatedRisk)}`);
  lines.push(`Files:   ${session.filesChanged.length}`);
  lines.push("");

  if (session.filesChanged.length > 0) {
    lines.push("Files changed:");
    for (const f of session.filesChanged) {
      lines.push(`  ${f}`);
    }
    lines.push("");
  }

  if (entries.length > 0) {
    lines.push(`Entries (${entries.length}):`);
    lines.push("─".repeat(60));
    for (const e of entries) {
      const badge = riskBadge(e.severity);
      const note = e.note.length > 70 ? `${e.note.slice(0, 67)}…` : e.note;
      lines.push(`  [${badge}]  ${e.filePath}:${e.lineRange.start}`);
      lines.push(`    ${note}`);
    }
  } else {
    lines.push("No entries linked to this session.");
  }

  return lines.join("\n");
}
