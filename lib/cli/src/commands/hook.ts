// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 52 — Claude Code Hooks Integration
 *
 * Two subcommands:
 *
 *   kodela hook install --claude
 *     Writes the Claude Code hook configuration into `.claude/settings.json`.
 *     Idempotent — running twice does not duplicate the hooks array.
 *
 *   kodela hook process --event <event>
 *     Reads a JSON payload from stdin (or --payload <path>) and processes
 *     the hook event. Creates a ContextEntry for PostToolUse file events,
 *     schedules reasoning extraction, and writes session records.
 *     Always exits 0 and never writes to stdout — all errors go to
 *     `.kodela/hook-errors.log` so the developer workflow is never interrupted.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  writeContextEntry,
  classifyScope,
  KODELA_DIR,
  enrichEntry,
  buildMCPEnvelope,
} from "@kodela/core";
import type { ContextEntry } from "@kodela/core";
import {
  startSession,
  linkEntryToSession,
  closeSession as closeKodelaSession,
  updateSessionGoal,
  synthesiseAndWriteSessionSummary,
  appendSessionTimelineEvent,
  appendUserTurn,
  appendAssistantTurn,
  readSessionTurns,
  getSessionEntries,
} from "@kodela/core/sessions";
import { fileExists, findRepoRoot } from "../utils/repo.js";
import {
  parseHookPayload,
  type ClaudeHookEventType,
} from "../hooks/processor.js";
import { computeDedupKey, checkDedup, recordDedup } from "../hooks/dedup.js";
import { scheduleExtraction, drainExtractionQueue } from "../hooks/queue.js";
import type { AiLayerConfig } from "./ai-layer.js";
import { setCaptureMode } from "../config/loader.js";
import { renderCapturePathBlock } from "../output/messaging.js";

// ---------------------------------------------------------------------------
// Hook install — writes .claude/settings.json
// ---------------------------------------------------------------------------

export type HookInstallOptions = {
  repoRoot: string;
  force?: boolean;
};

export type HookInstallResult = {
  settingsPath: string;
  created: boolean;
  updated: boolean;
  skipped: boolean;
  alreadyInstalled: boolean;
};

/** Kodela hook marker comment embedded in settings for idempotency detection */
const KODELA_HOOK_MARKER = "kodela-hook-v1";

const CLAUDE_HOOK_EVENTS: ClaudeHookEventType[] = [
  "PostToolUse",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "AssistantResponse",
];

function buildClaudeHooksConfig(): Record<string, unknown[]> {
  const hooks: Record<string, unknown[]> = {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    const entry: Record<string, unknown> = {
      hooks: [
        {
          type: "command",
          command: `kodela hook process --event ${event}`,
        },
      ],
      _kodela: KODELA_HOOK_MARKER,
    };
    if (event === "PostToolUse") {
      entry["matcher"] = "Write|Edit|MultiEdit|Bash";
    }
    hooks[event] = [entry];
  }
  return hooks;
}

