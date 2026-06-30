// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { z } from "zod";
import { CodeScopeSchema } from "../scope/classifier.js";
import { ReasoningObjectSchema } from "../reasoning/index.js";

export const SCHEMA_VERSION = "1.1.0" as const;

export const AstAnchorSchema = z.union([
  z.object({
    kind: z.enum(["function", "method", "class", "block"]),
    name: z.string(),
    blockHash: z.string().min(1),
    /**
     * SHA-256 of the normalised function/method body (excluding the signature
     * line). Used for rename-resilient tracking: when a symbol is renamed its
     * body hash stays stable, allowing the AST layer to re-locate it even
     * after the name changes.
     *
     * Optional for backward compatibility with entries written before Gap 8.
     */
    bodyHash: z.string().optional(),
    /**
     * Number of formal parameters in the function/method signature.
     * Used as a tiebreaker when multiple nodes share the same body hash (e.g.
     * two small one-liner helpers). Optional for backward compatibility.
     */
    paramCount: z.number().int().min(0).optional(),
    /**
     * Gap 42 — Stable symbol identifier computed at annotation time.
     * Format: `${repoRelPath}#${kind}:${name}`
     * Example: `src/payments/processor.ts#function:processPayment`
     *
     * Used as the primary lookup key in the AST heal pass when present,
     * bypassing the blockHash match entirely. Survives full function body
     * rewrites as long as the symbol name and kind remain the same.
     *
     * Optional for backward compatibility with entries written before Gap 42.
     */
    symbolId: z.string().optional(),
  }),
  z.null(),
]);

export type AstAnchor = z.infer<typeof AstAnchorSchema>;

export const LineRangeSchema = z
  .object({
    start: z.number().int().min(1),
    end: z.number().int().min(1),
  })
  .refine((r) => r.end >= r.start, {
    message: "lineRange.end must be >= lineRange.start",
    path: ["end"],
  });

export type LineRange = z.infer<typeof LineRangeSchema>;

export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const SourceSchema = z.enum(["human", "ai", "import", "unknown"]);
export type Source = z.infer<typeof SourceSchema>;

export const MappingStatusSchema = z.enum(["mapped", "uncertain", "orphaned"]);
export type MappingStatus = z.infer<typeof MappingStatusSchema>;

/**
 * Captures the decision context for an annotation — answering not just
 * "what does this code do?" but "why was this approach chosen?"
 *
 * All fields are optional so that existing entries (schemaVersion "1.0.0")
 * remain valid without migration; the block itself is optional on
 * ContextEntry and defaults to undefined for human-authored entries.
 */
export const OriginSchema = z.object({
  /**
   * Source of the code that produced this annotation.
   * Mirrors ContextEntry.source but lives here for independent evolution.
   */
  type: z.enum(["ai", "human", "import"]),

  /**
   * Why this approach was chosen over alternatives.
   * This is the primary capture target — a human-readable decision rationale.
   * Example: "Myers O(ND) chosen for minimal edit script; histogram fallback
   * added because Myers degrades to O(N²) on pathological inputs."
   */
  summary: z.string().min(1).optional(),

  /**
   * SHA-256 (or FNV-1a) hash of the prompt that produced this code.
   * Stored whenever a prompt is known; enables deduplication and session
   * linkage without storing the full prompt text by default.
   */
  promptHash: z.string().optional(),

  /**
   * Full prompt text. Only captured when `origin.capture_prompt: true`
   * is set in kodela.config.json. Not stored by default.
   * Privacy note: do not enable in repositories with sensitive system prompts.
   */
  prompt: z.string().optional(),

  /**
   * Ordered chain of reasoning steps or alternatives considered.
   * ["Minimal edit distance required", "Myers is optimal O(ND)",
   *  "Fallback required for large files due to quadratic worst case"]
   */
  reasoning: z.array(z.string().min(1)).optional(),

  /**
   * The AI tool that generated the code.
   * Examples: "claude-cli", "copilot", "chatgpt", "gemini".
   */
  tool: z.string().optional(),

  /**
   * Specific model version used.
   * Examples: "gpt-4o", "claude-3-5-sonnet-20241022", "gemini-1.5-pro".
   */
  model: z.string().optional(),

  /**
   * Session or conversation identifier.
   * Allows grouping multiple annotations that came from the same AI session.
   */
  sessionId: z.string().optional(),

  /**
   * ISO 8601 timestamp of when the AI generated the code.
   * May differ from ContextEntry.createdAt, which records when the
   * annotation itself was written.
   */
  generatedAt: z.string().datetime().optional(),
});

