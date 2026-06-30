// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * @workspace/mcp-server — Gap 54
 *
 * MCP (Model Context Protocol) server for Kodela.
 *
 * Gap 54 Phase A: connection lifecycle — server initialises, announces
 *   capabilities, and handles the MCP handshake over stdio transport.
 * Gap 54 Phase B: `kodela_get_context` tool — ranked context query.
 * Gap 54 Phase C: `kodela://file/{path}` resource — file context resource.
 * Gap 54 Phase E: In-memory entry cache with fs.watch invalidation.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import path from "node:path";
import { openIndex, KODELA_DIR } from "@kodela/core";
import type { DatabaseSync } from "node:sqlite";
import { createEntryCache } from "./cache.js";
import {
  getContext,
  GetContextInputSchema,
  getContextV4,
  getContextV4Debug,
  GetContextV4InputSchema,
} from "./tools/get-context.js";
import {
  getFusedContext,
  GetFusedContextInputSchema,
} from "./tools/get-fused-context.js";
import { annotate, AnnotateInputSchema, formatAnnotateResponse } from "./tools/annotate.js";
import {
  annotateFile,
  AnnotateFileInputSchema,
  formatAnnotateFileResponse,
} from "./tools/annotate-file.js";
import {
  sessionStart,
  SessionStartInputSchema,
  formatSessionStartResponse,
} from "./tools/session-start.js";
import {
  sessionEnd,
  SessionEndInputSchema,
  formatSessionEndResponse,
} from "./tools/session-end.js";
import {
  recordDecision,
  RecordDecisionInputSchema,
  formatRecordDecisionResponse,
} from "./tools/record-decision.js";
import {
  getDecisionForMcp,
  GetDecisionInputSchema,
  formatGetDecisionResponse,
} from "./tools/get-decision.js";
import {
  searchDecisionsForMcp,
  SearchDecisionsInputSchema,
  formatSearchDecisionsResponse,
} from "./tools/search-decisions.js";
import {
  supersedeDecisionForMcp,
  SupersedeDecisionInputSchema,
  formatSupersedeDecisionResponse,
} from "./tools/supersede-decision.js";
import {
  recordDecisionOutcomeForMcp,
  RecordDecisionOutcomeInputSchema,
  formatRecordDecisionOutcomeResponse,
} from "./tools/record-decision-outcome.js";
import {
  listSessionsForMcp,
  ListSessionsInputSchema,
  formatListSessionsResponse,
} from "./tools/list-sessions.js";
import {
  generateHandoffForMcp,
  GenerateHandoffInputSchema,
  formatGenerateHandoffResponse,
} from "./tools/generate-handoff.js";
import {
  queryForMcp,
  QueryInputSchema,
  formatQueryResponse,
} from "./tools/query.js";
import {
  getWhyForMcp,
  GetWhyInputSchema,
  formatGetWhyResponse,
} from "./tools/get-why.js";
import {
  getFunctionContextForMcp,
  GetFunctionContextInputSchema,
  formatFunctionContextResponse,
} from "./tools/get-function-context.js";
import {
  findRelatedChangesForMcp,
  FindRelatedChangesInputSchema,
  formatFindRelatedChangesResponse,
} from "./tools/find-related-changes.js";
import {
  getProjectDnaForMcp,
  GetProjectDnaInputSchema,
  formatGetProjectDnaResponse,
} from "./tools/get-project-dna.js";
import {
  getArchitectureForMcp,
  GetArchitectureInputSchema,
  formatGetArchitectureResponse,
} from "./tools/get-architecture.js";
import {
  getRisksForMcp,
  GetRisksInputSchema,
  formatGetRisksResponse,
} from "./tools/get-risks.js";
import { ensureDecisionTables } from "./lib/decisions-store.js";
import { ensureGraphTables } from "./lib/graph-store.js";
import { closeIdleSessions, DEFAULT_IDLE_THRESHOLD_MS } from "./lib/idle-close.js";
import { resolveFileContextResource } from "./resources/file-context.js";
import { buildManifest } from "./resources/manifest.js";
import { initDeploymentStorage } from "./lib/deployment-storage.js";

const SERVER_NAME = "kodela" as const;
const SERVER_VERSION = "0.1.0" as const;

const repoRoot = process.env.KODELA_REPO_ROOT ?? process.cwd();

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

