// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { z } from "zod";
import { AggregatedRiskSchema } from "./intent-cluster.schema.js";
import { ReasoningObjectSchema } from "../reasoning/index.js";

const SessionChatMetricsSchema = z.object({
  totalCompletionTokens: z.number().int().min(0),
  requestCount: z.number().int().min(0),
  avgElapsedMs: z.number().min(0).optional(),
  modelId: z.string().optional(),
});

// SessionActorSchema is exported below (with chatMetrics) — defined once.

const SessionIntentSchema = z.object({
  userPrompt: z.string().optional(),
  synthesised: z.string().optional(),
  aiReasoning: z.string().optional(),
  branchContext: z.string().optional(),
  commitMessage: z.string().optional(),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  updatedAt: z.string().datetime().optional(),
  /** Gap 3 — file paths attached as context references in the chat session. */
  contextFiles: z.array(z.string()).optional(),
});

const SessionAnnotationSchema = z.object({
  reasoning: z.string().optional(),
  source: z.string().optional(),
  updatedAt: z.string().datetime().optional(),
});

const SessionGitDiffStatsSchema = z.object({
  workingTree: z.number().int().min(0).optional(),
  index: z.number().int().min(0).optional(),
  merge: z.number().int().min(0).optional(),
  total: z.number().int().min(0).optional(),
});

const SessionGitSnapshotSchema = z.object({
  branch: z.string().optional(),
  headCommit: z.string().optional(),
  author: z.string().optional(),
  filesChanged: z.array(z.string()).optional(),
  diffStats: SessionGitDiffStatsSchema.optional(),
  capturedAt: z.string().datetime(),
});

const SessionGitSchema = z.object({
  start: SessionGitSnapshotSchema.optional(),
  end: SessionGitSnapshotSchema.optional(),
});

const SessionChangesSchema = z.object({
  files: z.array(z.string()),
  added: z.number().int().min(0),
  removed: z.number().int().min(0).optional(),
});

// ── Per-file actor (per-file MCP context capture) ─────────────────────────────

/**
 * Per-file actor — captures who actually edited a specific file.
 * Differs from SessionActor which captures who started the session.
 *
 * - source: "ai"    → AI wrote it entirely. tool + model required.
 * - source: "human" → Developer wrote it entirely. tool + model null.
 * - source: "mixed" → AI scaffolded, human refined. tool + model = the AI's identity.
 */
export const FileActorSchema = z
  .object({
    source: z.enum(["ai", "human", "mixed"]),
    tool: z.string().nullable(),
    model: z.string().nullable(),
    author: z.string(),
    aiSessionUrl: z.string().url().optional(),
  })
  .refine(
    (a) =>
      a.source === "human"
        ? a.tool === null && a.model === null
        : a.tool !== null,
    {
      message:
        "AI/mixed actors must have tool set; human actors must have tool and model null",
      path: ["tool"],
    },
  );

export type FileActor = z.infer<typeof FileActorSchema>;

/**
 * Per-file context — required for every file touched in a session.
 * Captures the "who" + "why" specific to this file.
 * Written by `kodela_annotate_file`; accumulated in `filesChangedDetail[]`.
 */