export type Origin = z.infer<typeof OriginSchema>;

/**
 * Gap 50 — Integration with existing "why" stores.
 *
 * Links a Kodela annotation to an external issue/document (Linear ticket,
 * Jira issue, Notion page, Confluence doc, or any URL).
 *
 * `type`  — provider identifier, derived from the URL at write time.
 * `id`    — provider-native identifier (e.g. "ENG-1234", UUID, or URL slug).
 * `url`   — canonical URL that opens the issue/document in a browser.
 * `title` — human-readable summary fetched from the provider API.
 *            Left blank when the provider API key is absent or unavailable.
 */
export const ExternalRefSchema = z.object({
  type: z.enum(["linear", "jira", "notion", "confluence", "url"]),
  id: z.string().min(1),
  url: z.string().url(),
  title: z.string().optional(),
});

export type ExternalRef = z.infer<typeof ExternalRefSchema>;

/**
 * Gap 102 — Structured AI annotation summary.
 * Replaces the unstructured `origin.summary` string with a typed object
 * capturing intent, change classification, risk, and a short description.
 */
export const AnnotationSummarySchema = z.object({
  /** Developer-readable intent: what the AI was asked to do (≤ 200 chars). */
  intent: z.string().min(1).max(200),
  /**
   * Structural classification of the change:
   *   "new-file"     — file did not exist before
   *   "addition"     — lines only added, none removed
   *   "modification" — mixed additions and removals
   *   "refactor"     — high removal-to-addition ratio, no net behaviour change
   *   "fix"          — small targeted change to correct a defect
   */
  changeType: z.enum(["new-file", "addition", "modification", "refactor", "fix"]),
  /** Risk level derived from file path, sensitive scope, and change size. */
  risk: z.enum(["low", "medium", "high"]),
  /** ≤ 200-char summary extracted from symbol names or the AI proposal note. */
  shortSummary: z.string().max(200),
});

export type AnnotationSummary = z.infer<typeof AnnotationSummarySchema>;

/**
 * Gap 102 — Raw capture context stored alongside the enriched summary.
 * Preserved at annotation time so downstream tools can re-derive metrics.
 */
export const RawContextSchema = z.object({
  linesAdded: z.number().int().min(0),
  linesRemoved: z.number().int().min(0),
  fileCount: z.number().int().min(1),
  /** Unified diff (before → after). Present when captureReasoning is true. */
  diff: z.string().optional(),
  /** Session ID promoting from origin.sessionId for quick access. */
  sessionId: z.string().optional(),
});

export type RawContext = z.infer<typeof RawContextSchema>;