async function main(): Promise<void> {
  // ── Deployment-aware storage (team/SaaS Postgres routing) ─────────────────
  // Resolve the deployment mode so the MCP write path matches where the
  // dashboard reads. In `saas` mode this returns a Postgres-backed
  // StorageBackend that the annotate tools dual-write to; in local mode it is
  // null and behaviour is unchanged. Fails loud on a misconfigured saas mode
  // rather than silently writing only to local SQLite.
  const deployment = await initDeploymentStorage(repoRoot);
  const backend = deployment.backend;
  for (const w of deployment.warnings) {
    process.stderr.write(`[kodela-mcp] warning: ${w}\n`);
  }
  if (backend) {
    process.stderr.write(
      `[kodela-mcp] deployment mode: ${deployment.mode} — context entries ` +
        `dual-written to Postgres (org ${deployment.tenant?.orgId}, repo ` +
        `${deployment.tenant?.repoId})\n`,
    );
  }

  // ── Phase E: warm in-memory cache ─────────────────────────────────────────
  const cache = await createEntryCache(repoRoot);

  // ── Gap 116: open SQLite index (Phase 4) ──────────────────────────────────
  let db: DatabaseSync | null = null;
  const dbPath = path.join(repoRoot, KODELA_DIR, "index.db");
  try {
    db = openIndex(dbPath);
  } catch (err) {
    // index.db open failed — log so we can diagnose. The decision tools will
    // attempt a lazy re-open at each call so a transient failure here does
    // not permanently disable decision-intelligence for the rest of the process.
    process.stderr.write(
      `[kodela-mcp] warning: openIndex(${dbPath}) failed at boot: ${String(err)}\n`,
    );
  }

  // ── Decision Intelligence (MVP): ensure decision tables exist ─────────────
  if (db !== null) {
    try {
      ensureDecisionTables(db);
      ensureGraphTables(db);
    } catch (err) {
      process.stderr.write(
        `[kodela-mcp] warning: ensureDecisionTables/ensureGraphTables failed: ${String(err)}\n`,
      );
    }
  }

  // ── Boot-time idle-close (Sprint 1 / Pillar A) ────────────────────────────
  // Abandon any session that has been silent past the idle threshold so the
  // dashboard's open-session count reflects reality. Override the threshold
  // via KODELA_IDLE_CLOSE_MS for testing or stricter envs.
  const idleMs = Number(process.env.KODELA_IDLE_CLOSE_MS) || DEFAULT_IDLE_THRESHOLD_MS;
  try {
    const result = await closeIdleSessions(repoRoot, { maxIdleMs: idleMs });
    if (result.closed.length > 0) {
      process.stderr.write(
        `[kodela-mcp] auto-closed ${result.closed.length} idle session(s) at boot ` +
        `(threshold ${Math.round(idleMs / 60_000)} min)\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[kodela-mcp] warning: idle-close at boot failed: ${String(err)}\n`,
    );
  }

  // ── Phase B / Gap 116: kodela_get_context tool (upgraded) ─────────────────
  server.tool(
    "kodela_get_context",
    "Get ranked Kodela context (clusters + entries) for a file or intent.\n\n" +
    "When a local SQLite index exists (.kodela/index.db), returns cluster-aware,\n" +
    "token-bounded context via buildProjectContext. Falls back to flat file-based\n" +
    "annotation lookup when no index is present.\n\n" +
    "Parameters:\n" +
    "  file_path    — repo-relative path (e.g. src/auth/login.ts)\n" +
    "  intent       — hint to bias scoring (bugfix, refactor, new-file, addition)\n" +
    "  token_budget — max tokens to return (default 4000)\n" +
    "  line_start / line_end / max_results / include_reasoning — legacy params\n" +
    "    only used when index.db is absent",
    {
      file_path:         z.string().optional().describe("Repo-relative file path"),
      intent:            z.string().optional().describe("Intent hint (bugfix, refactor, new-file, …)"),
      token_budget:      z.number().int().positive().default(4000).describe("Token budget (default 4000)"),
      line_start:        z.number().int().positive().optional().describe("(Legacy) Start line, 1-indexed"),
      line_end:          z.number().int().positive().optional().describe("(Legacy) End line, 1-indexed"),
      max_results:       z.number().int().positive().default(5).describe("(Legacy) Maximum entries"),
      include_reasoning: z.boolean().default(true).describe("(Legacy) Include reasoning.intent"),
    },
    async (input) => {
      try {
        if (db !== null && (input.intent !== undefined || input.token_budget !== 4000 || input.line_start === undefined)) {
          // Phase 4 path — use buildProjectContext
          const v4Input = GetContextV4InputSchema.parse({
            file_path: input.file_path,
            intent: input.intent,
            token_budget: input.token_budget,
          });
          const envelope = getContextV4(repoRoot, v4Input, db);
          return {
            content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
          };
        }

        // Legacy path — file-based flat lookup
        if (!input.file_path) {
          return {
            content: [{ type: "text", text: JSON.stringify({ entries: [] }, null, 2) }],
          };
        }
        const results = await getContext(
          repoRoot,
          GetContextInputSchema.parse({
            file_path: input.file_path,
            line_start: input.line_start,
            line_end: input.line_end,
            max_results: input.max_results,
            include_reasoning: input.include_reasoning,
          }),
          cache,
        );

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ filePath: input.file_path, entries: [] }, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { filePath: input.file_path, entries: results },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── Gap 116: kodela_get_context_debug tool ─────────────────────────────────
  server.tool(
    "kodela_get_context_debug",
    "Return full scoring breakdown, cluster selection rationale, and timing for a context query.\n\n" +
    "Requires .kodela/index.db to be present. Returns the standard context envelope plus a\n" +
    "'debug' block with per-candidate scores and the reason each candidate was included or dropped.\n\n" +
    "Use this tool when diagnosing unexpected context results or tuning scoring weights.",
    {
      file_path:    z.string().optional().describe("Repo-relative file path"),
      intent:       z.string().optional().describe("Intent hint (bugfix, refactor, new-file, …)"),
      token_budget: z.number().int().positive().default(4000).describe("Token budget (default 4000)"),
    },
    async (input) => {
      try {
        if (db === null) {
          return {
            content: [
              {
                type: "text",
                text: "kodela_get_context_debug requires .kodela/index.db — run `kodela index` first.",
              },
            ],
            isError: true,
          };
        }

        const v4Input = GetContextV4InputSchema.parse(input);
        const { envelope, debug } = getContextV4Debug(repoRoot, v4Input, db);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...envelope, debug }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── Sprint 1 / [E.4]: kodela_get_fused_context tool ──────────────────────
  // One-call retrieval that returns code-context + decisions + sessions in one
  // envelope.  Closes doc 17 §3.1 "wedge demo" — the agent gets the full
  // fused-graph traversal without composing three separate tool calls.
  server.tool(
    "kodela_get_fused_context",
    "Return code-context + decisions + sessions for a file/intent in ONE envelope.\n\n" +
    "Same retrieval pipeline as kodela_get_context (scope filter → time filter →\n" +
    "scorer → token-budget trimmer) but ALSO surfaces the sessions that produced\n" +
    "the entries, so an agent can do the full fused-graph traversal (code → why →\n" +
    "session that introduced it) in a single round-trip.\n\n" +
    "Parameters:\n" +
    "  file_path    — repo-relative path (e.g. src/auth/login.ts)\n" +
    "  intent       — hint to bias scoring (bugfix, refactor, new-file, addition)\n" +
    "  token_budget — max tokens to return (default 4000)\n" +
    "  as_of        — ISO timestamp; bitemporal filter applied to both decisions and sessions",
    {
      file_path:    z.string().optional().describe("Repo-relative file path"),
      intent:       z.string().optional().describe("Intent hint (bugfix, refactor, new-file, …)"),
      token_budget: z.number().int().positive().default(4000).describe("Token budget (default 4000)"),
      as_of:        z.string().optional().describe("ISO timestamp — bitemporal filter for both decisions and sessions"),
    },
    async (input) => {
      try {
        if (db === null) {
          return {
            content: [
              {
                type: "text",
                text: "kodela_get_fused_context requires .kodela/index.db — run `kodela index` first.",
              },
            ],
            isError: true,
          };
        }

        const parsed = GetFusedContextInputSchema.parse(input);
        const envelope = getFusedContext(repoRoot, parsed, db);

        return {
          content: [
            { type: "text", text: JSON.stringify(envelope, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── Gap 126: kodela_annotate tool ─────────────────────────────────────────
  server.tool(
    "kodela_annotate",
    "Write a high-trust context annotation to the Kodela store.\n\n" +
    "Use this tool when you have made a meaningful code change and want to record\n" +
    "what was done, why, and what risk it carries.  Each annotation is stored with\n" +
    "  source: 'ai'  |  extractionMethod: 'mcp'  |  trustLevel: 'high'\n" +
    "so the dashboard and reasoning engine can distinguish MCP-authored annotations\n" +
    "from watcher-inferred ones.\n\n" +
    "Both the context entry AND the file-path mapping are written atomically so the\n" +
    "annotation is immediately retrievable via `kodela_get_context`.\n\n" +
    "Enrichment: supply file_content, diff, lines_added, lines_removed for full\n" +
    "pipeline coverage — content fingerprinting, drift detection, and a richer\n" +
    "AnnotationSummary. These fields are optional but strongly recommended.\n\n" +
    "Parameters:\n" +
    "  file_path     — repo-relative path (e.g. src/auth/login.ts)\n" +
    "  line_start    — first line of the annotated region (1-indexed)\n" +
    "  line_end      — last line of the annotated region (1-indexed, inclusive)\n" +
    "  intent        — what the change achieves (first-person, present-tense)\n" +
    "  change_type   — feature | fix | refactor | docs | test | chore\n" +
    "  risk          — low | medium | high | critical\n" +
    "  short_summary — one-sentence display summary (max 200 chars)\n" +
    "  reasoning     — optional: why this approach was chosen\n" +
    "  note          — optional: extended note; defaults to short_summary\n" +
    "  severity      — optional: low (default) | medium | high | critical\n" +
    "  session_id    — optional: Kodela session UUID to link this annotation to\n" +
    "  tags          — optional: freeform string tags\n" +
    "  file_content  — optional: full post-change file content (enables fingerprinting)\n" +
    "  diff          — optional: unified diff string (before → after)\n" +
    "  lines_added   — optional: number of lines added\n" +
    "  lines_removed — optional: number of lines removed",
    {
      file_path:     AnnotateInputSchema.shape.file_path,
      line_start:    AnnotateInputSchema.shape.line_start,
      line_end:      AnnotateInputSchema.shape.line_end,
      intent:        AnnotateInputSchema.shape.intent,
      change_type:   AnnotateInputSchema.shape.change_type,
      risk:          AnnotateInputSchema.shape.risk,
      short_summary: AnnotateInputSchema.shape.short_summary,
      reasoning:     AnnotateInputSchema.shape.reasoning,
      note:          AnnotateInputSchema.shape.note,
      severity:      AnnotateInputSchema.shape.severity,
      session_id:    AnnotateInputSchema.shape.session_id,
      tags:          AnnotateInputSchema.shape.tags,
      file_content:  AnnotateInputSchema.shape.file_content,
      diff:          AnnotateInputSchema.shape.diff,
      lines_added:   AnnotateInputSchema.shape.lines_added,
      lines_removed: AnnotateInputSchema.shape.lines_removed,
    },
    async (input) => {
      try {
        const parsed = AnnotateInputSchema.parse(input);
        const result = await annotate(repoRoot, parsed, db, backend);
        return {
          content: [{ type: "text", text: formatAnnotateResponse(result) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── Per-file MCP context capture: kodela_annotate_file ───────────────────
  server.tool(
    "kodela_annotate_file",
    "REQUIRED for every file modified in a session.\n\n" +
    "Captures who edited the file (AI tool, human, or mixed), why this specific\n" +
    "file was changed, and what problem the change solves. Session close will\n" +
    "fail with INCOMPLETE_PER_FILE_CONTEXT if any modified file lacks this context.\n\n" +
    "Call once per file, after writing the file. Can be called again to update\n" +
    "context (e.g. to upgrade source from 'ai' to 'mixed' after human refinement).\n\n" +
    "Parameters:\n" +
    "  session_id           — session UUID from kodela_session_start\n" +
    "  file_path            — repo-relative path (e.g. src/auth/jwt.ts)\n" +
    "  why_changed          — why THIS file needed to change (min 10 chars, file-specific)\n" +
    "  problem_solved       — what problem this change fixes/enables (min 10 chars)\n" +
    "  lines_added          — number of lines added\n" +
    "  lines_removed        — number of lines removed\n" +
    "  diff                 — optional: unified diff string\n" +
    "  file_content         — optional: full post-change content (enables fingerprinting)\n" +
    "  ai_reasoning         — optional: how the approach was chosen, what was rejected\n" +
    "  alternatives_considered — optional: alternatives evaluated and why rejected\n" +
    "  related_files        — optional: other files this change depends on\n" +
    "  modified_by          — optional: per-file actor override\n" +
    "    source: 'ai'       — AI wrote it (default, inherits session actor)\n" +
    "    source: 'human'    — developer hand-edited (tool/model forced to null)\n" +
    "    source: 'mixed'    — AI scaffolded, human refined\n" +
    "  risk                 — low (default) | medium | high | critical",
    {
      session_id:              AnnotateFileInputSchema.shape.session_id,
      file_path:               AnnotateFileInputSchema.shape.file_path,
      why_changed:             AnnotateFileInputSchema.shape.why_changed,
      problem_solved:          AnnotateFileInputSchema.shape.problem_solved,
      lines_added:             AnnotateFileInputSchema.shape.lines_added,
      lines_removed:           AnnotateFileInputSchema.shape.lines_removed,
      diff:                    AnnotateFileInputSchema.shape.diff,
      file_content:            AnnotateFileInputSchema.shape.file_content,
      ai_reasoning:            AnnotateFileInputSchema.shape.ai_reasoning,
      alternatives_considered: AnnotateFileInputSchema.shape.alternatives_considered,
      related_files:           AnnotateFileInputSchema.shape.related_files,
      modified_by:             AnnotateFileInputSchema.shape.modified_by,
      risk:                    AnnotateFileInputSchema.shape.risk,
    },
    async (input) => {
      try {
        const parsed = AnnotateFileInputSchema.parse(input);
        const result = await annotateFile(repoRoot, parsed, db, backend);
        return {
          content: [{ type: "text", text: formatAnnotateFileResponse(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── MCP Context Layer: kodela_session_start ───────────────────────────────
  server.tool(
    "kodela_session_start",
    "Start a Kodela session and record the user's intent (T1 — highest confidence).\n\n" +
    "Call ONCE at the beginning of a session, before any file changes are made.\n" +
    "Stores the user's exact prompt, actor metadata (tool/model/author),\n" +
    "branch context, and linked ticket so that kodela_session_end can assemble\n" +
    "a rich MCPContextEnvelope with 90-95% intent confidence.\n\n" +
    "Parameters:\n" +
    "  user_prompt    — the user's exact request, verbatim and unedited (required)\n" +
    "  actor_tool     — AI tool name, e.g. 'claude-code' or 'cursor' (required)\n" +
    "  actor_model    — model identifier, e.g. 'claude-sonnet-4'\n" +
    "  actor_author   — developer username or email\n" +
    "  branch_context — current git branch name\n" +
    "  linked_ticket  — ticket reference, e.g. 'JIRA-1234' or 'LINEAR-456'\n" +
    "  session_id     — explicit session UUID; auto-generated if omitted",
    {
      user_prompt:    SessionStartInputSchema.shape.user_prompt,
      actor_tool:     SessionStartInputSchema.shape.actor_tool,
      actor_model:    SessionStartInputSchema.shape.actor_model,
      actor_author:   SessionStartInputSchema.shape.actor_author,
      branch_context: SessionStartInputSchema.shape.branch_context,
      linked_ticket:  SessionStartInputSchema.shape.linked_ticket,
      session_id:     SessionStartInputSchema.shape.session_id,
    },
    async (input) => {
      try {
        const parsed = SessionStartInputSchema.parse(input);
        const result = await sessionStart(repoRoot, parsed, backend);
        return { content: [{ type: "text", text: formatSessionStartResponse(result) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── MCP Context Layer: kodela_session_end ─────────────────────────────────
  server.tool(
    "kodela_session_end",
    "Close a Kodela session and produce the MCPContextEnvelope.\n\n" +
    "Call ONCE when the session is complete. Closes the session, runs the 5-tier\n" +
    "WHY chain (T1 user-prompt → T2 assistant-turns → T3 commit → T4 heuristic → T5 structural),\n" +
    "assembles the MCPContextEnvelope with handoffSummary, and persists it to\n" +
    ".kodela/sessions/<sessionId>.mcp.json.\n\n" +
    "Returns the full MCPContextEnvelope — the agent can paste this directly into\n" +
    "a handoff message or new conversation context.\n\n" +
    "Parameters:\n" +
    "  session_id     — session UUID from kodela_session_start (required)\n" +
    "  outcome        — success | partial | abandoned (default: success)\n" +
    "  commit_message — commit message if one exists; used as T3 intent source\n" +
    "  force          — override enforcement; close even if files lack annotation\n" +
    "  force_reason   — reason for force-closing (recommended when force: true)",
    {
      session_id:     SessionEndInputSchema.shape.session_id,
      outcome:        SessionEndInputSchema.shape.outcome,
      commit_message: SessionEndInputSchema.shape.commit_message,
      force:          SessionEndInputSchema.shape.force,
      force_reason:   SessionEndInputSchema.shape.force_reason,
    },
    async (input) => {
      try {
        const parsed = SessionEndInputSchema.parse(input);
        const result = await sessionEnd(repoRoot, parsed, backend);
        return { content: [{ type: "text", text: formatSessionEndResponse(result) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── Decision Intelligence (MVP): kodela_record_decision ───────────────────
  server.tool(
    "kodela_record_decision",
    "Record an architectural / security / business / compliance / operational / " +
    "deprecation decision as a first-class entity, separate from per-file code " +
    "annotations.\n\n" +
    "Use this when the team makes a choice that future engineers (and AI agents) " +
    "will need to know about — vendor selections, refactors that change architecture, " +
    "rejected approaches, deprecation calls.\n\n" +
    "Required: title, category, problem (≥30 chars), decision (≥30 chars), " +
    "reason (≥50 chars), options (≥2, exactly one was_chosen=true, " +
    "rejection_reason required on non-chosen), author_id, decided_at (ISO).\n\n" +
    "Optional: org_id, repo_id, consequences, trade_offs, approver_ids, tags, " +
    "visibility, initial_links (ticket/session/entry/pr/commit/incident/adr/" +
    "document/discussion).\n\n" +
    "Status: 'active' if approver_ids non-empty, otherwise 'proposed'. " +
    "Returns the decision_id (DEC-NNNN, sequential per org).",
    {
      org_id:         RecordDecisionInputSchema.shape.org_id,
      repo_id:        RecordDecisionInputSchema.shape.repo_id,
      title:          RecordDecisionInputSchema.shape.title,
      category:       RecordDecisionInputSchema.shape.category,
      problem:        RecordDecisionInputSchema.shape.problem,
      decision:       RecordDecisionInputSchema.shape.decision,
      reason:         RecordDecisionInputSchema.shape.reason,
      consequences:   RecordDecisionInputSchema.shape.consequences,
      trade_offs:     RecordDecisionInputSchema.shape.trade_offs,
      options:        RecordDecisionInputSchema.shape.options,
      author_id:      RecordDecisionInputSchema.shape.author_id,
      approver_ids:   RecordDecisionInputSchema.shape.approver_ids,
      tags:           RecordDecisionInputSchema.shape.tags,
      visibility:     RecordDecisionInputSchema.shape.visibility,
      decided_at:     RecordDecisionInputSchema.shape.decided_at,
      initial_links:  RecordDecisionInputSchema.shape.initial_links,
    },
    async (input) => {
      try {
        const parsed = RecordDecisionInputSchema.parse(input);
        const result = recordDecision(repoRoot, parsed, db);
        return {
          content: [{ type: "text", text: formatRecordDecisionResponse(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── Decision Intelligence (MVP): kodela_search_decisions ──────────────────
  server.tool(
    "kodela_search_decisions",
    "Keyword + faceted search over decisions.\n\n" +
    "Filters: org_id, repo_id, query (free-text matches title/problem/decision/" +
    "reason/tags), category, status, tags, decided_after/before, limit (max 200).\n\n" +
    "MVP: keyword only (case-insensitive substring). Semantic search via " +
    "embeddings ships in Phase 2.",
    {
      org_id:         SearchDecisionsInputSchema.shape.org_id,
      repo_id:        SearchDecisionsInputSchema.shape.repo_id,
      query:          SearchDecisionsInputSchema.shape.query,
      category:       SearchDecisionsInputSchema.shape.category,
      status:         SearchDecisionsInputSchema.shape.status,
      tags:           SearchDecisionsInputSchema.shape.tags,
      decided_after:  SearchDecisionsInputSchema.shape.decided_after,
      decided_before: SearchDecisionsInputSchema.shape.decided_before,
      limit:          SearchDecisionsInputSchema.shape.limit,
    },
    async (input) => {
      try {
        const parsed = SearchDecisionsInputSchema.parse(input);
        const result = searchDecisionsForMcp(repoRoot, parsed, db);
        return {
          content: [{ type: "text", text: formatSearchDecisionsResponse(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── Decision Intelligence (MVP): kodela_supersede_decision ────────────────
  server.tool(
    "kodela_supersede_decision",
    "Transactional supersede: marks an existing decision as 'superseded' and " +
    "atomically creates a new decision with supersedes=[old_id].\n\n" +
    "Parameters:\n" +
    "  old_decision_id  — the existing decision to retire (e.g. 'DEC-0001')\n" +
    "  new_decision     — same shape as kodela_record_decision input\n\n" +
    "Fails if the old decision is already superseded/archived/rejected.",
    {
      old_decision_id: SupersedeDecisionInputSchema.shape.old_decision_id,
      new_decision:    SupersedeDecisionInputSchema.shape.new_decision,
    },
    async (input) => {
      try {
        const parsed = SupersedeDecisionInputSchema.parse(input);
        const result = supersedeDecisionForMcp(repoRoot, parsed, db);
        return {
          content: [{ type: "text", text: formatSupersedeDecisionResponse(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── Decision Intelligence (MVP): kodela_get_decision ──────────────────────
  server.tool(
    "kodela_get_decision",
    "Retrieve a decision by id, returning the decision, its options, and its links.\n\n" +
    "Parameters:\n" +
    "  decision_id — e.g. 'DEC-0001'",
    {
      decision_id: GetDecisionInputSchema.shape.decision_id,
    },
    async (input) => {
      try {
        const parsed = GetDecisionInputSchema.parse(input);
        const result = getDecisionForMcp(repoRoot, parsed, db);
        return {
          content: [{ type: "text", text: formatGetDecisionResponse(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── Decision Intelligence: kodela_record_decision_outcome (07 §3.6) ───────
  server.tool(
    "kodela_record_decision_outcome",
    "Record what actually happened after a decision shipped — the realized " +
    "outcome plus optional evidence links. Does not change the decision's " +
    "status; it closes the lifecycle loop (record → supersede → outcome).\n\n" +
    "Parameters:\n" +
    "  decision_id    — e.g. 'DEC-0001'\n" +
    "  outcome        — what happened (min 30 chars)\n" +
    "  evidence_links — optional [{ kind, url, label? }]",
    {
      decision_id:    RecordDecisionOutcomeInputSchema.shape.decision_id,
      outcome:        RecordDecisionOutcomeInputSchema.shape.outcome,
      evidence_links: RecordDecisionOutcomeInputSchema.shape.evidence_links,
    },
    async (input) => {
      try {
        const parsed = RecordDecisionOutcomeInputSchema.parse(input);
        const result = recordDecisionOutcomeForMcp(repoRoot, parsed, db);
        return {
          content: [{ type: "text", text: formatRecordDecisionOutcomeResponse(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── kodela_list_sessions (07 §3.15) ───────────────────────────────────────
  server.tool(
    "kodela_list_sessions",
    "List captured sessions, most-recent first, with light filtering and " +
    "keyset pagination.\n\n" +
    "Filters: actor_tool[], started_after/before (ISO), has_high_risk.\n" +
    "Pagination: limit (default 25, max 100), cursor (pass back next_cursor).\n\n" +
    "Note: a session's outcome is not persisted, so it is not returned. Each " +
    "row carries session_id, started_at, ended_at, actor_tool, file_count, " +
    "risk, and a one-line summary.",
    {
      filters: ListSessionsInputSchema.shape.filters,
      limit:   ListSessionsInputSchema.shape.limit,
      cursor:  ListSessionsInputSchema.shape.cursor,
    },
    async (input) => {
      try {
        const parsed = ListSessionsInputSchema.parse(input);
        const result = await listSessionsForMcp(repoRoot, parsed);
        return {
          content: [{ type: "text", text: formatListSessionsResponse(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── kodela_generate_handoff (07 §3.13) ────────────────────────────────────
  server.tool(
    "kodela_generate_handoff",
    "Generate an audience-tailored handoff from a closed session's envelope.\n\n" +
    "audience: 'ai-agent' (continue-from framing, next steps lead), " +
    "'human-engineer' (narrative), or 'reviewer' (risk-first, review queue) — " +
    "each produces a distinct shape.\n\n" +
    "Requires the session to have been closed with kodela_session_end. " +
    "open_questions and dna_excerpt are not yet sourced and are flagged in meta.",
    {
      session_id:             GenerateHandoffInputSchema.shape.session_id,
      audience:               GenerateHandoffInputSchema.shape.audience,
      include_dna:            GenerateHandoffInputSchema.shape.include_dna,
      include_open_questions: GenerateHandoffInputSchema.shape.include_open_questions,
      token_budget:           GenerateHandoffInputSchema.shape.token_budget,
    },
    async (input) => {
      try {
        const parsed = GenerateHandoffInputSchema.parse(input);
        const result = await generateHandoffForMcp(repoRoot, parsed);
        return {
          content: [{ type: "text", text: formatGenerateHandoffResponse(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── kodela_query (07 §3.1) — unified retrieval ────────────────────────────
  server.tool(
    "kodela_query",
    "Unified keyword retrieval over context entries + decisions (+ optional " +
    "sessions).\n\n" +
    "query (required), mode (semantic/keyword/hybrid — MVP runs keyword), " +
    "scope {org_id, repo_id, file_path, session_id}, filters {severity[], " +
    "source[], ai_tool[], tags[], date_after/before}, include {entries, " +
    "decisions, sessions}, limit (default 20), token_budget (default 8000).\n\n" +
    "Entry text search walks .kodela/objects on disk and is capped; any " +
    "truncation (scan cap, limit, token budget) is reported in meta.",
    {
      query:        QueryInputSchema.shape.query,
      mode:         QueryInputSchema.shape.mode,
      scope:        QueryInputSchema.shape.scope,
      filters:      QueryInputSchema.shape.filters,
      include:      QueryInputSchema.shape.include,
      limit:        QueryInputSchema.shape.limit,
      token_budget: QueryInputSchema.shape.token_budget,
    },
    async (input) => {
      try {
        const parsed = QueryInputSchema.parse(input);
        const result = await queryForMcp(repoRoot, parsed, db);
        return {
          content: [{ type: "text", text: formatQueryResponse(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── kodela_get_why (07 §3.7) — the headline "why is this here?" ───────────
  server.tool(
    "kodela_get_why",
    "Answer 'why is this code here?' for a file by traversing the memory graph " +
    "from its FILE_CHANGE nodes to the DECISIONs that motivated it.\n\n" +
    "file_path (required), line_range (accepted, MVP is file-level), scope, " +
    "include_intermediate_evidence (default true), max_depth (default 3), " +
    "min_edge_confidence (default 0.6).\n\n" +
    "Returns ranked decisions with reason excerpts and the evidence chain. " +
    "Note: surfaces decisions only for files linked via annotate_file's " +
    "linked_decision_ids (or a decision's entry link); meta.notes says when empty.",
    {
      file_path:                     GetWhyInputSchema.shape.file_path,
      line_range:                    GetWhyInputSchema.shape.line_range,
      scope:                         GetWhyInputSchema.shape.scope,
      include_intermediate_evidence: GetWhyInputSchema.shape.include_intermediate_evidence,
      max_depth:                     GetWhyInputSchema.shape.max_depth,
      min_edge_confidence:           GetWhyInputSchema.shape.min_edge_confidence,
    },
    async (input) => {
      try {
        const parsed = GetWhyInputSchema.parse(input);
        const result = getWhyForMcp(repoRoot, parsed, db);
        return {
          content: [{ type: "text", text: formatGetWhyResponse(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── kodela_get_function_context — the FUSED query (code → session → decision) ─
  server.tool(
    "kodela_get_function_context",
    "Answer 'why does this function exist, and what decided it?' by traversing " +
    "the fused memory graph from a CODE_FUNCTION node to the session that " +
    "produced it, the decision(s) it implements, and any linked PRs / incidents.\n\n" +
    "file_path (required), ast_anchor (required — the stable '<kind>:<name>' id, " +
    "e.g. 'function:roundToDecimals'), min_confidence (optional).\n\n" +
    "Functions are linked into the graph automatically when kodela_annotate_file " +
    "is called with file_content. Returns sessions (with start time + goal), " +
    "decisions (with title/category/status), PRs, and incidents.",
    {
      file_path:      GetFunctionContextInputSchema.shape.file_path,
      ast_anchor:     GetFunctionContextInputSchema.shape.ast_anchor,
      min_confidence: GetFunctionContextInputSchema.shape.min_confidence,
    },
    async (input) => {
      try {
        const parsed = GetFunctionContextInputSchema.parse(input);
        const result = await getFunctionContextForMcp(repoRoot, parsed, db);
        return { content: [{ type: "text", text: formatFunctionContextResponse(result) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── kodela_find_related_changes (07 §3.8) ─────────────────────────────────
  server.tool(
    "kodela_find_related_changes",
    "Given an anchor node, find related nodes across the memory graph.\n\n" +
    "anchor { type: file_change|decision|ticket|incident|commit|pr, id }, " +
    "relation (all|caused-by|caused|co-changed|co-authored, default all), " +
    "limit (default 20). co-changed/co-authored apply to a file_change anchor " +
    "(other files from the same session / same author).",
    {
      anchor:   FindRelatedChangesInputSchema.shape.anchor,
      relation: FindRelatedChangesInputSchema.shape.relation,
      limit:    FindRelatedChangesInputSchema.shape.limit,
    },
    async (input) => {
      try {
        const parsed = FindRelatedChangesInputSchema.parse(input);
        const result = findRelatedChangesForMcp(repoRoot, parsed, db);
        return {
          content: [{ type: "text", text: formatFindRelatedChangesResponse(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── kodela_get_project_dna (07 §3.10) — Project DNA ───────────────────────
  server.tool(
    "kodela_get_project_dna",
    "Return the project's DNA — purpose, stack, key constraints, non-goals, " +
    "recent decisions, and the list of REJECTED alternatives — so an AI agent " +
    "avoids project-rejected technologies (the headline ≥90% gate).\n\n" +
    "token_budget ≤ 2048 → pocket (identity + rejected-tech, ideal for session " +
    "start); larger → adds the technical block, active decisions, and " +
    "load-bearing decisions. MVP: scope='project' (deterministic, computed on " +
    "read). Seed .kodela/dna/project.json for purpose/stack/non-goals. " +
    "Seeded claims that name a rejected alternative are dropped + flagged in meta.",
    {
      org_id:                   GetProjectDnaInputSchema.shape.org_id,
      repo_id:                  GetProjectDnaInputSchema.shape.repo_id,
      scope:                    GetProjectDnaInputSchema.shape.scope,
      module_path:              GetProjectDnaInputSchema.shape.module_path,
      file_path:                GetProjectDnaInputSchema.shape.file_path,
      token_budget:             GetProjectDnaInputSchema.shape.token_budget,
      include_decisions:        GetProjectDnaInputSchema.shape.include_decisions,
      include_recent_incidents: GetProjectDnaInputSchema.shape.include_recent_incidents,
      layer_min:                GetProjectDnaInputSchema.shape.layer_min,
      freshness_required:       GetProjectDnaInputSchema.shape.freshness_required,
    },
    async (input) => {
      try {
        const parsed = GetProjectDnaInputSchema.parse(input);
        const result = getProjectDnaForMcp(repoRoot, parsed, db);
        return {
          content: [{ type: "text", text: formatGetProjectDnaResponse(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── kodela_get_architecture (07 §3.11) ────────────────────────────────────
  server.tool(
    "kodela_get_architecture",
    "Return the project's Technical DNA (architecture pattern, package manager, " +
    "source modules, data stores, languages) — seed-first from " +
    ".kodela/dna/project.json plus unambiguous computed facts. detail_level: " +
    "pocket | standard | full (default standard).",
    {
      org_id:       GetArchitectureInputSchema.shape.org_id,
      repo_id:      GetArchitectureInputSchema.shape.repo_id,
      detail_level: GetArchitectureInputSchema.shape.detail_level,
    },
    async (input) => {
      try {
        const parsed = GetArchitectureInputSchema.parse(input);
        const result = getArchitectureForMcp(repoRoot, parsed, db);
        return {
          content: [{ type: "text", text: formatGetArchitectureResponse(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── kodela_get_risks (07 §3.12) ───────────────────────────────────────────
  server.tool(
    "kodela_get_risks",
    "Surface project risks: high/critical-severity or review-required changes " +
    "(grouped by file) and security/deprecation decisions. include_tech_debt " +
    "additionally scans entry tags (capped disk-walk, truncation reported in " +
    "meta). severity_min filters. Incident patterns are not produced yet.",
    {
      org_id:            GetRisksInputSchema.shape.org_id,
      repo_id:           GetRisksInputSchema.shape.repo_id,
      severity_min:      GetRisksInputSchema.shape.severity_min,
      include_tech_debt: GetRisksInputSchema.shape.include_tech_debt,
    },
    async (input) => {
      try {
        const parsed = GetRisksInputSchema.parse(input);
        const result = await getRisksForMcp(repoRoot, parsed, db);
        return {
          content: [{ type: "text", text: formatGetRisksResponse(result) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ── Phase C: kodela://file/{path} resource ─────────────────────────────────
  server.resource(
    "file-context",
    new ResourceTemplate("kodela://file/{path}", { list: undefined }),
    async (uri, params) => {
      const uriPath = (params as { path?: string }).path ?? uri.pathname;
      const text = await resolveFileContextResource(
        decodeURIComponent(uriPath),
        { repoRoot, cache },
      );
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text,
          },
        ],
      };
    },
  );

  // ── kodela://manifest resource (07 §6) ─────────────────────────────────────
  // Versioned tool/capability manifest so AI clients can discover the tool
  // surface and feature-flag against per-tool versions.
  server.resource(
    "manifest",
    "kodela://manifest",
    async (uri) => {
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(buildManifest(SERVER_VERSION), null, 2),
          },
        ],
      };
    },
  );

  // ── Connect transport ──────────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[kodela-mcp] server started — listening on stdio ` +
    `(${SERVER_NAME} v${SERVER_VERSION}, repo: ${path.basename(repoRoot)})\n`,
  );

  process.on("SIGINT", () => {
    cache.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cache.close();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[kodela-mcp] fatal: ${String(err)}\n`);
  process.exit(1);
});