function isKodelaHookPresent(
  existingHooks: Record<string, unknown[]>,
): boolean {
  for (const entries of Object.values(existingHooks)) {
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (
          typeof entry === "object" &&
          entry !== null &&
          (entry as Record<string, unknown>)["_kodela"] === KODELA_HOOK_MARKER
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export async function runHookInstallClaude(
  opts: HookInstallOptions,
): Promise<HookInstallResult> {
  const { repoRoot, force = false } = opts;

  const claudeDir = path.join(repoRoot, ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");

  await fs.mkdir(claudeDir, { recursive: true });

  const kodelaHooks = buildClaudeHooksConfig();

  const settingsExists = await fileExists(settingsPath);

  if (!settingsExists) {
    // Create fresh settings file
    const settings = { hooks: kodelaHooks };
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

    // Best-effort: record the active capture mode in kodela.config.json.
    await setCaptureMode(repoRoot, "hooks").catch(() => undefined);

    return {
      settingsPath,
      created: true,
      updated: false,
      skipped: false,
      alreadyInstalled: false,
    };
  }

  // Settings file exists — read and merge
  let existing: { hooks?: Record<string, unknown[]>; [key: string]: unknown };
  try {
    const raw = await fs.readFile(settingsPath, "utf-8");
    existing = JSON.parse(raw) as typeof existing;
  } catch {
    existing = {};
  }

  const existingHooks = (existing.hooks ?? {}) as Record<string, unknown[]>;

  // Idempotency check
  if (!force && isKodelaHookPresent(existingHooks)) {
    return {
      settingsPath,
      created: false,
      updated: false,
      skipped: true,
      alreadyInstalled: true,
    };
  }

  // Merge: remove any existing Kodela hooks, then add the current ones
  const mergedHooks: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries(existingHooks)) {
    if (Array.isArray(entries)) {
      const nonKodela = entries.filter(
        (e) =>
          typeof e !== "object" ||
          e === null ||
          (e as Record<string, unknown>)["_kodela"] !== KODELA_HOOK_MARKER,
      );
      if (nonKodela.length > 0) mergedHooks[event] = nonKodela;
    }
  }

  for (const [event, entries] of Object.entries(kodelaHooks)) {
    if (mergedHooks[event]) {
      mergedHooks[event] = [...mergedHooks[event]!, ...entries];
    } else {
      mergedHooks[event] = entries;
    }
  }

  const updatedSettings = { ...existing, hooks: mergedHooks };
  await fs.writeFile(settingsPath, JSON.stringify(updatedSettings, null, 2), "utf-8");

  // Best-effort: record the active capture mode in kodela.config.json.
  await setCaptureMode(repoRoot, "hooks").catch(() => undefined);

  return {
    settingsPath,
    created: false,
    updated: true,
    skipped: false,
    alreadyInstalled: false,
  };
}

export function formatHookInstallResult(result: HookInstallResult): string {
  const lines: string[] = [];

  if (result.skipped && result.alreadyInstalled) {
    lines.push(
      `⚠ Kodela hooks already installed in ${result.settingsPath}`,
      "  Use --force to reinstall.",
    );
  } else if (result.created) {
    lines.push(
      `✓ Created ${result.settingsPath} with Kodela hooks`,
      "  Events: PostToolUse · SessionStart · SessionEnd · UserPromptSubmit · AssistantResponse",
      "  Hook command: kodela hook process --event <event>",
    );
  } else if (result.updated) {
    lines.push(
      `✓ Updated ${result.settingsPath} — Kodela hooks added`,
      "  Existing non-Kodela hooks were preserved.",
      "  Events: PostToolUse · SessionStart · SessionEnd · UserPromptSubmit · AssistantResponse",
    );
  }

  lines.push("");
  lines.push(
    renderCapturePathBlock({
      active: "hooks",
      hooksInstalled: true,
      watcherRunning: false,
    }),
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Hook process — receives and processes Claude hook payloads
// ---------------------------------------------------------------------------

export type HookProcessOptions = {
  repoRoot: string;
  event: ClaudeHookEventType;
  /** Path to the JSON payload file. When absent, reads from stdin. */
  payloadPath?: string;
  /** AI provider config for reasoning extraction. */
  aiConfig?: AiLayerConfig;
};

export type HookProcessResult = {
  event: ClaudeHookEventType;
  processed: boolean;
  entryId?: string;
  skipped?: boolean;
  skipReason?: string;
};

/**
 * Append a message to `.kodela/hook-errors.log`.
 * Silently swallows I/O errors — error logging must never interrupt the hook.
 */
async function logHookError(repoRoot: string, message: string): Promise<void> {
  try {
    await fs.mkdir(path.join(repoRoot, KODELA_DIR), { recursive: true });
    const line = `${new Date().toISOString()} [hook-error] ${message}\n`;
    await fs.appendFile(
      path.join(repoRoot, KODELA_DIR, "hook-errors.log"),
      line,
      "utf-8",
    );
  } catch {
    // Truly last resort
  }
}

async function readPayload(payloadPath?: string): Promise<string | null> {
  if (payloadPath) {
    try {
      return await fs.readFile(payloadPath, "utf-8");
    } catch {
      return null;
    }
  }

  // Read from stdin
  return new Promise<string | null>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.trim() || null));
    process.stdin.on("error", () => resolve(null));
    // Timeout after 5 seconds if stdin never closes
    setTimeout(() => resolve(data.trim() || null), 5000);
  });
}

export async function runHookProcess(
  opts: HookProcessOptions,
): Promise<HookProcessResult> {
  const { repoRoot, event, payloadPath, aiConfig } = opts;

  // ── Graceful degradation: no .kodela/ directory ───────────────────────────
  const kodelaDirExists = await fileExists(path.join(repoRoot, KODELA_DIR));
  if (!kodelaDirExists) {
    return { event, processed: false, skipped: true, skipReason: "no-kodela-dir" };
  }

  // ── Read payload ──────────────────────────────────────────────────────────
  const raw = await readPayload(payloadPath);
  if (!raw) {
    await logHookError(repoRoot, `Empty payload for ${event}`);
    return { event, processed: false, skipped: true, skipReason: "empty-payload" };
  }

  // ── Parse payload ─────────────────────────────────────────────────────────
  const parsed = parseHookPayload(event, raw);
  if (!parsed) {
    await logHookError(repoRoot, `Failed to parse payload for ${event}: ${raw.slice(0, 200)}`);
    return { event, processed: false, skipped: true, skipReason: "parse-error" };
  }

  try {
    // ── SessionStart ─────────────────────────────────────────────────────────
    if (event === "SessionStart") {
      if (parsed.sessionId) {
        await startSession(repoRoot, parsed.sessionId, {
          model: parsed.model,
        }).catch(() => undefined);
      }
      return { event, processed: true };
    }

    // ── SessionEnd ───────────────────────────────────────────────────────────
    if (event === "SessionEnd") {
      // Close the KodelaSession (Gap 55 Phase D) before draining the queue
      if (parsed.sessionId) {
        await closeKodelaSession(repoRoot, parsed.sessionId).catch(() => undefined);
      }
      // Drain any pending extraction queue entries before the session closes
      await drainExtractionQueue(repoRoot, aiConfig).catch(() => undefined);

      // ── Gap 120: Synthesise session-level intent ──────────────────────────
      if (parsed.sessionId) {
        await synthesiseAndWriteSessionSummary(repoRoot, parsed.sessionId).catch(
          () => undefined,
        );
      }

      // ── Build MCPContextEnvelope so dashboard shows rich session data ─────
      // Runs after closeSession so aggregatedRisk is finalised.
      if (parsed.sessionId) {
        try {
          const sessionWithEntries = await getSessionEntries(repoRoot, parsed.sessionId);
          if (sessionWithEntries) {
            await buildMCPEnvelope(
              repoRoot,
              sessionWithEntries.session,
              sessionWithEntries.entries,
            );
          }
        } catch {
          // Non-fatal — envelope is assembled on-demand by the API if missing
        }
      }

      return { event, processed: true };
    }

    // ── UserPromptSubmit ─────────────────────────────────────────────────────
    if (event === "UserPromptSubmit") {
      // Gap 121: Capture the user's original prompt as the session goal.
      // First prompt wins — updateSessionGoal will not overwrite an existing goal.
      if (parsed.sessionId && parsed.prompt) {
        await updateSessionGoal(repoRoot, parsed.sessionId, parsed.prompt).catch(
          () => undefined,
        );

        const userTurn = await appendUserTurn(
          repoRoot,
          parsed.sessionId,
          parsed.prompt,
          { source: "claude-hook" },
        ).catch(() => null);

        await appendSessionTimelineEvent(repoRoot, parsed.sessionId, {
          type: "chat-request-captured",
          source: "claude-hook",
          data: {
            promptPreview: parsed.prompt.slice(0, 500),
            ...(userTurn ? { userTurnId: userTurn.id, seq: userTurn.seq } : {}),
          },
        }).catch(() => undefined);
      }
      return { event, processed: true };
    }

    // ── AssistantResponse (Gap 125) ──────────────────────────────────────────
    if (event === "AssistantResponse") {
      // Store the assistant's explanation text to `.kodela/sessions/<sid>.turns.jsonl`.
      // This is the richest source of intent — Claude's own words describing what
      // it did and why.  The text is used at SessionEnd to populate ClusterSummary.
      if (parsed.sessionId && parsed.assistantText?.trim()) {
        const turns = await readSessionTurns(repoRoot, parsed.sessionId).catch(
          () => [],
        );
        const promptTurn = [...turns]
          .reverse()
          .find((turn) => turn.role === "user");

        const assistantTurn = await appendAssistantTurn(
          repoRoot,
          parsed.sessionId,
          parsed.assistantText,
          {
            source: "claude-hook",
            ...(promptTurn ? { promptId: promptTurn.id } : {}),
          },
        ).catch(() => undefined);

        await appendSessionTimelineEvent(repoRoot, parsed.sessionId, {
          type: "chat-response-captured",
          source: "claude-hook",
          data: {
            chars: parsed.assistantText.trim().length,
            reasoningPreview: parsed.assistantText.trim().slice(0, 500),
            ...(assistantTurn ? { assistantTurnId: assistantTurn.id, seq: assistantTurn.seq } : {}),
            ...(promptTurn ? { promptId: promptTurn.id } : {}),
          },
        }).catch(() => undefined);
      }
      return { event, processed: true };
    }

    // ── PostToolUse ──────────────────────────────────────────────────────────
    if (event === "PostToolUse") {
      // Bash commands — log but don't create an entry
      if (parsed.bashCommand) {
        return { event, processed: true, skipped: true, skipReason: "bash-tool" };
      }

      // Must have a file path for file tools
      if (!parsed.filePath) {
        return { event, processed: true, skipped: true, skipReason: "no-file-path" };
      }

      const filePath = parsed.filePath;
      const lineStart = parsed.lineRange?.start ?? 1;
      const lineEnd = parsed.lineRange?.end ?? lineStart;

      // ── Idempotency guard ─────────────────────────────────────────────────
      const today = new Date().toISOString().slice(0, 10);
      const dedupKey = computeDedupKey(
        parsed.sessionId,
        filePath,
        lineStart,
        lineEnd,
        today,
      );

      const isDuplicate = await checkDedup(repoRoot, dedupKey);
      if (isDuplicate) {
        return {
          event,
          processed: false,
          skipped: true,
          skipReason: "duplicate",
        };
      }

      // ── Create ContextEntry ───────────────────────────────────────────────
      const now = new Date().toISOString();
      const entryId = randomUUID();
      const scope = classifyScope(filePath);

      // Use a relative path for storage
      const relativeFilePath = path.isAbsolute(filePath)
        ? path.relative(repoRoot, filePath)
        : filePath;

      const hookPartial: ContextEntry = {
        schemaVersion: "1.1.0",
        id: entryId,
        filePath: relativeFilePath,
        astAnchor: null,
        contentHash: entryId, // Placeholder — heal will recompute
        lineRange: { start: lineStart, end: lineEnd },
        note: `Hook-captured change via ${parsed.toolName ?? "file tool"} in session ${parsed.sessionId}`,
        author: "claude-code",
        createdAt: now,
        updatedAt: now,
        severity: "low",
        tags: ["hook-captured", "auto", "confirmed"],
        source: "ai",
        aiTool: "claude-code",
        confidence: 0.9,
        attributionConfidence: 1.0,
        canUpgradeAttribution: false,
        status: "mapped",
        reviewRequired: false,
        sessionId: parsed.sessionId,
        scope,
        origin: {
          type: "ai",
          tool: "claude-code",
          model: parsed.model,
          sessionId: parsed.sessionId,
          generatedAt: parsed.timestamp,
        },
      };

      // Gap 100/101/102/103 — enrich with fingerprint, provenance, summary.
      const entry = enrichEntry(hookPartial, {
        sourceType: "hook",
        isExplicitAgent: true,
        trustLevel: "high",
        diff: parsed.rawDiff,
        linesAdded: parsed.rawDiff
          ? parsed.rawDiff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length
          : 0,
        linesRemoved: parsed.rawDiff
          ? parsed.rawDiff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length
          : 0,
        fileCount: 1,
      });

      await writeContextEntry(repoRoot, entry);

      // ── Link entry to session (Gap 55 Phase D) ────────────────────────────
      if (parsed.sessionId) {
        await linkEntryToSession(
          repoRoot,
          parsed.sessionId,
          entryId,
          relativeFilePath,
        ).catch(() => undefined);
      }

      // ── Record dedup key ──────────────────────────────────────────────────
      await recordDedup(repoRoot, dedupKey);

      // ── Schedule reasoning extraction ─────────────────────────────────────
      await scheduleExtraction(
        repoRoot,
        { id: entryId, filePath: relativeFilePath },
        { diff: parsed.rawDiff, sessionId: parsed.sessionId },
      );

      // ── Drain up to 3 queue entries without blocking the hook ─────────────
      drainExtractionQueue(repoRoot, aiConfig, 3).catch(() => undefined);

      return { event, processed: true, entryId };
    }

    return { event, processed: false, skipped: true, skipReason: "unknown-event" };
  } catch (err) {
    await logHookError(
      repoRoot,
      `Hook process error for ${event}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      event,
      processed: false,
      skipped: true,
      skipReason: "internal-error",
    };
  }
}

// Session summary sidecar generation is now shared in @kodela/core/sessions
// via synthesiseAndWriteSessionSummary(), used by both CLI hook flow and
// VS Code capture flow for parity.