export const ContextEntrySchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().uuid(),
  filePath: z
    .string()
    .min(1)
    .refine((p) => !p.includes(".."), {
      message: "filePath must not contain '..' segments",
    }),
  astAnchor: AstAnchorSchema,
  contentHash: z.string().min(1),
  lineRange: LineRangeSchema,
  note: z.string().min(1),
  author: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  severity: SeveritySchema,
  tags: z.array(z.string().min(1)),
  source: SourceSchema,
  aiTool: z.string().optional(),
  /**
   * URL to the AI chat session or conversation that produced the annotated code.
   * Allows developers to deep-link back to the original AI context (e.g. a
   * Claude share link, a ChatGPT shared chat, a Copilot Chat history URL).
   * When absent, the `note` / `origin.summary` text is the only available context.
   */
  link: z.string().url().optional(),
  confidence: z.number().min(0).max(1),
  /**
   * Confidence that the `aiTool` attribution is correct (0–1).
   * Determined by which detection layer attributed the tool:
   *   1.0 = KODELA_AGENT env var (explicit)
   *   0.95 = .kodela/origin.json sidecar (agent self-reported)
   *   0.90 = VS Code command prefix (AiToolTracker)
   *   0.50 = known agent env var (CURSOR_TRACE_ID, CLAUDE_SESSION_ID, …)
   *   0.75 = git commit Co-authored-by trailer
   *   0.70 = process ancestry (binary name match)
   *   0.50 = file-change heuristics
   *   0.00 = no attribution (stub)
   * Absent when aiTool is not set.
   */
  attributionConfidence: z.number().min(0).max(1).optional(),
  /**
   * When true, the heal engine may upgrade aiTool and attributionConfidence
   * if a higher-confidence source becomes available later (e.g. a git commit
   * with a Co-authored-by trailer that wasn't present when the entry was
   * first written). Defaults to true when attributionConfidence < 0.8.
   */
  canUpgradeAttribution: z.boolean().optional(),
  /**
   * Gap 23 G3 / Gap 24 Phase A — UBA fusion score (0–1).
   * Weighted combination of five behavioral signals:
   *   A(0.35) edit pattern + B(0.25) temporal + C(0.20) file scope +
   *   D(0.10) structural change + E(0.10) environment.
   * Absent for entries created before the UBA scorer was introduced.
   */
  classificationScore: z.number().min(0).max(1).optional(),
  /**
   * Gap 24 Phase A — Per-signal breakdown for explainability.
   * Keys: "editPattern", "temporalSignature", "fileScope",
   *       "structuralChange", "environment" (each in [0, 1]).
   * Absent for pre-UBA entries.
   */
  classificationSignals: z.record(z.string(), z.number()).optional(),
  /**
   * Gap 24 Phase A — Sub-classification for bulk changes that are not AI-generated.
   * "bulk-insert": large single-event paste / copy-paste insertion.
   * Absent unless explicitly classified.
   */
  subType: z.enum(["bulk-insert"]).optional(),
  /**
   * Gap 23 G3 — Human override lock.
   * Set to true by `kodela correct` to prevent automated reclassification.
   * When true, the heal engine and scoring engine must not modify this entry.
   * Pairs with `canUpgradeAttribution: false`.
   */
  userOverride: z.boolean().optional(),
  /**
   * Gap 20c — Scheduled reporting snooze.
   * ISO-8601 datetime.  When present and in the future, `kodela report`
   * excludes this entry from the debt-score ranking so teams can silence
   * known-but-deferred items without deleting them.
   * Cleared automatically once the date passes.
   */
  snoozedUntil: z.string().datetime().optional(),
  status: MappingStatusSchema,
  reviewRequired: z.boolean(),
  /**
   * Gap 45 — Structured AI code review sign-off workflow.
   * The email address (or username) of the person assigned to review
   * this AI-generated annotation. Set via `kodela assign <id> --to <email>`.
   * Absent when no reviewer has been assigned.
   */
  reviewerOwner: z.string().optional(),
  /**
   * Gap 48 — Content-change fingerprint.
   * Lightweight identifier set extracted from the annotated code region at
   * write / heal time.  Used by the drift engine to detect semantic divergence.
   * Absent on entries created before Gap 48 was deployed.
   */
  contentFingerprint: z.array(z.string()).optional(),
  /**
   * Gap 48 — Content drift level.
   * Computed by comparing the stored `contentFingerprint` against the current
   * code at the mapped line range (Jaccard distance).
   *   "low"    → distance < 0.20  (code barely changed)
   *   "medium" → 0.20 ≤ distance < 0.50
   *   "high"   → distance ≥ 0.50  (annotation may be stale)
   * Absent until the first post-Gap-48 heal run.
   */
  contentDrift: z.enum(["low", "medium", "high"]).optional(),
  /**
   * Gap 48 — Last AI-powered annotation validation result.
   * Written by `kodela validate`.
   * `valid` indicates whether the AI judged the annotation note to still
   * accurately describe the current code.
   * `discrepancy` is the AI-generated explanation when `valid` is false.
   */
  lastValidation: z
    .object({
      validatedAt: z.string().datetime(),
      valid: z.boolean(),
      discrepancy: z.string().optional(),
    })
    .optional(),
  /**
   * Gap 50 — External reference to an issue tracker or knowledge base.
   * Links this annotation to the Linear ticket, Jira issue, Notion page,
   * Confluence doc, or any URL that documents the reason the code was written.
   * Set via `kodela add --ref <url>` or `kodela link <id> --ref <url>`.
   * Optional — absent for entries created before Gap 50.
   */
  externalRef: ExternalRefSchema.optional(),
  /**
   * Decision context for this annotation.
   * Captures why the code was written this way — the AI prompt, the
   * reasoning chain, and the alternatives that were considered.
   * Absent for older entries (schemaVersion "1.0.0") and human edits
   * where no AI decision context was captured.
   */
  origin: OriginSchema.optional(),
  /**
   * Gap 59 — Intent cluster this entry belongs to.
   * Links the annotation to the AI intent cluster that produced the
   * code change. Absent for entries created before Gap 59.
   */
  clusterId: z.string().uuid().optional(),
  /**
   * Gap 59 — Top-level session identifier.
   * Promoted from `origin.sessionId` for efficient session-scoped queries.
   * Absent for entries created before Gap 59.
   */
  sessionId: z.string().optional(),
  /**
   * Gap 57 — Typed code scope derived from the three-signal classifier.
   * One of: auth, db, infra, ui, api, payments, crypto, config, test, general.
   * Absent for entries created before Gap 57.
   */
  scope: CodeScopeSchema.optional(),
  /**
   * Gap 53 — Structured reasoning artefact extracted from the AI activity
   * that produced this annotation.
   *
   * Populated by `kodela extract-reasoning` (on-demand), by the hook
   * processor's extraction queue (automatically on PostToolUse), or by
   * the fallback inference path when no AI provider is configured.
   *
   * Optional for backward compatibility — absent for entries created before
   * Gap 53. The schema version remains "1.1.0" (minor field addition).
   */
  reasoning: ReasoningObjectSchema.optional(),

  /**
   * Gap 101 — Persisted trust level for this entry.
   * "high"   = deterministic source (hook, KODELA_AGENT env, SDK call)
   * "medium" = mixed signals (known env + UBA corroboration)
   * "low"    = heuristic only (UBA watcher without explicit signal)
   * Absent for entries created before Gap 101.
   */
  trustLevel: z.enum(["high", "medium", "low"]).optional(),

  /**
   * Gap 101 — Which ingestion path created this entry.
   * "hook"    = Claude Code / git hook / Cursor hook
   * "watcher" = kodela watch --auto-annotate filesystem watcher
   * "manual"  = kodela add (developer-authored)
   * "sdk"     = ingestAIContext() programmatic call
   * Absent for entries created before Gap 101.
   */
  sourceType: z.enum(["hook", "watcher", "manual", "sdk"]).optional(),

  /**
   * Gap 101 — How the classification was determined.
   * "deterministic" = AI tool self-reported; no guesswork involved
   * "heuristic"     = inferred from UBA behavioral signals
   * Absent for entries created before Gap 101.
   */
  ingestion: z.enum(["deterministic", "heuristic"]).optional(),

  /**
   * Gap 102 — Structured annotation summary.
   * Captures intent, change type, risk, and a short description.
   * Absent for entries created before Gap 102.
   */
  summary: AnnotationSummarySchema.optional(),

  /**
   * Gap 102 — Raw capture context stored at annotation time.
   * Absent for entries created before Gap 102.
   */
  rawContext: RawContextSchema.optional(),
});