export const FileChangeContextSchema = z.object({
  path: z.string(),
  linesAdded: z.number().int().min(0),
  linesRemoved: z.number().int().min(0),

  /** Who actually edited this file — may differ from the session actor. */
  modifiedBy: FileActorSchema,

  /** Why THIS file needed to change (min 10 chars). */
  whyChanged: z
    .string()
    .min(10, "whyChanged must explain why THIS file needed to change (min 10 chars)"),

  /** What problem this specific change fixes or enables (min 10 chars). */
  problemSolved: z
    .string()
    .min(10, "problemSolved must describe what problem this change fixes/enables (min 10 chars)"),

  /** AI's own explanation of how the approach was chosen. */
  aiReasoning: z.string().optional(),

  /** Alternatives considered and rejected. */
  alternativesConsidered: z.string().optional(),

  /** Other files in the same logical change. */
  relatedFiles: z.array(z.string()).default([]),

  /** Cross-links to ContextEntry IDs created for this file. */
  relatedEntryIds: z.array(z.string()).default([]),

  risk: z.enum(["low", "medium", "high", "critical"]),
  reviewRequired: z.boolean().default(false),

  /** ContextEntry IDs spawned from this file-level annotation. */
  entryIds: z.array(z.string()).default([]),

  firstAnnotatedAt: z.string().datetime(),
  lastUpdatedAt: z.string().datetime(),

  /**
   * Where the rich text fields (whyChanged, problemSolved, aiReasoning) came from.
   *
   * - `agent-authored` — the AI agent called kodela_annotate_file with rich text (default).
   * - `synthesized`    — the async synthesis worker (Phase 2) generated this from
   *                      diff + transcript when no agent annotation existed.
   * - `human-authored` — a developer wrote it directly (modifiedBy.source === "human"
   *                      or via the dashboard's edit affordance).
   *
   * The dashboard renders synthesized annotations with a `draft` visual treatment
   * (dashed border + categorical confidence chip) until a reviewer promotes them.
   * See the project design docs §Phase 1.
   */
  provenance: z.enum(["agent-authored", "synthesized", "human-authored"]).default("agent-authored"),

  /** Synthesis prompt template version when provenance === "synthesized". Phase 2 sets this. */
  synthesisTemplateVersion: z.string().optional(),

  /**
   * When the synthesized entry is replaced by a later agent or human annotation,
   * this points at the newer entry. UI uses this to dim the superseded version.
   */
  supersededByEntryId: z.string().optional(),
});

export type FileChangeContext = z.infer<typeof FileChangeContextSchema>;

/**
 * Actor breakdown summary — how many files were AI / human / mixed.
 */
export const ActorBreakdownSchema = z.object({
  ai: z.number().int().min(0),
  human: z.number().int().min(0),
  mixed: z.number().int().min(0),
});

export type ActorBreakdown = z.infer<typeof ActorBreakdownSchema>;

/**
 * Gap 55 Phase A — Session-Based Change Grouping.
 *
 * A KodelaSession represents a single AI coding session as a first-class
 * object, grouping all ContextEntries produced during that session together
 * with aggregated metadata: goal, risk profile, files changed, and optional
 * session-level reasoning.
 *
 * Sessions are persisted as `.kodela/sessions/<session_id>.json`.
 *
 * The session_id comes from the Claude Code `SessionStart` hook payload
 * (field: `session_id`) or is a caller-supplied UUID for non-Claude sessions.
 * Session IDs may contain alphanumeric characters, hyphens, and underscores.
 */
/**
 * MCP Context Layer — WHO block attached at kodela_session_start time.
 * Populated by the MCP tool; falls back to env-var / git heuristics for
 * watcher-only sessions.
 */
export const SessionActorSchema = z.object({
  tool: z.string(),
  model: z.string().optional(),
  author: z.string().optional(),
  /** Gap 5 — effort metrics extracted from chatSessions kind=1 token/latency patches. */
  chatMetrics: SessionChatMetricsSchema.optional(),
});

export type SessionActor = z.infer<typeof SessionActorSchema>;