export type ContextEntry = z.infer<typeof ContextEntrySchema>;

export const IndexFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  entries: z.array(z.string().uuid()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type IndexFile = z.infer<typeof IndexFileSchema>;

export const MappingFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  filePathHash: z.string().min(1),
  updatedAt: z.string().datetime(),
  mappings: z.array(
    z.object({
      entryId: z.string().uuid(),
      lineRange: LineRangeSchema,
      confidence: z.number().min(0).max(1),
      status: MappingStatusSchema,
    }),
  ),
});

export type MappingFile = z.infer<typeof MappingFileSchema>;

export const BaselineFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  createdAt: z.string().datetime(),
  trackedFiles: z.record(
    z.string(),
    z.object({
      contentHash: z.string().min(1),
      astFingerprint: z.string(),
    }),
  ),
});

export type BaselineFile = z.infer<typeof BaselineFileSchema>;

/**
 * Gap 45 — Structured AI code review sign-off workflow.
 *
 * A `SignOffRecord` is written to `.kodela/signoffs/<entryId>.json` when a
 * reviewer runs `kodela signoff <entryId>`.  It provides an immutable,
 * tamper-evident audit trail: who reviewed the AI-generated change, when,
 * and any free-text comment they left.
 *
 * The record is intentionally separate from `ContextEntry` so that:
 *   1. Sign-offs survive heal/archive cycles that rewrite the entry.
 *   2. Multiple sign-offs for the same entry are supported (edge case:
 *      re-review after a major code change).
 */
export const SignOffRecordSchema = z.object({
  id: z.string().uuid(),
  entryId: z.string().uuid(),
  reviewer: z.string().min(1),
  signedOffAt: z.string().datetime(),
  comment: z.string().optional(),
});

export type SignOffRecord = z.infer<typeof SignOffRecordSchema>;

/**
 * Gap 44 — Annotation discussion threads.
 *
 * A `ContextComment` is appended to `.kodela/comments/<entryId>.json`
 * when a user runs `kodela discuss <entryId> --add "text"`.
 *
 * The file stores an ordered array of comments (newest last).  Resolved
 * comments retain their data but gain a `resolvedAt` timestamp; they are
 * hidden from the default listing but preserved in the audit trail.
 */
export const ContextCommentSchema = z.object({
  id: z.string().uuid(),
  entryId: z.string().uuid(),
  author: z.string().min(1),
  body: z.string().min(1),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
});

export type ContextComment = z.infer<typeof ContextCommentSchema>;