export const KodelaSessionSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  model: z.string().optional(),
  /**
   * Inferred AI provider name derived from the session `model` field at
   * SessionStart time. "anthropic" when model starts with "claude-";
   * "openai" when model starts with "gpt-" or "o1" / "o3";
   * "google" when model starts with "gemini-".
   * Used as a hint during credential resolution for reasoning extraction.
   */
  providerHint: z.enum(["anthropic", "openai", "google"]).optional(),
  entries: z.array(z.string().uuid()),
  goal: z.string().optional(),
  aggregatedRisk: AggregatedRiskSchema,
  filesChanged: z.array(z.string()),
  reasoning: ReasoningObjectSchema.optional(),
  actor: SessionActorSchema.optional(),
  intent: SessionIntentSchema.optional(),
  annotation: SessionAnnotationSchema.optional(),
  git: SessionGitSchema.optional(),
  changes: SessionChangesSchema.optional(),
  /** Alias for aggregatedRisk for downstream snapshot consumers. */
  risk: AggregatedRiskSchema.optional(),
  /** Session duration in milliseconds. */
  duration: z.number().int().min(0).optional(),
  /** Dominant cluster ID touched in this session, when available. */
  clusterId: z.string().optional(),
  /** One-line durable handoff summary for timeline/history rendering. */
  handoffSummary: z.string().optional(),
  /** Sources that contributed data to this session, ordered by arrival. */
  captureSources: z.array(z.string()).optional(),
  /** Copilot memory tool content captured during the session. */
  copilotMemory: z
    .object({
      startSnapshot: z.array(z.string()).optional(),
      endSnapshot: z.array(z.string()).optional(),
      source: z.string().optional(),
      /** Lines added to memory files during this session (delta only). */
      newInsights: z.array(z.string()).optional(),
    })
    .optional(),
  /** Local History file diffs captured during this session. */
  codeChanges: z
    .array(
      z.object({
        filePath: z.string(),
        timestamp: z.number(),
        linesAdded: z.number().int().min(0),
        linesRemoved: z.number().int().min(0),
        diffSummary: z.string(),
        snapshotId: z.string().optional(),
        source: z.enum(["local-history", "git-diff"]),
        /** Gap 2 — user prompt extracted from Local History entries.json "Chat Edit: '...'" source field. */
        editPrompt: z.string().optional(),
      }),
    )
    .optional(),
  /** Inline Copilot edits (Ctrl+I) captured during this session. */
  inlineEdits: z
    .array(
      z.object({
        prompt: z.string(),
        filePath: z.string(),
        accepted: z.boolean().nullable(),
        diff: z.string(),
        timestamp: z.number(),
        source: z.literal("copilot-inline-edit"),
      }),
    )
    .optional(),
  /** Agent tool calls from Copilot CLI sessions overlapping this window. */
  agentActions: z
    .array(
      z.object({
        name: z.string(),
        input: z.record(z.unknown()),
        output: z.string(),
      }),
    )
    .optional(),
  /**
   * Git branch active at session start (set by kodela_session_start or
   * auto-detected from git at session close).
   */
  branchContext: z.string().optional(),
  /**
   * Ticket reference extracted from branch name or supplied explicitly
   * (e.g. "JIRA-1234", "LINEAR-456").
   */
  linkedTicket: z.string().optional(),

  /**
   * Per-file context — accumulates as `kodela_annotate_file` is called.
   * One entry per file touched in the session.
   */
  filesChangedDetail: z.array(FileChangeContextSchema).optional(),

  /**
   * Repo-relative paths the session is *claiming* it touched.
   *
   * Source of truth for session_end enforcement scope:
   *   enforced = filesDetectedByGit ∩ touchedFiles
   *   outOfScope = filesDetectedByGit − touchedFiles  (informational, never blocking)
   *
   * Populated by `kodela_annotate_file` today; future watchers (VS Code,
   * JetBrains, shell) push here as well, decoupling "agent touched X" from
   * "agent wrote a why_changed for X". When undefined, session_end falls back
   * to legacy behavior (full git diff is enforced) for backward compat with
   * sessions written before this field existed.
   *
   * See the project design docs §3
   * and §4 Pillar A.
   */
  touchedFiles: z.array(z.string()).optional(),

  /**
   * Session-level metrics computed on close.
   * Includes actorBreakdown for instant attribution rollup.
   */
  sessionMetrics: z
    .object({
      totalFiles: z.number().int().min(0),
      totalLinesAdded: z.number().int().min(0),
      totalLinesRemoved: z.number().int().min(0),
      annotationCount: z.number().int().min(0),
      avgConfidence: z.number().min(0).max(1),
      actorBreakdown: ActorBreakdownSchema,
    })
    .optional(),

  // ── Git-diff enforcement (added for session_end validation) ─────────────
  /**
   * Git commit hash captured at session_start time.
   * Used by session_end to run `git diff` and determine what files actually
   * changed during the session. Captured via `git stash create` (includes
   * uncommitted state) or `git rev-parse HEAD` (clean tree).
   */
  baselineCommit: z.string().optional(),

  /** Git branch active at session start. */
  baselineBranch: z.string().optional(),

  /** False if the repo isn't git-managed. Enforcement skips git checks. */
  isGitRepo: z.boolean().optional(),

  /** True if session was closed with `force: true` despite missing annotations. */
  forceOverride: z.boolean().optional(),
});

export type KodelaSession = z.infer<typeof KodelaSessionSchema>;
