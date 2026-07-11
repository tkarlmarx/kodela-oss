// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { Command } from "commander";
import process from "node:process";
import { findRepoRoot } from "./utils/repo.js";
import { loadConfig, loadConfigSafe, ConfigLoadError, findConfigFile } from "./config/loader.js";
import { DEFAULT_CONFIG } from "./config/schema.js";
import { runInit, formatInitResult } from "./commands/init.js";
import { runUpgrade } from "./commands/upgrade.js";
import {
  runActivate,
  formatActivateResult,
  runLicenseStatus,
  formatLicenseStatus,
} from "./commands/activate.js";
import { runStatus } from "./commands/status.js";
import { runAdd } from "./commands/add.js";
import { runExplain, formatExplainResult, formatExplainShare } from "./commands/explain.js";
import { runCorrect, formatCorrectResult } from "./commands/correct.js";
import {
  runDirectiveAdd,
  runDirectiveList,
  runDirectiveRemove,
  formatDirectiveList,
} from "./commands/directive.js";
import { runEnrich, formatEnrichResult } from "./commands/enrich.js";
import { runHandoff } from "./commands/handoff.js";
import { runHeal, formatHealResult } from "./commands/heal.js";
import { runHealReAnchor, formatReAnchorResult } from "./commands/heal-reanchor.js";
import { runArchive, formatArchiveResult } from "./commands/archive.js";
import { runDiff, formatDiffResult, runFileAnalysis, formatFileAnalysisResult, runWorkingTreeAnalysis, formatWorkingTreeAnalysisResult, evaluateCiMode } from "./commands/diff.js";
import { runBlame, formatBlameResult } from "./commands/blame.js";
import { runAnnotate, formatAnnotateResult } from "./commands/annotate.js";
import { detectAiCommits, formatAiDetectionResult } from "./ai-detection/detect.js";
import { runRun, formatRunResult } from "./commands/run.js";
import { runWatch } from "./commands/watch.js";
import { runEmbed, prefetchEmbeddingModel } from "./commands/embed.js";
import { runConnect, formatConnectResult, resolveKodelaHome } from "./commands/connect.js";
import { runRotateKey, formatRotateKeyResult, handleRotateKeyError } from "./commands/rotate-key.js";
import {
  runMigrateToSaas,
  formatMigrateToSaasResult,
  handleMigrateToSaasError,
} from "./commands/migrate-to-saas.js";
import {
  runConfigPull,
  formatConfigPullResult,
  handleConfigPullError,
} from "./commands/config-pull.js";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  runWatchDetach,
  runWatchStop,
  runWatchStatus,
  formatWatchDetachResult,
  formatWatchStopResult,
  formatWatchStatus,
  installSupervisor,
  removeSupervisor,
  supervisorStatus,
  formatInstallSupervisorResult,
  formatRemoveSupervisorResult,
  formatSupervisorStatus,
} from "./commands/watch-daemon.js";
import { runSetup, formatSetupResult } from "./commands/setup.js";
import { runDoctor, formatDoctorResult } from "./commands/doctor.js";
import { CLI_VERSION } from "./config/loader.js";
import {
  runRetroactive,
  formatRetroactiveResult,
} from "./commands/retroactive.js";
import {
  runSearch,
  formatSearchResult,
} from "./commands/search.js";
import { runRecall } from "./commands/recall.js";
import { runHygiene, formatHygieneResult } from "./commands/hygiene.js";
import type { HygieneSeverity } from "@kodela/core/hygiene";
import { runCheck, formatCheckResult } from "./commands/check.js";
import { runGovernance, formatGovernance } from "./commands/governance.js";
import { loadLicense, fetchRemoteRecall, mergeRecallItems } from "@kodela/core";
import { resolveRepoIdentity } from "./utils/gitRemote.js";
import { runComprehend, formatComprehendResult } from "./commands/comprehend.js";
import { runTour, formatTourResult } from "./commands/tour.js";
import { runImpact, formatImpactResult } from "./commands/impact.js";
import { runArchitecture, formatArchitectureResult } from "./commands/architecture.js";
import {
  runExport,
  formatExportResult,
} from "./commands/export.js";
import {
  runAiLayer,
} from "./commands/ai-layer.js";
import {
  runInstallHooks,
  formatInstallHooksResult,
} from "./commands/install-hooks.js";
import {
  runInstallCi,
  formatInstallCiResult,
  CI_PLATFORMS,
  type CiPlatform,
} from "./commands/install-ci.js";
import type { OutputMode } from "./output/formatters.js";
import { OUTPUT_MODES } from "./output/formatters.js";
import { runReport, formatReportResult } from "./commands/report.js";
import { runSnooze, formatSnoozeResult } from "./commands/snooze.js";
import { runNudge, formatNudgeResult } from "./commands/nudge.js";
import { runHealth, formatHealthResult } from "./commands/health.js";
import { runGraph, formatGraphResult } from "./commands/graph.js";
import { runExportGraph } from "./commands/export-graph.js";
import type { ExportGraphFormat } from "./commands/export-graph.js";
import { runMemoryBank, formatMemoryBankResult } from "./commands/memory-bank.js";
import { runPack, formatPackResult } from "./commands/pack.js";
import { runView, serveView, formatViewResult, DEFAULT_VIEW_PORT } from "./commands/view.js";
import { runUi, DEFAULT_UI_PORT } from "./commands/ui.js";
import { runMetrics, formatMetricsResult } from "./commands/metrics.js";
import { runCaptureTier, formatCaptureTierResult } from "./commands/capture-tier.js";
import { integrate, runClaudeWithContext, formatInjectResult } from "./commands/integration.js";
import type { IntegrationTarget } from "./commands/integration.js";
import type { GraphQuery } from "./commands/graph.js";
import { runCapture } from "./commands/capture.js";
import { runAssign, formatAssignResult } from "./commands/assign.js";
import { runLink, formatLinkResult } from "./commands/link.js";
import { runValidate, formatValidateResult } from "./commands/validate.js";
import { runSignoff, formatSignoffResult } from "./commands/signoff.js";
import { runDiscuss, formatDiscussResult } from "./commands/discuss.js";
import { runPrComment, formatPrCommentResult } from "./commands/pr-comment.js";
import { runPropose, formatProposeResult } from "./commands/propose.js";
import { runMigrate, formatMigrateResult } from "./commands/migrate.js";
import { runGc, formatGcResult } from "./commands/gc.js";
import { runSync, formatSyncResult } from "./commands/sync.js";
import {
  runPolicyValidate,
  formatPolicyValidateResult,
  runPolicyInit,
  formatPolicyInitResult,
} from "./commands/policy.js";
import {
  runHookInstallClaude,
  formatHookInstallResult,
  runHookProcess,
} from "./commands/hook.js";
import {
  runHookInstallCursor,
  formatHookInstallCursorResult,
} from "./commands/hook-cursor.js";
import type { ClaudeHookEventType } from "./hooks/processor.js";
import {
  runExtractReasoning,
  formatExtractReasoningResult,
  formatExtractReasoningResultJson,
} from "./commands/extract-reasoning.js";
import {
  runSessionsList,
  runSessionsShow,
} from "./commands/sessions.js";
import {
  runMcpStart,
  runMcpStatus,
  formatMcpStart,
  formatMcpStatus,
} from "./commands/mcp.js";
import {
  runContext,
  formatContextResult,
  formatContextResultPretty,
  type ReadMode,
  type RemoteReadConfig,
} from "./commands/context.js";
import {
  runDetectAiChange,
  formatDetectAiChangeResult,
  formatDetectAiChangeResultJson,
} from "./commands/detect-ai-change.js";

// Version is injected at build time via build.mjs's esbuild `define` map —
// see config/loader.ts CLI_VERSION for the canonical source. Falls back to
// "0.0.0-dev" in tsx/dev-mode where the bundler hasn't run.
const pkg = { name: "@kodela/cli", version: CLI_VERSION };

const program = new Command();

program
  .name("kodela")
  .description("Code Context Infrastructure Layer")
  .version(pkg.version);

program
  .command("init")
  .description(
    "Initialize Kodela in the current repository.\n" +
    "  Creates .kodela/, kodela.config.json, .kodelaignore, and .kodela/GETTING_STARTED.md " +
    "if they do not already exist.\n" +
    "  Also installs .git/hooks/pre-commit and .git/hooks/post-commit automatically.\n" +
    "  Tip: prefer `kodela setup` for guided onboarding (auto-detects Claude Code).",
  )
  .option("-f, --force", "Reinitialize even if .kodela/ already exists", false)
  .option(
    "--no-hooks",
    "Skip automatic git hook installation (use this for CI, Husky, or Lefthook setups)",
    false,
  )
  .option(
    "--no-daemon",
    "Skip starting the background auto-annotate watcher (silent, tool-agnostic capture)",
  )
  .option(
    "--supervise",
    "Also install a launchd/systemd supervisor so the watcher survives reboots/crashes",
    false,
  )
  .option(
    "--no-encryption",
    "Skip generating a per-repo master key (internal design note). Use this only for plaintext local storage or SaaS deployments that inject KODELA_MASTER_KEY by env var.",
  )
  .action(async (opts: { force: boolean; hooks: boolean; daemon: boolean; supervise: boolean; encryption: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runInit(repoRoot, {
        force: opts.force,
        noHooks: !opts.hooks,
        noDaemon: !opts.daemon,
        supervise: opts.supervise,
        noEncryption: !opts.encryption,
        cliVersion: CLI_VERSION,
      });
      process.stdout.write(formatInitResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("setup")
  .description(
    "Guided onboarding — initializes the repo and selects a capture path.\n" +
    "  Auto-detects Claude Code (high confidence → installs hooks; otherwise → starts the watcher).\n" +
    "  Use --no-watcher to skip the watcher fallback in CI; --print-only for a dry-run preview.",
  )
  .option("--yes", "Non-interactive — never prompt; pick the safest default", false)
  // Commander treats `--no-watcher` specially: the option name is `watcher`,
  // it defaults to `true`, and passing `--no-watcher` flips it to `false`.
  // Passing an explicit default here would override that and break it.
  .option("--no-watcher", "Skip the watcher fallback when hooks aren't applicable")
  .option("--force", "Re-run safely; refresh _kodela block and overwrite GETTING_STARTED.md", false)
  .option("--print-only", "Dry-run — print the planned actions without executing them", false)
  .option(
    "--supervise",
    "When the watcher fallback is used, install a per-platform supervisor " +
      "(launchd / systemd / schtasks) so it auto-restarts after a crash or reboot.",
    false,
  )
  .option(
    "--cursor",
    "Install Cursor IDE hooks (.cursor/hooks) and record KODELA_HOME",
    false,
  )
  .option(
    "--kodela-home <path>",
    "Kodela monorepo path (for --cursor on external projects)",
  )
  .action(async (opts: {
    yes: boolean;
    watcher: boolean;
    force: boolean;
    printOnly: boolean;
    supervise: boolean;
    cursor: boolean;
    kodelaHome?: string;
  }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runSetup({
        repoRoot,
        yes: opts.yes,
        // commander negates --no-watcher → opts.watcher === false
        noWatcher: opts.watcher === false,
        force: opts.force,
        printOnly: opts.printOnly,
        supervise: opts.supervise,
        cursor: opts.cursor,
        kodelaHome: opts.kodelaHome,
      });
      process.stdout.write(formatSetupResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("rotate-key")
  .description(
    "Rotate the per-repo master encryption key (internal design note).\n" +
    "  Moves the current `.kodela.master-key` to `.kodela.master-key-<keyId>` (historical, " +
    "still readable for legacy envelopes) and writes a fresh 32-byte key as the new current key.\n" +
    "  Existing encrypted entries continue to decrypt via the historical file; new entries use the new key.",
  )
  .action(async () => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runRotateKey({ repoRoot });
      process.stdout.write(formatRotateKeyResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      handleRotateKeyError(err);
    }
  });

program
  .command("doctor")
  .description(
    "Diagnose your Kodela installation — runs fast checks and prints a ✔/⚠/✖ table " +
    "with one-line remediation hints.",
  )
  .option(
    "--fix",
    "Attempt safe automated remediations (currently: refresh stale or " +
      "missing _kodela metadata block in kodela.config.json).",
  )
  .action(async (opts: { fix?: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runDoctor({ repoRoot, fix: opts.fix === true });
      process.stdout.write(formatDoctorResult(result) + "\n");
      process.exit(result.healthy ? 0 : 1);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show context health metrics for the repository")
  .option("--ci", "Run in CI mode and check thresholds", false)
  .option(
    "-o, --output <format>",
    `Output format: ${OUTPUT_MODES.join(", ")}`,
    "text",
  )
  .action(async (opts: { ci: boolean; output: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const output = OUTPUT_MODES.includes(opts.output as OutputMode)
      ? (opts.output as OutputMode)
      : "text";
    try {
      const { output: text, exitCode } = await runStatus({
        repoRoot,
        ci: opts.ci,
        output,
      });
      process.stdout.write(text + "\n");
      process.exit(exitCode);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("add")
  .description("Annotate a range of lines with a context note")
  .argument("[file]", "File path (relative to repo root)")
  .option("-s, --start <line>", "Start line number")
  .option("-e, --end <line>", "End line number")
  .option("-n, --note <text>", "Context note")
  .option(
    "--severity <level>",
    "Severity: low, medium, high, critical",
    "low",
  )
  .option(
    "--source <source>",
    "Source: human, ai, import",
    "human",
  )
  .option(
    "--ai-tool <tool>",
    "AI tool name — known values (auto-resolve canonical link): " +
      "copilot, continue, codeium, tabnine, supermaven, cursor, amazon-q, windsurf, claude, chatgpt, gemini. " +
      "Unknown names are stored as-is (combine with --link for a custom URL). " +
      "Cursor IDE is detected automatically via CURSOR_TRACE_ID / CURSOR_SESSION_ID environment variables when this flag is omitted.",
  )
  .option(
    "--link <url>",
    "Gap 14: URL to the AI chat session that produced this code (e.g. a Claude share link). " +
      "Stored on the entry and surfaced in the VS Code hover as a clickable deep-link.",
  )
  .option("--tags <tags>", "Comma-separated tags")
  .option(
    "--origin-summary <text>",
    "Gap 13: Why this approach was chosen over alternatives (decision rationale)",
  )
  .option(
    "--origin-model <model>",
    "Gap 13: AI model version used (e.g. gpt-4o, claude-3-5-sonnet-20241022)",
  )
  .option(
    "--origin-session <id>",
    "Gap 13: Session/conversation ID to link entries from the same AI session",
  )
  .option(
    "--origin-prompt-file <path>",
    "Gap 13: Path to the prompt file (relative to repo root); content is hashed and stored",
  )
  .option(
    "--origin-reasoning <steps>",
    "Gap 13: Semicolon-separated reasoning steps / alternatives considered",
  )
  .option(
    "--ref <url>",
    "Gap 50: URL to the Linear ticket, Jira issue, Notion page, Confluence doc, or any URL " +
      "that documents why this code was written. Provider is auto-detected from the URL. " +
      "Title is fetched from the provider API when the relevant KODELA_*_API_KEY env var is set.",
  )
  .action(
    async (
      file: string | undefined,
      opts: {
        start?: string;
        end?: string;
        note?: string;
        severity?: string;
        source?: string;
        aiTool?: string;
        link?: string;
        tags?: string;
        originSummary?: string;
        originModel?: string;
        originSession?: string;
        originPromptFile?: string;
        originReasoning?: string;
        ref?: string;
      },
    ) => {
      const repoRoot = await findRepoRoot(process.cwd());
      const tags = opts.tags ? opts.tags.split(",").map((t) => t.trim()) : [];
      const originReasoning = opts.originReasoning
        ? opts.originReasoning.split(";").map((s) => s.trim()).filter(Boolean)
        : undefined;

      // Load config for origin capture settings (hash algorithm, capture_prompt flag)
      let config = DEFAULT_CONFIG;
      try {
        config = await loadConfig(repoRoot);
      } catch {
        // fall back to defaults if no config file
      }

      try {
        const { entry } = await runAdd({
          repoRoot,
          filePath: file,
          lineStart: opts.start ? parseInt(opts.start, 10) : undefined,
          lineEnd: opts.end ? parseInt(opts.end, 10) : undefined,
          note: opts.note,
          severity: opts.severity as any,
          source: opts.source as any,
          aiTool: opts.aiTool,
          link: opts.link,
          tags,
          originSummary: opts.originSummary,
          originModel: opts.originModel,
          originSessionId: opts.originSession,
          originPromptFile: opts.originPromptFile,
          originReasoning,
          capturePromptFull: config.origin.capture_prompt,
          captureReasoning: config.origin.capture_reasoning,
          hashAlgorithm: config.origin.hash_algorithm,
          ref: opts.ref,
        });
        process.stdout.write(
          `✓ Added context entry ${entry.id} for ${entry.filePath}:${entry.lineRange.start}-${entry.lineRange.end}${entry.origin ? " [with origin]" : ""}\n`,
        );
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    },
  );

program
  .command("explain")
  .description("Show context annotations for a file")
  .argument("<file>", "File path")
  .option("-l, --line <number>", "Show only entries covering this line")
  .option("-o, --output <format>", `Output format: ${OUTPUT_MODES.join(", ")}`, "text")
  .option(
    "--show-author",
    "Include author names in text output (Gap 20d — hidden by default to frame annotations as 'notes to future you')",
    false,
  )
  .option(
    "--share",
    "Emit a clean markdown 'why this changed' snippet to paste into a PR or handoff",
    false,
  )
  .action(async (file: string, opts: { line?: string; output?: string; showAuthor?: boolean; share?: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const output = OUTPUT_MODES.includes(opts.output as OutputMode)
      ? (opts.output as OutputMode)
      : "text";
    try {
      const result = await runExplain({
        repoRoot,
        filePath: file,
        line: opts.line ? parseInt(opts.line, 10) : undefined,
        output,
      });
      if (opts.share) {
        process.stdout.write(formatExplainShare(result) + "\n");
        process.exit(0);
      }
      process.stdout.write(formatExplainResult(result, output, { showAuthor: opts.showAuthor }) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("correct")
  .description(
    "Correct the source classification of all context entries for a file.\n" +
    "  Sets source to the specified value, confidence to 1.0, and locks the\n" +
    "  entry against automated reclassification (userOverride: true).",
  )
  .argument("<file>", "File path whose entries should be corrected")
  .option(
    "-s, --source <source>",
    "New source classification: human | ai | unknown",
    "human",
  )
  .option("--dry-run", "Show what would change without writing", false)
  .action(async (file: string, opts: { source: string; dryRun: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const validSources = ["human", "ai", "unknown"] as const;
    type ValidSource = (typeof validSources)[number];
    const source = validSources.includes(opts.source as ValidSource)
      ? (opts.source as ValidSource)
      : "human";
    try {
      const result = await runCorrect({
        repoRoot,
        filePath: file,
        source,
        dryRun: opts.dryRun,
      });
      process.stdout.write(formatCorrectResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("enrich")
  .description(
    "Improve the notes on auto-annotated context entries flagged for enrichment.\n" +
    "  --list          Show all enrichable entries.\n" +
    "  --id + --note   Update one entry's note manually.\n" +
    "  --auto          Auto-update entries that have an origin summary.\n" +
    "  --reasoning     Gap 122: extract AI reasoning (intent, logic, alternatives) for\n" +
    "                  entries with diffs. Requires KODELA_AI_API_KEY or provider key.\n" +
    "  (no flags)      Print a count and suggest the options above.",
  )
  .option("--list", "List all enrichable entries", false)
  .option("--id <uuid>", "Target a specific entry by ID (use with --note)")
  .option("--note <text>", "New note text for the entry specified by --id")
  .option("--auto", "Auto-update all enrichable entries that have an origin summary", false)
  .option("--reasoning", "Gap 122: extract AI reasoning for entries with diffs but no reasoning", false)
  .option("--dry-run", "Show what would change without writing", false)
  .action(async (opts: { list: boolean; id?: string; note?: string; auto: boolean; reasoning: boolean; dryRun: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runEnrich({
        repoRoot,
        list: opts.list,
        id: opts.id,
        note: opts.note,
        auto: opts.auto,
        reasoning: opts.reasoning,
        dryRun: opts.dryRun,
      });
      process.stdout.write(formatEnrichResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("heal")
  .description("Re-map context entries against current file state")
  .option("--dry-run", "Show what would change without writing", false)
  .option("--verbose", "Print per-component token and position scores for each updated entry", false)
  .option("--debug", "Alias for --verbose: print score breakdown details", false)
  .option("--no-embed", "Skip refreshing the semantic embedding index after healing")
  .option(
    "--re-anchor",
    "Recompute every persisted astAnchor (bodyHash + paramCount) using the tree-sitter " +
    "dispatcher and write a marker so the heal-engine uses tree-sitter by default after. " +
    "Idempotent; required once per repo before flipping KODELA_TREESITTER_AST_LAYER on by default.",
    false,
  )
  .action(async (opts: { dryRun: boolean; verbose: boolean; debug: boolean; embed: boolean; reAnchor: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      if (opts.reAnchor) {
        const result = await runHealReAnchor({ repoRoot, dryRun: opts.dryRun });
        process.stdout.write(formatReAnchorResult(result) + "\n");
        process.exit(0);
      }
      const config = await loadConfig(repoRoot);
      const result = await runHeal({ repoRoot, dryRun: opts.dryRun, config, embed: opts.embed });
      const verbose = opts.verbose || opts.debug;
      process.stdout.write(formatHealResult(result, verbose) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("archive")
  .description("Archive orphaned context entries older than --max-days")
  .option("--max-days <days>", "Minimum age in days for orphaned entries", "90")
  .option("--dry-run", "Show what would be archived without writing", false)
  .action(async (opts: { maxDays: string; dryRun: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runArchive({
        repoRoot,
        maxDays: parseInt(opts.maxDays, 10),
        dryRun: opts.dryRun,
      });
      process.stdout.write(formatArchiveResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("diff")
  .description(
    "Analyse a file's change density and AI-change signal against a git baseline.\n" +
    "  With no file and no --from/--to, analyses all working-tree changes vs HEAD.\n" +
    "  With --from/--to, shows context annotations for files changed between two commits.",
  )
  .argument("[file]", "File to analyse (content-level diff vs git baseline)")
  .option("--baseline <ref>", "Git ref to use as the file baseline", "HEAD")
  .option("--git <ref>", "Alias for --baseline (git ref for file baseline)")
  .option("--from <ref>", "Base git ref (commit-range mode)")
  .option("--to <ref>", "Target git ref (commit-range mode)")
  .option("--ci", "Exit 1 if AI-change signal is detected (file mode only)", false)
  .option("-o, --output <format>", `Output format: ${OUTPUT_MODES.join(", ")}`, "text")
  .action(async (
    file: string | undefined,
    opts: { baseline: string; git?: string; from?: string; to?: string; ci?: boolean; output?: string },
  ) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const output = OUTPUT_MODES.includes(opts.output as OutputMode)
      ? (opts.output as OutputMode)
      : "text";

    if (file) {
      const baseline = opts.git ?? opts.baseline;
      try {
        const result = await runFileAnalysis({
          repoRoot,
          filePath: file,
          baseline,
        });
        process.stdout.write(formatFileAnalysisResult(result, output) + "\n");
        if (opts.ci) {
          const ci = evaluateCiMode(result);
          if (!ci.pass) {
            process.stderr.write(ci.message! + "\n");
            process.exit(ci.exitCode);
          }
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    } else if (opts.from !== undefined || opts.to !== undefined) {
      if (opts.ci) {
        process.stderr.write("Warning: --ci has no effect without a <file> argument.\n");
      }
      try {
        const result = await runDiff({
          repoRoot,
          from: opts.from ?? "HEAD~1",
          to: opts.to ?? "HEAD",
        });
        process.stdout.write(formatDiffResult(result, output) + "\n");
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    } else {
      if (opts.ci) {
        process.stderr.write("Warning: --ci has no effect without a <file> argument.\n");
      }
      try {
        const result = await runWorkingTreeAnalysis({ repoRoot });
        process.stdout.write(formatWorkingTreeAnalysisResult(result, output) + "\n");
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    }
  });

program
  .command("blame")
  .description("Show git blame with context annotations overlaid")
  .argument("<file>", "File path")
  .action(async (file: string) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runBlame({ repoRoot, filePath: file });
      process.stdout.write(formatBlameResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("annotate")
  .description("Show file content with inline context annotations")
  .argument("<file>", "File path")
  .action(async (file: string) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runAnnotate({ repoRoot, filePath: file });
      process.stdout.write(formatAnnotateResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("detect")
  .description("Scan recent commits for likely AI-generated code")
  .option("--since <date>", "Only scan commits since this date (e.g. '2024-01-01')")
  .option("-o, --output <format>", "Output format: text, json", "text")
  .action(async (opts: { since?: string; output?: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const config = await loadConfig(repoRoot);
    const output = opts.output === "json" ? "json" : "text";
    try {
      const result = await detectAiCommits(repoRoot, config, opts.since);
      process.stdout.write(formatAiDetectionResult(result, output) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("run")
  .description(
    "Run a shell command, detect changed files, and optionally annotate AI-modified code",
  )
  .argument("<cmd...>", "Command to run (e.g. node scripts/codegen.js)")
  .option(
    "--auto-annotate",
    "Automatically create AI context entries for all changed files",
    false,
  )
  .option("-n, --note <text>", "Note to attach to auto-created annotations")
  .action(
    async (cmd: string[], opts: { autoAnnotate: boolean; note?: string }) => {
      const repoRoot = await findRepoRoot(process.cwd());
      const config = await loadConfig(repoRoot);
      try {
        const result = await runRun({
          repoRoot,
          command: cmd,
          config,
          autoAnnotate: opts.autoAnnotate,
          note: opts.note,
        });
        process.stdout.write(formatRunResult(result) + "\n");
        process.exit(result.exitCode);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    },
  );

// ─────────────────────────────────────────────────────────────────────────────
// `watch` command group:
//   kodela watch [opts]            — run in foreground (default)
//   kodela watch --detach          — daemonize (writes .kodela/watcher.pid)
//   kodela watch stop              — stop the daemon (SIGTERM → SIGKILL)
//   kodela watch status            — show daemon health
// ─────────────────────────────────────────────────────────────────────────────

const watchCmd = program
  .command("watch")
  .description(
    "Watch source files and automatically heal/annotate context on each change.\n" +
    "  Default: run in the foreground.  --detach starts a background daemon.\n" +
    "  Subcommands: `watch stop`, `watch status`.",
  )
  .option(
    "--debounce <ms>",
    "Debounce window in milliseconds before processing a batch",
    "500",
  )
  .option("--dry-run", "Heal without writing — show what would change", false)
  .option(
    "--auto-annotate",
    "Automatically create new ContextEntry stubs for every AI-written change " +
    "(zero-touch, works with any AI tool or agent). Uses a 6-layer attribution pipeline " +
    "to identify the responsible tool without user intervention.",
    false,
  )
  .option(
    "--stabilization <ms>",
    "Milliseconds to wait for a file to stop changing before annotating it " +
    "(prevents reading partial writes from streaming agents). Default: 200",
    "200",
  )
  .option(
    "--session-inactivity <ms>",
    "Open a new agent session after this many milliseconds of inactivity. Default: 60000",
    "60000",
  )
  .option(
    "--detach",
    "Run the watcher in the background (writes .kodela/watcher.pid). " +
    "Use `kodela watch stop` to stop and `kodela watch status` to inspect.",
    false,
  )
  .option(
    "--supervise",
    "Install a per-platform supervisor (launchd / systemd / schtasks) that " +
    "auto-restarts the watcher after a crash or reboot.  Implies --auto-annotate " +
    "by default.  See `kodela watch status` for supervisor health.",
    false,
  )
  .option(
    "--force",
    "When used with --detach or --supervise, overwrite any existing state.",
    false,
  )
  .option(
    "--verbose",
    "Print a diagnostic line for every file evaluated in auto-annotate mode " +
    "(skip reason, UBA signals, or annotation confirmation). " +
    "Without this flag only a per-batch summary line is written.",
    false,
  )
  .action(async (opts: {
    debounce: string;
    dryRun: boolean;
    autoAnnotate: boolean;
    stabilization: string;
    sessionInactivity: string;
    detach: boolean;
    supervise: boolean;
    force: boolean;
    verbose: boolean;
  }) => {
    const repoRoot = await findRepoRoot(process.cwd());

    // ── --supervise: install a per-platform service (launchd/systemd/schtasks)
    if (opts.supervise) {
      try {
        const childArgs: string[] = [];
        // Default to --auto-annotate so the supervised watcher is useful out-of-the-box.
        if (opts.autoAnnotate || !opts.dryRun) childArgs.push("--auto-annotate");
        if (opts.dryRun) childArgs.push("--dry-run");
        if (opts.debounce !== "500") childArgs.push("--debounce", opts.debounce);
        if (opts.stabilization !== "200") childArgs.push("--stabilization", opts.stabilization);
        if (opts.sessionInactivity !== "60000")
          childArgs.push("--session-inactivity", opts.sessionInactivity);

        const result = await installSupervisor({
          repoRoot,
          extraArgs: childArgs,
          force: opts.force,
          cliVersion: CLI_VERSION,
        });
        process.stdout.write(formatInstallSupervisorResult(result) + "\n");
        process.exit(result.installed || result.alreadyInstalled ? 0 : 1);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
      return;
    }

    // ── --detach: daemonize and exit ─────────────────────────────────────
    if (opts.detach) {
      try {
        // Forward the meaningful runtime flags to the daemonized child.
        const childArgs: string[] = [];
        if (opts.autoAnnotate) childArgs.push("--auto-annotate");
        if (opts.dryRun) childArgs.push("--dry-run");
        if (opts.verbose) childArgs.push("--verbose");
        if (opts.debounce !== "500") childArgs.push("--debounce", opts.debounce);
        if (opts.stabilization !== "200") childArgs.push("--stabilization", opts.stabilization);
        if (opts.sessionInactivity !== "60000")
          childArgs.push("--session-inactivity", opts.sessionInactivity);

        const result = await runWatchDetach({
          repoRoot,
          extraArgs: childArgs,
          force: opts.force,
          cliVersion: CLI_VERSION,
        });
        process.stdout.write(formatWatchDetachResult(result) + "\n");
        process.exit(result.alreadyRunning || result.started ? 0 : 1);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
      return;
    }

    // ── Foreground (default): run the watcher inline ─────────────────────
    const debounceMs = parseInt(opts.debounce, 10);
    const stabilizationMs = parseInt(opts.stabilization, 10);
    const sessionInactivityMs = parseInt(opts.sessionInactivity, 10);

    let watcher: Awaited<ReturnType<typeof runWatch>> | undefined;
    const shutdown = () => {
      if (watcher) {
        watcher.stop();
      }
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    try {
      const foundPath = await findConfigFile(repoRoot);
      let config = DEFAULT_CONFIG;
      let configPath: string | null = null;
      if (foundPath !== null) {
        try {
          config = await loadConfig(repoRoot);
          configPath = foundPath;
        } catch (err) {
          if (!(err instanceof ConfigLoadError)) throw err;
          process.stderr.write(`Warning: ${err.message} — using built-in defaults\n`);
        }
      }
      watcher = await runWatch({
        repoRoot,
        debounceMs: Number.isFinite(debounceMs) ? debounceMs : 500,
        dryRun: opts.dryRun,
        autoAnnotate: opts.autoAnnotate,
        stabilizationMs: Number.isFinite(stabilizationMs) ? stabilizationMs : 200,
        sessionInactivityMs: Number.isFinite(sessionInactivityMs) ? sessionInactivityMs : 60_000,
        verbose: opts.verbose,
        config,
        configPath,
      });
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

watchCmd
  .command("stop")
  .description(
    "Stop the daemonized watcher started with `kodela watch --detach` or `kodela watch --supervise`.\n" +
    "  When a supervisor is installed, it is deactivated first so it doesn't immediately restart the watcher.",
  )
  .option(
    "--remove-supervisor",
    "Also delete the per-platform supervisor unit file (full uninstall).  " +
      "Without this flag the unit is only deactivated and can be re-enabled with `kodela watch --supervise`.",
    false,
  )
  .action(async (opts: { removeSupervisor: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runWatchStop(repoRoot, {
        removeSupervisor: opts.removeSupervisor,
      });
      process.stdout.write(formatWatchStopResult(result) + "\n");
      process.exit(result.stopped ? 0 : 1);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

watchCmd
  .command("status")
  .description(
    "Show the health of the watcher (running / stopped / degraded) and any installed supervisor.",
  )
  .action(async () => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const [status, supStatus] = await Promise.all([
        runWatchStatus(repoRoot),
        supervisorStatus({ repoRoot }),
      ]);
      process.stdout.write(formatWatchStatus(status) + "\n");
      process.stdout.write(formatSupervisorStatus(supStatus) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

watchCmd
  .command("unsupervise")
  .description(
    "Remove the per-platform supervisor unit file (launchd / systemd / schtasks).  " +
    "Does NOT stop a currently-running watcher process — use `kodela watch stop` for that.",
  )
  .action(async () => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await removeSupervisor({ repoRoot });
      process.stdout.write(formatRemoveSupervisorResult(result) + "\n");
      process.exit(result.removed || result.alreadyRemoved ? 0 : 1);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("retroactive")
  .description(
    "Scan git history for likely AI-generated commits and write annotation stubs.\n" +
    "  Stubs are always written locally. Remote sync requires an Enterprise license.\n" +
    "  Alias: `kodela annotate-history` (more discoverable name for the same command).",
  )
  .option("--since <date>", "Only scan commits since this date (e.g. '2024-01-01')")
  .option("--limit <n>", "Max number of flagged commits to process (default 50)", "50")
  .option(
    "--max-files-per-commit <n>",
    "Max files to annotate per flagged commit (default 5). Prevents hundreds of stubs on large AI-heavy repos.",
    "5",
  )
  .option("--dry-run", "Show what would be created without writing stubs", false)
  .option("--force", "Overwrite stubs even for files already annotated", false)
  .option(
    "--yes",
    "Skip the confirmation prompt when more than 20 stubs would be created",
    false,
  )
  .option("-o, --output <format>", "Output format: text, json", "text")
  .action(
    async (opts: {
      since?: string;
      limit: string;
      maxFilesPerCommit: string;
      dryRun: boolean;
      force: boolean;
      yes: boolean;
      output: string;
    }) => {
      const repoRoot = await findRepoRoot(process.cwd());
      const config = await loadConfig(repoRoot);
      try {
        const result = await runRetroactive({
          repoRoot,
          since: opts.since,
          limit: parseInt(opts.limit, 10),
          maxFilesPerCommit: parseInt(opts.maxFilesPerCommit, 10),
          dryRun: opts.dryRun,
          force: opts.force,
          yes: opts.yes,
          config,
        });
        if (opts.output === "json") {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          process.stdout.write(formatRetroactiveResult(result) + "\n");
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    },
  );

// Gap 80 — `annotate-history` is the discoverable alias for `retroactive`.
// Presented to developers during `kodela init` and in the --help output.
// Both commands call the same `runRetroactive` implementation.
program
  .command("annotate-history")
  .description(
    "Scan git history for AI-attributed commits and create context entries retroactively.\n" +
    "  Use this after installing Kodela on an existing repository to populate the index\n" +
    "  for code that was written before Kodela was set up. Runs on all license tiers.\n" +
    "  Each created stub is also enqueued for AI intent inference (see Gap 79).",
  )
  .option("--since <date>", "Only scan commits since this date (e.g. '2024-01-01')")
  .option("--limit <n>", "Max number of flagged commits to process (default 50)", "50")
  .option(
    "--max-files-per-commit <n>",
    "Max files to annotate per flagged commit (default 5).",
    "5",
  )
  .option("--dry-run", "Show what would be created without writing stubs", false)
  .option("--force", "Overwrite stubs even for files already annotated", false)
  .option(
    "--yes",
    "Skip the confirmation prompt when more than 20 stubs would be created",
    false,
  )
  .option("-o, --output <format>", "Output format: text, json", "text")
  .action(
    async (opts: {
      since?: string;
      limit: string;
      maxFilesPerCommit: string;
      dryRun: boolean;
      force: boolean;
      yes: boolean;
      output: string;
    }) => {
      const repoRoot = await findRepoRoot(process.cwd());
      const config = await loadConfig(repoRoot);
      try {
        const result = await runRetroactive({
          repoRoot,
          since: opts.since,
          limit: parseInt(opts.limit, 10),
          maxFilesPerCommit: parseInt(opts.maxFilesPerCommit, 10),
          dryRun: opts.dryRun,
          force: opts.force,
          yes: opts.yes,
          config,
        });
        if (opts.output === "json") {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          process.stdout.write(formatRetroactiveResult(result) + "\n");
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    },
  );

program
  .command("connect")
  .description(
    "One command to enable Kodela in every installed AI tool. Detects Claude Code, " +
    "Cursor, VS Code, Windsurf, Antigravity/Gemini, … and merges the Kodela MCP server " +
    "into each (preserving existing servers), plus the tool-agnostic watcher. " +
    "Dry-run by default — pass --apply to write.",
  )
  .option("--apply", "Actually write the configs + start the watcher (default is a dry-run)", false)
  .option("--all", "Include tools not detected on this machine (write their config anyway)", false)
  .option("--npx", "Write a portable `npx -y @kodela/cli mcp serve` entry (needs the npm package) instead of a local path", false)
  .option("--no-watch", "Do not start the silent-capture watcher")
  .action(async (opts: { apply: boolean; all: boolean; watch: boolean; npx: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const kodelaHome =
      process.env["KODELA_HOME"] ??
      resolveKodelaHome(path.dirname(process.argv[1] ?? process.cwd())) ??
      resolveKodelaHome(process.cwd()) ??
      // With --npx the entry is package-based, so a local checkout isn't required.
      (opts.npx ? repoRoot : null);
    if (!kodelaHome) {
      process.stderr.write(
        "Error: could not locate the Kodela install.\n\n" +
        "  If you installed @kodela/cli from npm, use --npx:\n" +
        "    kodela connect --npx          (dry-run)\n" +
        "    kodela connect --apply --npx  (write configs)\n\n" +
        "  If you're running from a local checkout, set KODELA_HOME to the repo path.\n",
      );
      process.exit(1);
    }
    try {
      const result = await runConnect({
        repoRoot,
        kodelaHome,
        apply: opts.apply,
        watch: opts.watch,
        all: opts.all,
        npx: opts.npx,
        cliVersion: CLI_VERSION,
      });
      process.stdout.write(formatConnectResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

// NOTE: `embed` and `search` are top-level commands. They must each start a
// fresh `program.command(...)` statement — chaining them onto a previous
// command's `.action()` would (silently) register them as SUBcommands.
program
  .command("embed")
  .description(
    "Generate semantic embeddings for all annotations (.kodela/embeddings.jsonl). Default engine is `auto` (local ONNX when available, else the offline hash embedder). Override with --provider or set KODELA_EMBEDDING_PROVIDER.",
  )
  .option("--ai", "Shortcut for --provider openai (uses the configured AI provider key)")
  .option(
    "--provider <engine>",
    "Embedding engine: auto | local-onnx | local-hash | openai (overrides KODELA_EMBEDDING_PROVIDER)",
  )
  .option("--download-model", "Pre-fetch + cache the local ONNX model, then exit (useful for air-gapped setups)")
  .option("-o, --output <format>", "Output format: text, json", "text")
  .action(async (opts: { ai?: boolean; provider?: string; downloadModel?: boolean; output: string }) => {
    // --download-model is a standalone action: fetch the model and exit.
    if (opts.downloadModel) {
      const r = await prefetchEmbeddingModel();
      if (opts.output === "json") process.stdout.write(JSON.stringify(r) + "\n");
      else process.stdout.write(`${r.ok ? "✓" : "✗"} ${r.note}\n`);
      process.exit(r.ok ? 0 : 1);
    }

    const repoRoot = await findRepoRoot(process.cwd());
    const config = await loadConfigSafe(repoRoot, process.stderr);

    // --ai is sugar for --provider openai. An explicit --provider wins.
    const selector = (opts.provider ?? (opts.ai ? "openai" : undefined)) as
      | "auto" | "local-onnx" | "local-hash" | "openai" | undefined;
    const wantsOpenAi = selector === "openai";
    const embeddingConfig = wantsOpenAi
      ? {
          apiKey: config.ai_provider?.api_key ?? process.env["KODELA_AI_API_KEY"],
          baseUrl: config.ai_provider?.base_url,
          model: config.ai_provider?.model,
        }
      : undefined;
    try {
      const res = await runEmbed({ repoRoot, embeddingConfig, selector: wantsOpenAi ? undefined : selector });
      if (opts.output === "json") {
        process.stdout.write(JSON.stringify(res) + "\n");
      } else {
        process.stdout.write(
          `Embedded ${res.embedded}/${res.total} annotations ` +
            `(${res.skipped} unchanged) → .kodela/embeddings.jsonl\n${res.note}\n`,
        );
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("search")
  .description("Search context annotations across .kodela/ by keyword, tag, file, or source.")
  .argument("<query>", "Search query (space-separated keywords)")
  .option("--file <path>", "Restrict results to annotations on this file path")
  .option(
    "--source <source>",
    "Filter by source: human, ai, import",
  )
  .option(
    "--status <status>",
    "Filter by status: mapped, uncertain, orphaned",
  )
  .option(
    "--tags <tags>",
    "Comma-separated tags; only return entries that have ALL listed tags",
  )
  .option("--limit <n>", "Max results to show (default 50)", "50")
  .option("-o, --output <format>", "Output format: text, json", "text")
  .option(
    "--semantic",
    "Gap 47 — Use natural-language semantic search (cosine similarity over embeddings) instead of keyword matching. Falls back to keyword search when no embeddings are stored or no API key is configured.",
  )
  .option(
    "--no-rerank",
    "Phase 0 — Skip the offline relevance reranker and show the raw keyword/cosine order. The reranker is on by default (offline, no key).",
  )
  .action(
    async (
      query: string,
      opts: {
        file?: string;
        source?: string;
        status?: string;
        tags?: string;
        limit: string;
        output: string;
        semantic?: boolean;
        rerank?: boolean;
      },
    ) => {
      const repoRoot = await findRepoRoot(process.cwd());
      const output = opts.output === "json" ? "json" : "text";
      const filterTags = opts.tags
        ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean)
        : undefined;

      const config = await loadConfigSafe(repoRoot, process.stderr);
      const embeddingConfig = opts.semantic
        ? {
            apiKey:
              config.ai_provider?.api_key ?? process.env["KODELA_AI_API_KEY"],
            baseUrl: config.ai_provider?.base_url,
            model: config.ai_provider?.model,
          }
        : undefined;

      try {
        const result = await runSearch({
          repoRoot,
          query,
          output,
          filterFile: opts.file,
          filterSource: opts.source as any,
          filterStatus: opts.status as any,
          filterTags,
          limit: parseInt(opts.limit, 10),
          semantic: opts.semantic ?? false,
          embeddingConfig,
          rerank: opts.rerank ?? true,
        });
        process.stdout.write(formatSearchResult(result, output) + "\n");
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    },
  );

// Phase 1 — standing directives (auto-loaded into the Memory Bank).
const directiveCmd = program
  .command("directive")
  .description("Manage standing directives — instructions every AI session should honour.");
directiveCmd
  .command("add <text>")
  .description("Add a standing directive, e.g. \"Always sign commits with GPG\".")
  .option("--scope <scope>", "Where it applies: global (default) or a repo-relative path/glob")
  .action(async (text: string, opts: { scope?: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const d = await runDirectiveAdd(repoRoot, text, opts.scope ? { scope: opts.scope } : {});
    process.stdout.write(`Added directive ${d.id}: ${d.text}\n`);
    process.exit(0);
  });
directiveCmd
  .command("list")
  .description("List standing directives.")
  .action(async () => {
    const repoRoot = await findRepoRoot(process.cwd());
    process.stdout.write(formatDirectiveList(await runDirectiveList(repoRoot)) + "\n");
    process.exit(0);
  });
directiveCmd
  .command("rm <id>")
  .description("Remove a standing directive by id.")
  .action(async (id: string) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const removed = await runDirectiveRemove(repoRoot, id);
    process.stdout.write(removed ? `Removed directive ${id}.\n` : `No directive with id ${id}.\n`);
    process.exit(removed ? 0 : 1);
  });

// Phase 1 — automatic recall injection.
// `kodela recall "<topic>"` returns the most relevant prior *why* as a
// ready-to-paste markdown block, ranked by the Phase-0 reranker. With no query
// it auto-recalls for the current task using the latest session goal, so a hook
// or agent can inject relevant memory at the start of a session.
program
  .command("recall")
  .description(
    "Recall the most relevant prior context as an injectable markdown block.\n" +
    "  With a query: `kodela recall \"token rotation\"`.\n" +
    "  With no query: auto-recalls for the current task from the latest session goal.\n" +
    "  Ranked by the offline Phase-0 reranker; safe to paste into any AI session.",
  )
  .argument("[query...]", "What to recall (space-separated). Omit to auto-recall for the current task.")
  .option("--limit <n>", "Max items to recall (default 8)", "8")
  .option("--no-semantic", "Use keyword retrieval instead of semantic (embedding) retrieval")
  .option("-o, --output <format>", "Output format: text (markdown block) or json", "text")
  .option("--read-mode <mode>", "Shared-memory read: local | remote | merge (default: storage.readMode or local)")
  .option("--server <url>", "Server URL for remote/merge recall")
  .option("--api-key <key>", "API key for remote/merge recall")
  .option("--org-id <id>", "Organization id (overrides KODELA_ORG_ID / license)")
  .option("--repo <owner/name>", "Repo full name for shared-memory scope (default: auto from git remote)")
  .option("--repo-id <id>", "Raw repo_links id (overrides KODELA_REPO_ID / --repo)")
  .action(async (query: string[], opts: {
    limit: string; semantic: boolean; output: string;
    readMode?: string; server?: string; apiKey?: string; orgId?: string; repo?: string; repoId?: string;
  }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const joined = query.join(" ").trim();
    const limit = parseInt(opts.limit, 10);
    const warn = (m: string) => process.stderr.write(`Warning: ${m}\n`);
    try {
      // Shared-memory recall (storage.readMode). Remote recall needs an explicit
      // query — auto-recall-from-session-goal is a local-only notion — so with no
      // query we always read local.
      const remote = joined
        ? await resolveContextRemote(repoRoot, opts)
        : { readMode: "local" as const, config: undefined };

      let block: string;
      let items: unknown;
      if (remote.readMode === "remote" && remote.config) {
        try {
          const r = await fetchRemoteRecall({ ...remote.config, query: joined, limit });
          block = r.block; items = r.items;
        } catch (err) {
          warn(`Remote recall failed (${err instanceof Error ? err.message : String(err)}); using local.`);
          const local = await runRecall({ repoRoot, query: joined, limit, semantic: opts.semantic });
          block = local.block; items = local.items;
        }
      } else if (remote.readMode === "merge" && remote.config) {
        const local = await runRecall({ repoRoot, query: joined, limit, semantic: opts.semantic });
        try {
          const r = await fetchRemoteRecall({ ...remote.config, query: joined, limit });
          const m = mergeRecallItems(joined, local.items, r.items, limit);
          block = m.block; items = m.items;
        } catch (err) {
          warn(`Remote recall failed (${err instanceof Error ? err.message : String(err)}); using local only.`);
          block = local.block; items = local.items;
        }
      } else {
        const local = await runRecall({ repoRoot, query: joined || undefined, limit, semantic: opts.semantic });
        block = local.block; items = local.items;
      }

      if (opts.output === "json") {
        process.stdout.write(JSON.stringify({ query: joined, items, block }, null, 2) + "\n");
      } else {
        process.stdout.write(block + "\n");
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

// Phase 2 — comprehension graph (P2.1). Builds a file→class→function graph with
// plain-English descriptions, each node fused with the captured why.
program
  .command("comprehend")
  .description(
    "Build a comprehension graph — files, classes and functions with plain-English\n" +
    "  descriptions, each fused with the captured *why* that overlaps it. Offline\n" +
    "  (no API key). Use --file to scope to a path, --documented for only nodes\n" +
    "  with captured context.",
  )
  .option("--file <path>", "Restrict to files whose path includes this substring")
  .option("--max-files <n>", "Max source files to parse (default 400)", "400")
  .option("--documented", "Only show nodes that carry captured why/decisions", false)
  .option("-o, --output <format>", "Output format: text, json", "text")
  .action(async (opts: { file?: string; maxFiles: string; documented: boolean; output: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const output = opts.output === "json" ? "json" : "text";
    try {
      const result = await runComprehend({
        repoRoot,
        filter: opts.file,
        maxFiles: parseInt(opts.maxFiles, 10),
        documentedOnly: opts.documented,
      });
      process.stdout.write(formatComprehendResult(result, output) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

// Phase 3 — architecture map (P3.1). Auto-derived technical layers + business
// domains + the cross-layer dependency matrix, fused with captured risk.
program
  .command("architecture")
  .alias("arch")
  .description(
    "Map the codebase into technical layers (API, UI, data, auth, core, …) and\n" +
    "  business domains, with the captured risk per layer and the cross-layer\n" +
    "  dependency matrix. Refine the heuristics with .kodela/architecture.json\n" +
    "  ({ rules?, domains? }).",
  )
  .option("-o, --output <format>", "Output format: text, json", "text")
  .action(async (opts: { output: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const output = opts.output === "json" ? "json" : "text";
    try {
      const result = await runArchitecture({ repoRoot });
      process.stdout.write(formatArchitectureResult(result, output) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

// Phase 2 — diff impact (P2.3). Structural blast-radius fused with the
// decision/risk blast-radius; --ci gates a commit that touches load-bearing code.
program
  .command("impact")
  .description(
    "Show the blast radius of a change — the files that (transitively) import what\n" +
    "  you changed, fused with the captured why/decisions/risk across that radius.\n" +
    "  With no file args it uses `git diff` vs --base. --ci fails when the radius\n" +
    "  touches high/critical-risk code (read the why before you touch it).",
  )
  .argument("[files...]", "Changed files to analyse (default: git diff vs --base)")
  .option("--base <ref>", "Git ref to diff against when no files are given", "HEAD")
  .option("--max-depth <n>", "Dependency hops to follow (default 2)", "2")
  .option("--ci", "Exit non-zero when the blast radius reaches --fail-on risk or worse", false)
  .option("--fail-on <level>", "Risk level that fails --ci: low | medium | high | critical", "high")
  .option("-o, --output <format>", "Output format: text, json", "text")
  .action(async (files: string[], opts: { base: string; maxDepth: string; ci: boolean; failOn: string; output: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const output = opts.output === "json" ? "json" : "text";
    try {
      const result = await runImpact({
        repoRoot,
        files: files.length > 0 ? files : undefined,
        base: opts.base,
        maxDepth: parseInt(opts.maxDepth, 10),
      });
      process.stdout.write(formatImpactResult(result, output) + "\n");
      if (opts.ci) {
        const order = ["none", "low", "medium", "high", "critical"];
        const floor = Math.max(0, order.indexOf(opts.failOn));
        if (order.indexOf(result.report.highestRisk) >= floor && floor > 0) {
          process.stderr.write(
            `Blast radius reaches ${result.report.highestRisk}-risk code (>= ${opts.failOn}). Read the captured why before committing.\n`,
          );
          process.exit(1);
        }
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

// Phase 2 — guided tours (P2.2). A dependency-ordered onboarding walkthrough
// that weaves in the captured decisions/risk on each module.
program
  .command("tour")
  .description(
    "Generate a guided onboarding tour — foundational modules first, each stop\n" +
    "  weaving in the captured *why* (decisions/risk) behind it. Markdown by default\n" +
    "  (paste into an onboarding doc). --documented tours only the modules with\n" +
    "  captured context; --file scopes to a path.",
  )
  .option("--file <path>", "Restrict the tour to files whose path includes this substring")
  .option("--max-stops <n>", "Max tour stops (default 12)", "12")
  .option("--documented", "Only include modules that carry captured why/decisions", false)
  .option("--name <name>", "Project name to show in the tour heading")
  .option("--language <lang>", "Language for the generated scaffolding: en, es, fr, de, pt", "en")
  .option("-o, --output <format>", "Output format: text (markdown) or json", "text")
  .action(async (opts: { file?: string; maxStops: string; documented: boolean; name?: string; language: string; output: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const output = opts.output === "json" ? "json" : "text";
    try {
      const result = await runTour({
        repoRoot,
        filter: opts.file,
        maxStops: parseInt(opts.maxStops, 10),
        documentedOnly: opts.documented,
        projectName: opts.name,
        language: opts.language,
      });
      process.stdout.write(formatTourResult(result, output) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

// Phase 1 — memory hygiene (P1.3). Surfaces memory that has gone bad and, in
// --ci mode, fails the build when the health score drops below a threshold.
program
  .command("hygiene")
  .description(
    "Scan captured memory for hygiene issues and print a ranked health report.\n" +
    "  Flags orphaned/drifted mappings, review backlog, low-confidence and stale\n" +
    "  entries, and overlapping (contradiction-candidate) annotations. Never mutates\n" +
    "  memory — it tells you what to reconcile. Use --ci --min-score to gate a build.",
  )
  .option("--stale-days <n>", "Entries untouched for more than N days are stale (default 180)", "180")
  .option("--min-confidence <n>", "Confidence below this is flagged low-confidence (default 0.5)", "0.5")
  .option("--min-severity <level>", "Only show issues of this severity or worse: low | medium | high")
  .option("--limit <n>", "Max issues to print (default 50)", "50")
  .option("--ci", "Exit non-zero when the health score is below --min-score", false)
  .option("--min-score <n>", "Minimum acceptable health score in --ci mode (default 80)", "80")
  .option("-o, --output <format>", "Output format: text, json", "text")
  .action(async (opts: {
    staleDays: string;
    minConfidence: string;
    minSeverity?: string;
    limit: string;
    ci: boolean;
    minScore: string;
    output: string;
  }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const output = opts.output === "json" ? "json" : "text";
    const validSeverities = ["low", "medium", "high"] as const;
    const minSeverity = validSeverities.includes(opts.minSeverity as HygieneSeverity)
      ? (opts.minSeverity as HygieneSeverity)
      : undefined;
    try {
      const result = await runHygiene({
        repoRoot,
        staleDays: parseInt(opts.staleDays, 10),
        minConfidence: parseFloat(opts.minConfidence),
        minSeverity,
        limit: parseInt(opts.limit, 10),
      });
      process.stdout.write(formatHygieneResult(result, output) + "\n");
      if (opts.ci) {
        const minScore = parseInt(opts.minScore, 10);
        if (result.report.healthScore < minScore) {
          process.stderr.write(
            `Memory health ${result.report.healthScore} is below the required ${minScore}.\n`,
          );
          process.exit(1);
        }
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

// Contradiction / decision-violation detection. Flags a described change (or,
// with no argument, scans proposed decisions) that reverses an active decision.
program
  .command("check")
  .description(
    "Flag a change (or a proposed decision) that contradicts an active decision.\n" +
    "  kodela check \"reintroduce mongodb for caching\"   check a described change\n" +
    "  kodela check                                        scan proposed decisions\n" +
    "  High-precision, offline. Use --ci to fail a build when a violation is found.",
  )
  .argument("[change...]", "Description of the change to check. Omit to scan proposed decisions.")
  .option("--min-confidence <n>", "Only report flags at or above this confidence (0-1, default 0)", "0")
  .option("--semantic", "Recall dial: add an on-device embedding topic-match (catches reversals phrased unlike the lexicon; offline).", false)
  .option("--ci", "Exit non-zero when any contradiction is found", false)
  .option("-o, --output <format>", "Output format: text, json", "text")
  .action(async (change: string[], opts: { minConfidence: string; semantic: boolean; ci: boolean; output: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const output = opts.output === "json" ? "json" : "text";
    try {
      const result = await runCheck({
        repoRoot,
        change: change.length > 0 ? change.join(" ") : undefined,
        minConfidence: parseFloat(opts.minConfidence),
        semantic: opts.semantic,
      });
      if (output === "json") {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        process.stdout.write(formatCheckResult(result) + "\n");
      }
      if (opts.ci && result.violationCount > 0) {
        process.stderr.write(
          `${result.violationCount} decision violation(s) found — failing the build.\n`,
        );
        process.exit(1);
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

// Governance scorecard — decisions honored vs violated, AI-intent coverage, and
// the composite governance score for engineering leaders (the moat metrics).
program
  .command("governance")
  .description(
    "Show the governance scorecard: decision breakdown, proposed conflicts,\n" +
    "  AI-authored change attribution, and % of AI changes with captured intent.\n" +
    "  Use --ci --min-score to gate a build on the governance score.",
  )
  .option("--ci", "Exit non-zero when the governance score is below --min-score", false)
  .option("--min-score <n>", "Minimum acceptable governance score in --ci mode (default 80)", "80")
  .option("-o, --output <format>", "Output format: text, json", "text")
  .action(async (opts: { ci: boolean; minScore: string; output: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runGovernance({ repoRoot });
      if (opts.output === "json") {
        process.stdout.write(JSON.stringify(result.scorecard, null, 2) + "\n");
      } else {
        process.stdout.write(formatGovernance(result) + "\n");
      }
      if (opts.ci) {
        const minScore = parseInt(opts.minScore, 10);
        if (result.scorecard.governanceScore < minScore) {
          process.stderr.write(
            `Governance score ${result.scorecard.governanceScore} is below the required ${minScore}.\n`,
          );
          process.exit(1);
        }
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command("export")
  .description(
    "Export context annotations for AI consumption in plain-text or JSON format.",
  )
  .argument("[file]", "File or directory to export (relative to repo root). Omit to use current directory.")
  .option("--repo", "Export context for the entire repository", false)
  .option("--max-tokens <n>", "Cap output at N tokens, prioritising high-risk and recent entries")
  .option("-o, --output <format>", "Output format: text, json", "text")
  .option(
    "--ai",
    "Pass the export output through the configured AI provider for summarisation. " +
      "Requires KODELA_AI_API_KEY (or ai_provider.api_key in kodela.config.json). " +
      "Provider defaults to openai; set KODELA_AI_PROVIDER=anthropic to switch.",
    false,
  )
  .action(
    async (
      file: string | undefined,
      opts: { repo: boolean; maxTokens?: string; output: string; ai: boolean },
    ) => {
      const repoRoot = await findRepoRoot(process.cwd());
      const output = opts.output === "json" ? "json" : "text";
      const maxTokens = opts.maxTokens ? parseInt(opts.maxTokens, 10) : undefined;
      try {
        const result = await runExport({
          repoRoot,
          target: file,
          repo: opts.repo,
          maxTokens,
          output,
        });

        let text = formatExportResult(result, output);

        if (opts.ai) {
          const config = await loadConfig(repoRoot).catch(() => DEFAULT_CONFIG);
          const aiProviderCfg = config.ai_provider ?? {};
          text = await runAiLayer(text, {
            config: {
              provider: aiProviderCfg.provider,
              model: aiProviderCfg.model,
              apiKey: aiProviderCfg.api_key,
              baseUrl: aiProviderCfg.base_url,
            },
            maxTokens,
          });
        }

        process.stdout.write(text + "\n");
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    },
  );

program
  .command("memory-bank")
  .description(
    "Auto-generate the agent Memory Bank — a memory-bank/ folder of six markdown files\n" +
      "    (projectbrief, productContext, activeContext, systemPatterns, techContext, progress)\n" +
      "    that AI agents (Cline, Roo, Cursor, Claude Code, …) read at the start of every task.\n" +
      "    Built from Kodela's captured context + project DNA. Human edits outside the managed\n" +
      "    markers are preserved. Use --check in CI to fail when the files are stale.",
  )
  .option("--dir <path>", "Output directory for the memory bank", "memory-bank")
  .option("--check", "Don't write — exit 1 if the memory bank is out of date", false)
  .option("-o, --output <format>", "Output format: text, json", "text")
  .action(
    async (opts: { dir: string; check: boolean; output: string }) => {
      const repoRoot = await findRepoRoot(process.cwd());
      const output = opts.output === "json" ? "json" : "text";
      try {
        const result = await runMemoryBank({
          repoRoot,
          dir: opts.dir,
          check: opts.check,
          output,
        });
        process.stdout.write(formatMemoryBankResult(result, output) + "\n");
        process.exit(opts.check && result.outdated ? 1 : 0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    },
  );

program
  .command("pack")
  .description(
    "Pack the repository + its captured *why* into one AI-ready markdown file.\n" +
      "    Project DNA + a repo map + the reasoning behind changes — paste into any LLM.\n" +
      "    Works on a cold repo. Default output: kodela-pack.md.",
  )
  .option("--out <file>", "Output file path", "kodela-pack.md")
  .option("--stdout", "Print to stdout instead of writing a file", false)
  .option("-o, --output <format>", "Result format when writing a file: text, json", "text")
  .action(async (opts: { out: string; stdout: boolean; output: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const output = opts.output === "json" ? "json" : "text";
    try {
      const result = await runPack({ repoRoot, out: opts.out, stdout: opts.stdout });
      if (opts.stdout) {
        process.stdout.write(result.content);
      } else {
        process.stdout.write(formatPackResult(result, output) + "\n");
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("view")
  .description(
    "Generate a local, read-only HTML viewer of the captured memory.\n" +
      "    Project DNA + capture stats + a filterable timeline of the *why* — no\n" +
      "    account, no server, offline. Default output: .kodela/view.html.",
  )
  .option("--out <file>", "Output file path", ".kodela/view.html")
  .option("--serve", "Serve the viewer read-only on localhost instead of just writing it", false)
  .option("--port <number>", "Port for --serve", String(DEFAULT_VIEW_PORT))
  .option("-o, --output <format>", "Result format: text, json", "text")
  .action(async (opts: { out: string; serve: boolean; port: string; output: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const output = opts.output === "json" ? "json" : "text";
    try {
      const result = await runView({ repoRoot, out: opts.out });
      if (opts.serve) {
        const port = Number.parseInt(opts.port, 10) || DEFAULT_VIEW_PORT;
        serveView(repoRoot, port);
        process.stdout.write(
          `Kodela memory — live read-only viewer at http://localhost:${port}  (auto-refreshes; Ctrl-C to stop)\n`,
        );
        // keep the process alive while serving
      } else {
        process.stdout.write(formatViewResult(result, output) + "\n");
        process.exit(0);
      }
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("ui")
  .description(
    "Open the interactive, read-only local web app for the captured memory.\n" +
      "    Tabs: Files (search the *why*, filter by severity, drill into any file,\n" +
      "    Copy why for PR), Graph (co-change memory graph), Decisions (human-authored\n" +
      "    decisions), Timeline, and Memory health. A built-in Help tab explains each\n" +
      "    view. Single-user, local-only, no account — nothing leaves your machine.",
  )
  .option("--port <number>", "Port to serve on", String(DEFAULT_UI_PORT))
  .option("--host <host>", "Interface to bind (default 127.0.0.1; use 0.0.0.0 to host the read-only demo)", "127.0.0.1")
  .option("--no-open", "Do not auto-open the browser")
  .action(async (opts: { port: string; host: string; open: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const port = Number.parseInt(opts.port, 10) || DEFAULT_UI_PORT;
      const { url } = await runUi({ repoRoot, port, host: opts.host, open: opts.open });
      process.stdout.write(
        `Kodela memory — interactive viewer at ${url}  (read-only, local; Ctrl-C to stop)\n`,
      );
      // keep the process alive while serving
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("metrics")
  .description(
    "Show whether your agent is getting smarter every session.\n" +
      "    Local retention metrics from the captured graph: memory size, captures\n" +
      "    per session and its trend, and how often sessions reuse prior context.",
  )
  .option("-o, --output <format>", "Result format: text, json", "text")
  .action(async (opts: { output: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const output = opts.output === "json" ? "json" : "text";
    try {
      const result = await runMetrics({ repoRoot, output });
      process.stdout.write(formatMetricsResult(result, output) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("capture-tier")
  .argument("[tier]", "enforced | assisted | ambient (omit to show the current tier)")
  .description(
    "Read or set how strictly Kodela enforces per-file context before a session\n" +
      "    can close. 'enforced' (default) blocks close until every touched file is\n" +
      "    explained; 'assisted' closes and queues missing files for async synthesis;\n" +
      "    'ambient' closes immediately and fills them in the background.",
  )
  .option("-o, --output <format>", "Result format: text, json", "text")
  .action(async (tier: string | undefined, opts: { output: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const output = opts.output === "json" ? "json" : "text";
    try {
      const result = await runCaptureTier({ repoRoot, tier });
      process.stdout.write(formatCaptureTierResult(result, output) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("install-hooks")
  .description(
    "Install Kodela git hooks (pre-commit and post-commit) into .git/hooks/\n" +
    "  Use --claude to also install Claude Code hooks into .claude/settings.json (Gap 52).",
  )
  .option("-f, --force", "Overwrite hooks that already exist", false)
  .option("--claude", "Also install Claude Code hooks into .claude/settings.json", false)
  .option("--sync", "Also install a post-merge hook that runs `kodela sync` (central mode)", false)
  .action(async (opts: { force: boolean; claude: boolean; sync: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runInstallHooks({ repoRoot, force: opts.force, claude: opts.claude, sync: opts.sync });
      process.stdout.write(formatInstallHooksResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("detect-ai-change")
  .description(
    "Gap 58: Detect likely AI-generated changes in a diff and check for Kodela annotation coverage.\n" +
    "  Reads staged changes (--staged), a patch file (--diff), or the working-tree diff against HEAD.\n" +
    "  Exits 0 by default. Use --exit-code to exit 1 when uncovered AI changes are found (for CI/hooks).",
  )
  .option("--staged", "Analyse git diff --cached (staged changes)", false)
  .option("--diff <file>", "Path to a unified diff patch file to analyse")
  .option(
    "--exit-code",
    "Exit 1 when likely-AI changes with no annotation are found (useful in git hooks / CI)",
    false,
  )
  .option("--json", "Output results as JSON", false)
  .option(
    "--uba-threshold <score>",
    "Minimum UBA score (0–1) to classify a change as likely AI-generated (default: 0.6)",
    "0.6",
  )
  .action(async (opts: {
    staged: boolean;
    diff?: string;
    exitCode: boolean;
    json: boolean;
    ubaThreshold: string;
  }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const ubaThreshold = parseFloat(opts.ubaThreshold);

    try {
      const result = await runDetectAiChange(
        {
          repoRoot,
          staged: opts.staged,
          diffFile: opts.diff,
          exitCode: opts.exitCode,
          json: opts.json,
        },
        isNaN(ubaThreshold) ? 0.6 : ubaThreshold,
      );

      if (opts.json) {
        process.stdout.write(formatDetectAiChangeResultJson(result) + "\n");
      } else {
        process.stdout.write(formatDetectAiChangeResult(result) + "\n");
      }

      if (opts.exitCode && result.anyUncovered) {
        process.exit(1);
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("install-ci")
  .description(
    `Write a Kodela CI/CD workflow file for a supported platform.\n` +
    `  Supported platforms: ${CI_PLATFORMS.join(", ")}`,
  )
  .requiredOption(
    "-p, --platform <name>",
    `Target CI/CD platform (${CI_PLATFORMS.join(", ")})`,
  )
  .option("-f, --force", "Overwrite the file if it already exists", false)
  .option("--sync", "Write the central-sync workflow (push .kodela/ to the server on push to main) instead of the coverage check", false)
  .action(async (opts: { platform: string; force: boolean; sync: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());

    if (!CI_PLATFORMS.includes(opts.platform as CiPlatform)) {
      process.stderr.write(
        `Error: Unknown platform "${opts.platform}".\n` +
        `  Supported platforms: ${CI_PLATFORMS.join(", ")}\n`,
      );
      process.exit(1);
    }

    const config = await loadConfig(repoRoot);

    try {
      const result = await runInstallCi({
        repoRoot,
        platform: opts.platform as CiPlatform,
        config,
        force: opts.force,
        sync: opts.sync,
      });
      process.stdout.write(formatInstallCiResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("report")
  .description(
    "Show top debt entries sorted by age_days × lines_changed (Gap 20c).\n" +
    "  Only entries above the threshold are listed. Snoozed entries are excluded.",
  )
  .option("-t, --threshold <number>", "Minimum debt score to include (default 500)", "500")
  .option("-n, --top <number>", "Maximum entries to show (default 3)", "3")
  .action(async (opts: { threshold?: string; top?: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runReport({
        repoRoot,
        threshold: opts.threshold ? parseInt(opts.threshold, 10) : 500,
        top: opts.top ? parseInt(opts.top, 10) : 3,
      });
      process.stdout.write(formatReportResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("snooze")
  .description(
    "Snooze an entry so it is excluded from `kodela report` until the snooze expires (Gap 20c).",
  )
  .argument("<entryId>", "UUID of the entry to snooze")
  .option("-d, --days <number>", "Snooze for N days (default 7)", "7")
  .option("--clear", "Clear an existing snooze instead of setting one", false)
  .action(async (entryId: string, opts: { days?: string; clear?: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runSnooze({
        repoRoot,
        entryId,
        days: opts.days ? parseInt(opts.days, 10) : 7,
        clear: opts.clear ?? false,
      });
      process.stdout.write(formatSnoozeResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("nudge")
  .description(
    "Output a CI / PR-bot adoption report listing annotations that need attention (Gap 20a).\n" +
    "  Exit code 1 when any items are found — use in GitHub Actions to post a PR comment.",
  )
  .option(
    "-f, --format <fmt>",
    "Output format: comment (Markdown PR block), text, json (default comment)",
    "comment",
  )
  .action(async (opts: { format?: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const fmt = (["text", "comment", "json"].includes(opts.format ?? "")
      ? opts.format
      : "comment") as "text" | "comment" | "json";
    try {
      const result = await runNudge({ repoRoot, format: fmt });
      process.stdout.write(formatNudgeResult(result, fmt) + "\n");
      process.exit(result.needsAttention ? 1 : 0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("health")
  .description(
    "Evaluate kill-switch criteria from local telemetry data (Gap 21).\n" +
    "  Reads .kodela/telemetry.jsonl and reports adoption, friction, and nag-fatigue signals.\n" +
    "  Exit code 1 when any signal breaches its threshold.",
  )
  .option("-w, --window <days>", "Rolling window in days (default 30)", "30")
  .option("--min-annotations <n>", "Minimum annotation count (default 5)", "5")
  .option("--max-dismissal-ratio <ratio>", "Max dismissal ratio 0–1 (default 0.70)", "0.70")
  .option("--max-nag-ratio <ratio>", "Max nag-ignored ratio 0–1 (default 0.50)", "0.50")
  .option("-o, --output <format>", "Output format: text, json (default text)", "text")
  .action(async (opts: {
    window?: string;
    minAnnotations?: string;
    maxDismissalRatio?: string;
    maxNagRatio?: string;
    output?: string;
  }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const fmt = opts.output === "json" ? "json" : "text";
    try {
      const result = await runHealth({
        repoRoot,
        windowDays: opts.window ? parseInt(opts.window, 10) : 30,
        minAnnotations: opts.minAnnotations ? parseInt(opts.minAnnotations, 10) : 5,
        maxDismissalRatio: opts.maxDismissalRatio ? parseFloat(opts.maxDismissalRatio) : 0.70,
        maxNagRatio: opts.maxNagRatio ? parseFloat(opts.maxNagRatio) : 0.50,
      });
      process.stdout.write(formatHealthResult(result, fmt) + "\n");
      process.exit(result.healthy ? 0 : 1);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("graph")
  .description(
    "Build the context graph and answer structural queries (Gap 40).\n" +
    "  Queries: risky-modules, outdated-context, high-impact, communities, all\n" +
    "  Exit code 1 when the query returns results (use as a CI gate).",
  )
  .option(
    "-q, --query <query>",
    "Query to run: risky-modules | outdated-context | high-impact | communities | all (default all)",
    "all",
  )
  .option(
    "--threshold <level>",
    "For risky-modules: minimum severity level: critical | high | medium | low (default high)",
    "high",
  )
  .option(
    "--max-age-days <n>",
    "For outdated-context: flag entries not updated in this many days (default 90)",
    "90",
  )
  .option("-o, --output <format>", "Output format: text, json (default text)", "text")
  .action(async (opts: {
    query?: string;
    threshold?: string;
    maxAgeDays?: string;
    output?: string;
  }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const query = (["risky-modules", "outdated-context", "high-impact", "communities", "all"].includes(opts.query ?? "")
      ? opts.query
      : "all") as GraphQuery;
    const threshold = (["critical", "high", "medium", "low"].includes(opts.threshold ?? "")
      ? opts.threshold
      : "high") as "critical" | "high" | "medium" | "low";
    const output = opts.output === "json" ? "json" : "text";
    try {
      const result = await runGraph({
        repoRoot,
        query,
        threshold,
        maxAgeDays: opts.maxAgeDays ? parseInt(opts.maxAgeDays, 10) : 90,
        output,
      });
      process.stdout.write(formatGraphResult(result, output) + "\n");
      process.exit(result.exitCode);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("export-graph")
  .description(
    "Export the memory graph (files + functions + annotations) in a portable format.\n" +
    "  Formats: json | mermaid | obsidian (default mermaid)\n" +
    "  Mermaid: paste into GitHub/Obsidian/MkDocs for a rendered flowchart.\n" +
    "  Obsidian: drop the output as a .md into a vault — wiki-links auto-resolve.",
  )
  .option(
    "--format <fmt>",
    "Output format: json | mermaid | obsidian (default mermaid)",
    "mermaid",
  )
  .option(
    "--scope <file-or-dir>",
    "Restrict export to nodes that touch this file or directory",
  )
  .action(async (opts: { format?: string; scope?: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const fmt: ExportGraphFormat =
      opts.format === "json" || opts.format === "obsidian" ? opts.format : "mermaid";
    try {
      const result = await runExportGraph({
        repoRoot,
        format: fmt,
        ...(opts.scope ? { scopeFile: opts.scope } : {}),
      });
      process.stdout.write(result.content);
      if (!result.content.endsWith("\n")) process.stdout.write("\n");
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("inject")
  .description(
    "Export context and format it for injection into an AI tool prompt (Gap 39).\n" +
    "  Targets: claude-cli, cursor, copilot, generic\n" +
    "  When --claude is passed, spawns the claude binary with context prepended.",
  )
  .argument("[file]", "File or directory to scope the export. Omit for current directory.")
  .option("--repo", "Export context for the entire repository", false)
  .option(
    "--target <target>",
    "Target AI tool: claude-cli | cursor | copilot | generic (default generic)",
    "generic",
  )
  .option(
    "--max-tokens <n>",
    "Token budget for the exported context (prioritises high-risk, recent entries)",
  )
  .option(
    "--prompt <text>",
    "User prompt to append after the context block (used with --claude).",
  )
  .option(
    "--claude",
    "Spawn the claude CLI with the context-injected prompt. Requires claude on PATH.",
    false,
  )
  .option("-o, --output <format>", "Output format: text, json (default text)", "text")
  .action(async (
    file: string | undefined,
    opts: {
      repo: boolean;
      target?: string;
      maxTokens?: string;
      prompt?: string;
      claude: boolean;
      output?: string;
    },
  ) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const target = (["claude-cli", "cursor", "copilot", "generic"].includes(opts.target ?? "")
      ? opts.target
      : "generic") as IntegrationTarget;
    const maxTokens = opts.maxTokens ? parseInt(opts.maxTokens, 10) : undefined;

    try {
      const { combined, truncated, tokenEstimate, contextText } = await integrate({
        repoRoot,
        target,
        scopePath: file,
        repo: opts.repo,
        maxTokens,
        prompt: opts.prompt,
      });

      if (opts.claude) {
        const exitCode = await runClaudeWithContext(
          contextText,
          opts.prompt ?? "",
          { interactive: true },
        );
        process.exit(exitCode);
        return;
      }

      process.stdout.write(
        formatInjectResult({ target, combined, truncated, tokenEstimate }) + "\n",
      );
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("capture")
  .description(
    "Gap 104 — Deterministic trusted AI context capture.\n" +
    "  Writes a ContextEntry with trustLevel=high, ingestion=deterministic,\n" +
    "  confidence=1.0, bypassing the UBA heuristic classifier.\n" +
    "  Use this when the AI tool is known and can self-identify.\n\n" +
    "  Examples:\n" +
    "    kodela capture --file src/auth/session.ts --start 1 --end 72 \\\n" +
    "                   --tool replit-agent --intent \"Add session helpers\"\n\n" +
    "    kodela capture --file lib/core/src/env/ctx.ts --start 1 --end 30 \\\n" +
    "                   --tool claude-cli --session abc123 --json",
  )
  .requiredOption("--file <path>", "Repository-relative path of the annotated file")
  .requiredOption("--start <n>", "First line of the annotated range (1-based)", parseInt)
  .requiredOption("--end <n>", "Last line of the annotated range (1-based)", parseInt)
  .requiredOption("--tool <name>", "AI tool name (e.g. replit-agent, claude-cli, cursor)")
  .option("--model <model>", "Model version (e.g. claude-3-5-sonnet-20241022)")
  .option("--session <id>", "Session or conversation identifier")
  .option("--intent <text>", "What the AI was asked to do")
  .option("--diff <text>", "Unified diff string")
  .option("--diff-file <path>", "File containing the unified diff")
  .option("--lines-added <n>", "Number of lines added", parseInt)
  .option("--lines-removed <n>", "Number of lines removed", parseInt)
  .option("--author <name>", "Author identity override")
  .option("--json", "Output result as JSON", false)
  .action(async (opts: {
    file: string;
    start: number;
    end: number;
    tool: string;
    model?: string;
    session?: string;
    intent?: string;
    diff?: string;
    diffFile?: string;
    linesAdded?: number;
    linesRemoved?: number;
    author?: string;
    json: boolean;
  }) => {
    try {
      await runCapture({
        file: opts.file,
        start: opts.start,
        end: opts.end,
        tool: opts.tool,
        model: opts.model,
        session: opts.session,
        intent: opts.intent,
        diff: opts.diff,
        diffFile: opts.diffFile,
        linesAdded: opts.linesAdded,
        linesRemoved: opts.linesRemoved,
        author: opts.author,
        json: opts.json,
      });
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("assign <entryId>")
  .description(
    "Assign a reviewer to an AI-generated annotation.\n" +
    "  Sets reviewerOwner on the entry so it is clear who must sign off the change.",
  )
  .requiredOption("--to <email>", "Reviewer email or username to assign")
  .action(async (entryId: string, opts: { to: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runAssign({ repoRoot, entryId, to: opts.to });
      process.stdout.write(formatAssignResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("link <entryId>")
  .description(
    "Gap 50: Link a context entry to an external issue, ticket, or document.\n" +
    "  Parses the URL to detect the provider (linear, jira, notion, confluence)\n" +
    "  and optionally fetches the title from the provider API.\n" +
    "  Requires the relevant KODELA_*_API_KEY env var for title fetch.",
  )
  .requiredOption(
    "--ref <url>",
    "URL of the external issue/document (Linear ticket, Jira issue, Notion page, etc.)",
  )
  .action(async (entryId: string, opts: { ref: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runLink({ repoRoot, entryId, ref: opts.ref });
      process.stdout.write(formatLinkResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("signoff [entryId]")
  .description(
    "Sign off an AI-generated annotation, recording the reviewer and timestamp.\n" +
    "  Clears reviewRequired on the entry and writes a sign-off record to .kodela/signoffs/.\n" +
    "  Use --pending to list all entries that still need a sign-off.",
  )
  .option("--comment <text>", "Optional comment to attach to the sign-off")
  .option("--pending", "List entries where reviewRequired is true and no sign-off exists", false)
  .action(async (entryId: string | undefined, opts: { comment?: string; pending: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runSignoff({
        repoRoot,
        entryId,
        comment: opts.comment,
        pending: opts.pending,
      });
      process.stdout.write(formatSignoffResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("discuss <entryId>")
  .description(
    "Manage the discussion thread for an annotation entry.\n" +
    "  Without flags: lists active (unresolved) comments, newest last.\n" +
    "  --add <text>        Append a new comment as the current git user.\n" +
    "  --resolve <id>      Mark a comment as resolved by its comment ID.\n" +
    "  --all               Include resolved comments in the listing.",
  )
  .option("--add <text>", "Append a new comment to the thread")
  .option("--resolve <commentId>", "Mark a specific comment as resolved")
  .option("--all", "Include resolved comments in the listing", false)
  .action(async (
    entryId: string,
    opts: { add?: string; resolve?: string; all: boolean },
  ) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runDiscuss({
        repoRoot,
        entryId,
        add: opts.add,
        resolve: opts.resolve,
        all: opts.all,
      });
      process.stdout.write(formatDiscussResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("propose [file]")
  .description(
    "Draft an AI-generated annotation note for a code range or named function.\n" +
    "  The draft is presented for review before anything is written.\n\n" +
    "  Single-file:  kodela propose src/payments/processor.ts --fn processPayment\n" +
    "  With range:   kodela propose src/lib/auth.ts --lines 45-82\n" +
    "  Auto-accept:  kodela propose src/lib/auth.ts --lines 45-82 --accept\n" +
    "  Batch mode:   kodela propose --repo [--source ai]\n" +
    "  Review queue: kodela propose --review\n\n" +
    "  Requires KODELA_AI_API_KEY (or ai_provider.api_key in kodela.config.json).",
  )
  .option("--lines <range>", "Line range to annotate, e.g. 45-82")
  .option("--fn <name>", "Function or method name to locate in the file")
  .option("--accept", "Non-interactively accept the proposed note", false)
  .option("--reject", "Non-interactively reject the proposed note", false)
  .option("--repo", "Batch mode: scan repo for stub annotations", false)
  .option(
    "--source <source>",
    "Filter batch mode to entries with this source (e.g. ai)",
  )
  .option("--review", "Review queued proposals in .kodela/proposals.json", false)
  .action(
    async (
      file: string | undefined,
      opts: {
        lines?: string;
        fn?: string;
        accept: boolean;
        reject: boolean;
        repo: boolean;
        source?: string;
        review: boolean;
      },
    ) => {
      const repoRoot = await findRepoRoot(process.cwd());
      const config = await loadConfig(repoRoot).catch(() => DEFAULT_CONFIG);
      const aiProviderCfg = config.ai_provider ?? {};
      const aiConfig = {
        provider: aiProviderCfg.provider,
        model: aiProviderCfg.model,
        apiKey: aiProviderCfg.api_key,
        baseUrl: aiProviderCfg.base_url,
      };

      let lineStart: number | undefined;
      let lineEnd: number | undefined;
      if (opts.lines) {
        const parts = opts.lines.split("-").map((s) => parseInt(s.trim(), 10));
        lineStart = parts[0];
        lineEnd = parts[1] ?? parts[0];
      }

      try {
        const result = await runPropose({
          repoRoot,
          filePath: file,
          lineStart,
          lineEnd,
          fn: opts.fn,
          accept: opts.accept,
          reject: opts.reject,
          repo: opts.repo,
          review: opts.review,
          source: opts.source,
          aiConfig,
        });
        process.stdout.write(formatProposeResult(result) + "\n");
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    },
  );

program
  .command("pr-comment")
  .description(
    "Analyse the current git diff against all Kodela annotations and output a\n" +
    "rich Markdown PR comment body (or JSON).\n\n" +
    "  kodela pr-comment                   — diff between working tree and HEAD\n" +
    "  kodela pr-comment --base <sha>      — diff between <sha> and HEAD\n" +
    "  kodela pr-comment --output json     — machine-readable JSON output\n" +
    "  kodela pr-comment --output text     — plain text (no Markdown tables)\n\n" +
    "Useful in CI scripts to post annotation summaries to GitHub/GitLab PRs.",
  )
  .option("--base <sha>", "Base commit SHA to diff from (default: HEAD)")
  .option(
    "--output <format>",
    "Output format: comment (default), json, or text",
    "comment",
  )
  .action(async (opts: { base?: string; output?: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const format =
      opts.output === "json"
        ? "json"
        : opts.output === "text"
          ? "text"
          : "comment";
    try {
      const result = await runPrComment({ repoRoot, base: opts.base });
      process.stdout.write(formatPrCommentResult(result, format) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("validate [scopePath]")
  .description(
    "Gap 48: Validate that annotation notes still accurately describe the current code.\n" +
    "  Uses the configured AI provider to check each entry in scope.\n" +
    "  Results are written back as lastValidation: { validatedAt, valid, discrepancy? }.\n" +
    "  Entries with valid=false should be corrected with `kodela correct`.",
  )
  .option("--entry <id>", "Validate a single entry by UUID")
  .option(
    "--threshold <level>",
    "Only validate entries at or above this drift level: low | medium | high (default: all)",
  )
  .option("--dry-run", "Print which entries would be validated without calling AI", false)
  .option("--verbose", "Show all validation results (not just failures)", false)
  .option("--provider <name>", "AI provider override: openai | anthropic")
  .option("--model <name>", "AI model override (e.g. gpt-4o, claude-3-5-sonnet-20241022)")
  .action(async (
    scopePath: string | undefined,
    opts: {
      entry?: string;
      threshold?: string;
      dryRun: boolean;
      verbose: boolean;
      provider?: string;
      model?: string;
    },
  ) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const threshold = opts.threshold as "low" | "medium" | "high" | undefined;
      const result = await runValidate({
        repoRoot,
        scopePath,
        entryId: opts.entry,
        threshold,
        dryRun: opts.dryRun,
        aiConfig: {
          ...(opts.provider ? { provider: opts.provider as "openai" | "anthropic" } : {}),
          ...(opts.model ? { model: opts.model } : {}),
        },
      });
      process.stdout.write(formatValidateResult(result, opts.verbose) + "\n");
      process.exit(result.invalid > 0 ? 1 : 0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("migrate")
  .description(
    "Gap 59 — Migrate local .kodela/objects/ to a two-level sharded layout.\n" +
    "  Each object is moved from objects/<uuid>.json to objects/<xx>/<uuid>.json\n" +
    "  where <xx> is the first two hex characters of the UUID.",
  )
  .option("--dry-run", "Show what would be migrated without making changes", false)
  .action(async (opts: { dryRun: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runMigrate({ repoRoot, dryRun: opts.dryRun });
      process.stdout.write(formatMigrateResult(result) + "\n");
      process.exit(result.errors.length > 0 ? 1 : 0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("migrate-to-saas")
  .description(
    "P6.5 (internal design note) — Upload local .kodela/ data to a Kodela SaaS workspace.\n" +
    "  Walks .kodela/objects/ and .kodela/sessions/, batches each record, and POSTs to\n" +
    "  /api/migrations/local-import on the configured server.  Idempotent — re-running after\n" +
    "  a partial failure resumes via the server-side upsert path.\n" +
    "  Comments + signoffs are NOT migrated yet (P6.5b, after the row-filter audit lands).",
  )
  .requiredOption("--server <url>", "SaaS server URL (e.g. https://app.kodela.dev)")
  .requiredOption("--api-key <key>", "Kodela API key (Bearer token)")
  .requiredOption("--repo-id <id>", "Server-side repo identifier (FK to repo_links.id) to attach data to")
  .option("--org-id <id>", "Organization id for the X-Kodela-Org-Id header (defaults to KODELA_ORG_ID or the installed license)")
  .option("--batch-size <n>", "Records per HTTP request (default 100)", "100")
  .option("--dry-run", "Walk the local data + print the count without POSTing", false)
  .action(
    async (opts: {
      server: string;
      apiKey: string;
      repoId: string;
      orgId?: string;
      batchSize: string;
      dryRun: boolean;
    }) => {
      const repoRoot = await findRepoRoot(process.cwd());
      try {
        const result = await runMigrateToSaas({
          repoRoot,
          serverUrl: opts.server,
          apiKey: opts.apiKey,
          repoId: opts.repoId,
          orgId: opts.orgId,
          batchSize: parseInt(opts.batchSize, 10),
          dryRun: opts.dryRun,
        });
        process.stdout.write(formatMigrateToSaasResult(result) + "\n");
        process.exit(result.httpErrors.length === 0 ? 0 : 1);
      } catch (err) {
        handleMigrateToSaasError(err);
      }
    },
  );

program
  .command("gc")
  .description(
    "Gap 59 — Garbage-collect stale event log and session files from .kodela/.\n" +
    "  Removes files older than --older-than days from .kodela/events/ and/or\n" +
    "  .kodela/sessions/.",
  )
  .argument("<scope>", "What to clean: events | sessions | all")
  .option("--older-than <days>", "Remove files older than N days", "90")
  .option("--dry-run", "Show what would be removed without deleting", false)
  .action(async (scope: string, opts: { olderThan: string; dryRun: boolean }) => {
    if (!["events", "sessions", "all"].includes(scope)) {
      process.stderr.write(`Error: scope must be one of: events, sessions, all\n`);
      process.exit(1);
    }
    const repoRoot = await findRepoRoot(process.cwd());
    const olderThanDays = parseInt(opts.olderThan, 10);
    try {
      const result = await runGc({
        repoRoot,
        scope: scope as "events" | "sessions" | "all",
        olderThanDays,
        dryRun: opts.dryRun,
      });
      process.stdout.write(formatGcResult(result, olderThanDays) + "\n");
      process.exit(result.errors.length > 0 ? 1 : 0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("config-pull")
  .description(
    "Inherit org-wide config from the central server into kodela.config.json.\n" +
    "  An admin sets defaults once (dashboard → Admin → Configuration); each repo\n" +
    "  pulls them here. Locked policies override; otherwise org values only fill\n" +
    "  fields the repo has not set. GET /api/admin/org-config.",
  )
  .option("--server <url>", "Server URL (overrides storage.server.url)")
  .option("--api-key <key>", "API key (overrides KODELA_API_KEY)")
  .option("--org-id <id>", "Organization id (overrides KODELA_ORG_ID / license)")
  .option("--dry-run", "Fetch + show what would change without writing", false)
  .action(async (opts: { server?: string; apiKey?: string; orgId?: string; dryRun: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runConfigPull({
        repoRoot,
        serverUrl: opts.server,
        apiKey: opts.apiKey,
        orgId: opts.orgId,
        dryRun: opts.dryRun,
      });
      process.stdout.write(formatConfigPullResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      handleConfigPullError(err);
    }
  });

program
  .command("sync")
  .description(
    "Gap 60 — Push local annotations to the central Kodela server.\n" +
    "  Reads all entries from .kodela/ and sends them to POST /api/entries/session-batch\n" +
    "  on the configured server. Requires a running server and a valid API key.",
  )
  .option("--server <url>", "Server URL (overrides kodela.config.json storage.server.url)")
  .option("--api-key <key>", "API key (overrides KODELA_API_KEY env var)")
  .option("--session <id>", "Only sync entries with this session ID")
  .option("--batch-size <n>", "Entries per batch request", "100")
  .option("--dry-run", "Show what would be synced without sending", false)
  .option(
    "--auto",
    "Automatic mode: no-op unless storage.mode is \"central\", and never error " +
      "(silent when unconfigured). Used by the post-commit hook so team sync is hands-off.",
    false,
  )
  .action(
    async (opts: {
      server?: string;
      apiKey?: string;
      session?: string;
      batchSize: string;
      dryRun: boolean;
      auto: boolean;
    }) => {
      const repoRoot = await findRepoRoot(process.cwd());
      const config = await loadConfigSafe(repoRoot);

      // --auto is the hands-off team path: it fires on every commit via the
      // post-commit hook, so it must be a silent no-op unless the org has opted
      // this repo into central storage. That opt-in is set once in the admin
      // panel and inherited via `kodela config-pull` (storage.mode: central).
      const storageMode =
        config instanceof ConfigLoadError ? undefined : config.storage?.mode;
      if (opts.auto && storageMode !== "central") {
        process.exit(0);
      }

      const serverUrl =
        opts.server ??
        (config instanceof ConfigLoadError ? undefined : config.storage?.server?.url);

      const apiKeyEnvName =
        config instanceof ConfigLoadError
          ? "KODELA_API_KEY"
          : (config.storage?.server?.api_key_env ?? "KODELA_API_KEY");

      const apiKey = opts.apiKey ?? process.env[apiKeyEnvName];

      if (!serverUrl) {
        // In --auto mode a missing server is not an error — the repo may be
        // mid-onboarding; stay silent so we never break a developer's commit.
        if (opts.auto) process.exit(0);
        process.stderr.write(
          "Error: server URL required. Set storage.server.url in kodela.config.json or use --server.\n",
        );
        process.exit(1);
      }

      if (!apiKey) {
        if (opts.auto) process.exit(0);
        process.stderr.write(
          `Error: API key required. Set the ${apiKeyEnvName} environment variable or use --api-key.\n`,
        );
        process.exit(1);
      }

      try {
        const result = await runSync({
          repoRoot,
          serverUrl,
          apiKey,
          sessionId: opts.session,
          batchSize: parseInt(opts.batchSize, 10),
          dryRun: opts.dryRun,
        });
        // Auto mode keeps quiet on success (nothing to report on a normal
        // commit) but still surfaces errors to stderr for debugging.
        if (!opts.auto) {
          process.stdout.write(formatSyncResult(result) + "\n");
        } else if (result.errors.length > 0) {
          process.stderr.write(formatSyncResult(result) + "\n");
        }
        process.exit(result.errors.length > 0 ? 1 : 0);
      } catch (err) {
        if (opts.auto) process.exit(0);
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    },
  );

const policyCmd = program
  .command("policy")
  .description("Manage local policy rules for the repository");

policyCmd
  .command("validate")
  .description(
    "Validate the local policy file (.kodela/policy.json) against the schema.\n" +
      "  Reports each issue with the JSON path and a human-readable message.",
  )
  .option(
    "--file <path>",
    "Path to the policy file to validate (default: .kodela/policy.json)",
  )
  .action(async (opts: { file?: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runPolicyValidate({ repoRoot, file: opts.file });
      process.stdout.write(formatPolicyValidateResult(result) + "\n");
      process.exit(result.valid ? 0 : 1);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

policyCmd
  .command("init")
  .description(
    "Create a starter .kodela/policy.json with sensible defaults.\n" +
      "  Covers auth, payments, and a global minimum confidence rule.",
  )
  .option("-f, --force", "Overwrite an existing policy file", false)
  .action(async (opts: { force: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runPolicyInit({ repoRoot, force: opts.force });
      process.stdout.write(formatPolicyInitResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// hook command (Gap 52 — Claude Code Hooks Integration)
// ---------------------------------------------------------------------------

const hookCmd = program
  .command("hook")
  .description(
    "Manage IDE hook integration.\n" +
    "  install  — Claude Code (.claude/settings.json) or Cursor (.cursor/hooks)\n" +
    "  process  — process an incoming Claude hook payload (reads from stdin)",
  );

hookCmd
  .command("install")
  .description(
    "Install Kodela hooks for Claude Code or Cursor.\n" +
    "  --claude  → .claude/settings.json (default when neither flag is set)\n" +
    "  --cursor  → .cursor/hooks.json + scripts; writes .kodela/kodela-home\n" +
    "  Idempotent — safe to run multiple times.",
  )
  .option("--claude", "Install Claude Code hooks (.claude/settings.json)", false)
  .option("--cursor", "Install Cursor IDE hooks (.cursor/hooks)", false)
  .option(
    "--kodela-home <path>",
    "Kodela monorepo with artifacts/mcp-server (for --cursor on external repos)",
  )
  .option("-f, --force", "Reinstall hooks even if already installed", false)
  .action(async (opts: {
    claude: boolean;
    cursor: boolean;
    kodelaHome?: string;
    force: boolean;
  }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      if (opts.cursor) {
        const result = await runHookInstallCursor({
          repoRoot,
          kodelaHome: opts.kodelaHome,
          force: opts.force,
        });
        process.stdout.write(formatHookInstallCursorResult(result) + "\n");
      } else {
        const result = await runHookInstallClaude({ repoRoot, force: opts.force });
        process.stdout.write(formatHookInstallResult(result) + "\n");
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

hookCmd
  .command("process")
  .description(
    "Process a Claude Code hook payload.\n" +
    "  Reads JSON from stdin unless --payload is specified.\n" +
    "  Never interrupts the developer workflow — all errors go to .kodela/hook-errors.log.",
  )
  .requiredOption(
    "--event <name>",
    "Hook event type: PostToolUse | SessionStart | SessionEnd | UserPromptSubmit",
  )
  .option("--payload <path>", "Read payload from a file instead of stdin")
  .action(async (opts: { event: string; payload?: string }) => {
    // This command must NEVER exit non-zero — errors logged to file
    try {
      const repoRoot = await findRepoRoot(process.cwd());
      const config = await loadConfigSafe(repoRoot);
      const aiProviderCfg = config?.ai_provider ?? {};
      const aiConfig = {
        provider: aiProviderCfg.provider,
        model: aiProviderCfg.model,
        apiKey:
          aiProviderCfg.api_key ?? process.env["KODELA_AI_API_KEY"] ?? "",
        baseUrl: aiProviderCfg.base_url,
      };
      await runHookProcess({
        repoRoot,
        event: opts.event as ClaudeHookEventType,
        payloadPath: opts.payload,
        aiConfig,
      });
    } catch {
      // Swallow all errors — never interrupt Claude
    }
    process.exit(0);
  });

// ---------------------------------------------------------------------------
// extract-reasoning command (Gap 53 — Reasoning Extraction Engine)
// ---------------------------------------------------------------------------

program
  .command("extract-reasoning")
  .description(
    "Extract structured reasoning from AI activity and attach it to ContextEntry objects.\n\n" +
    "  Modes:\n" +
    "    --entry <uuid>           Single entry by ID\n" +
    "    --file <path>            All entries for a file\n" +
    "    --source ai              All AI-sourced entries\n" +
    "    --diff <path>            Diff-only mode (no entry required)\n\n" +
    "  Options:\n" +
    "    --threshold low|medium|high  Only entries below this confidence (with --source)\n" +
    "    --dry-run                    Preview without writing changes\n" +
    "    --force                      Re-extract even if reasoning was recently extracted\n" +
    "    --json                       Output as JSON",
  )
  .option("--entry <uuid>", "Extract reasoning for a single entry")
  .option("--file <path>", "Extract reasoning for all entries on a file")
  .option("--source <source>", "Filter by source (e.g. ai, human)")
  .option("--threshold <level>", "Confidence threshold filter: low | medium | high")
  .option("--diff <path>", "Extract reasoning from a diff file")
  .option("--dry-run", "Preview extraction without writing changes", false)
  .option("-f, --force", "Re-extract even if recent reasoning exists", false)
  .option("--json", "Output as JSON", false)
  .action(
    async (opts: {
      entry?: string;
      file?: string;
      source?: string;
      threshold?: string;
      diff?: string;
      dryRun: boolean;
      force: boolean;
      json: boolean;
    }) => {
      const repoRoot = await findRepoRoot(process.cwd());
      try {
        const config = await loadConfigSafe(repoRoot);
        const aiProviderCfg = config?.ai_provider ?? {};
        const aiConfig = {
          provider: aiProviderCfg.provider,
          model: aiProviderCfg.model,
          apiKey:
            aiProviderCfg.api_key ?? process.env["KODELA_AI_API_KEY"] ?? "",
          baseUrl: aiProviderCfg.base_url,
        };

        // Determine mode
        type ExtractMode =
          | { kind: "entry"; entryId: string }
          | { kind: "file"; filePath: string }
          | { kind: "source"; source: string; threshold?: string }
          | { kind: "diff"; diffPath: string };

        let mode: ExtractMode;
        if (opts.entry) {
          mode = { kind: "entry", entryId: opts.entry };
        } else if (opts.file) {
          mode = { kind: "file", filePath: opts.file };
        } else if (opts.diff) {
          mode = { kind: "diff", diffPath: opts.diff };
        } else if (opts.source) {
          mode = {
            kind: "source",
            source: opts.source,
            threshold: opts.threshold,
          };
        } else {
          // Default: all AI-sourced entries
          mode = { kind: "source", source: "ai", threshold: opts.threshold };
        }

        const result = await runExtractReasoning({
          repoRoot,
          mode,
          dryRun: opts.dryRun,
          force: opts.force,
          aiConfig,
        });

        if (opts.json) {
          process.stdout.write(formatExtractReasoningResultJson(result) + "\n");
        } else {
          process.stdout.write(formatExtractReasoningResult(result) + "\n");
        }
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    },
  );

// ── Gap 55 Phase C — sessions command group ──────────────────────────────────

const sessionsCmd = program
  .command("sessions")
  .description(
    "Gap 55: Manage and inspect session-based change groups.\n\n" +
    "  kodela sessions list                         — list all sessions\n" +
    "  kodela sessions show <session_id>            — detailed view\n" +
    "  kodela sessions show <session_id> --output json  — JSON output",
  );

sessionsCmd
  .command("list")
  .description("List all sessions in .kodela/sessions/, newest first.")
  .option("--output <format>", "Output format: table (default) or json", "table")
  .action(async (opts: { output?: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const format = opts.output === "json" ? "json" : "table";
    try {
      const output = await runSessionsList({ repoRoot, format });
      process.stdout.write(output + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

sessionsCmd
  .command("show <session_id>")
  .description("Show detailed information for a session.")
  .option("--output <format>", "Output format: table (default) or json", "table")
  .action(async (sessionId: string, opts: { output?: string }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    const format = opts.output === "json" ? "json" : "table";
    try {
      const output = await runSessionsShow({ repoRoot, sessionId, format });
      process.stdout.write(output + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

// ── Gap 54 Phase D — mcp command group ───────────────────────────────────────

const mcpCmd = program
  .command("mcp")
  .description(
    "Gap 54: Manage the Kodela MCP server.\n\n" +
    "  kodela mcp start   — print MCP config snippet for Claude Code\n" +
    "  kodela mcp serve   — run the MCP server (used by IDE configs / kodela connect)\n" +
    "  kodela mcp start   — print MCP config snippet for Claude Code\n" +
    "  kodela mcp status  — check if MCP server is configured",
  );

mcpCmd
  .command("serve")
  .description(
    "Run the Kodela MCP server over stdio. This is what IDE MCP configs / `kodela connect` launch.",
  )
  .action(() => {
    // When installed, the `kodela` bin is symlinked into node_modules/.bin, so
    // dirname(argv[1]) points at .bin — not the dist dir holding mcp-server.cjs.
    // realpath resolves the symlink to the real bundle location.
    const argvBin = process.argv[1] ?? process.cwd();
    let realBin = argvBin;
    try {
      realBin = realpathSync(argvBin);
    } catch {
      // argv[1] may not be a real file (e.g. dev runner) — fall back as-is.
    }
    const binDir = path.dirname(realBin);
    const candidates = [path.join(binDir, "mcp-server.cjs")]; // bundled next to the bin
    const home = resolveKodelaHome(binDir) ?? resolveKodelaHome(process.cwd());
    if (home) candidates.push(path.join(home, "artifacts", "mcp-server", "dist", "index.js"));
    const script = candidates.find((p) => existsSync(p));
    if (!script) {
      process.stderr.write(
        "Error: could not locate the Kodela MCP server bundle. Reinstall, or run `node <kodela>/artifacts/mcp-server/dist/index.js`.\n",
      );
      process.exit(1);
    }
    // Hand stdio straight through so the MCP client talks to the server directly.
    const child = spawn(process.execPath, [script], { stdio: "inherit", env: process.env });
    child.on("exit", (code) => process.exit(code ?? 0));
    child.on("error", (err) => {
      process.stderr.write(`Error launching MCP server: ${err.message}\n`);
      process.exit(1);
    });
  });

mcpCmd
  .command("start")
  .description(
    "Print a ready-to-paste MCP configuration snippet for Claude Code " +
    "and validate that the MCP server package is available.",
  )
  .action(async () => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runMcpStart({ repoRoot });
      process.stdout.write(formatMcpStart(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

mcpCmd
  .command("status")
  .description("Check whether the Kodela MCP server is configured in .claude/settings.json.")
  .action(async () => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runMcpStatus({ repoRoot });
      process.stdout.write(formatMcpStatus(result) + "\n");
      process.exit(result.configured ? 0 : 1);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

// ── Gap 114 — context command ─────────────────────────────────────────────────

/**
 * Resolve the shared-memory read mode + remote credentials for `kodela context`.
 * Precedence: CLI flags → env → kodela.config.json → license. Mirrors the
 * resolution `kodela sync` / `kodela config-pull` use. When readMode is
 * remote/merge but the remote config can't be fully resolved, we downgrade to
 * local read and warn — never fail the command over a missing shared-memory
 * setting.
 */
async function resolveContextRemote(
  repoRoot: string,
  opts: {
    readMode?: string;
    server?: string;
    apiKey?: string;
    orgId?: string;
    repoId?: string;
    repo?: string;
  },
): Promise<{ readMode: ReadMode; config?: RemoteReadConfig }> {
  const config = await loadConfig(repoRoot).catch(() => DEFAULT_CONFIG);

  const requested = (opts.readMode ?? config.storage?.readMode ?? "local") as ReadMode;
  if (requested !== "remote" && requested !== "merge") {
    return { readMode: "local" };
  }

  const serverUrl = opts.server ?? config.storage?.server?.url;
  const apiKeyEnv = config.storage?.server?.api_key_env ?? "KODELA_API_KEY";
  const apiKey = opts.apiKey ?? process.env[apiKeyEnv];
  const orgId =
    opts.orgId ??
    process.env["KODELA_ORG_ID"] ??
    (await loadLicense(repoRoot))?.orgId;
  const repoId = opts.repoId ?? process.env["KODELA_REPO_ID"];
  // Repo scope: explicit --repo / raw id wins; otherwise auto-derive the repo
  // full name from `git remote` so no flag is needed in the common case.
  const repoFullName =
    opts.repo ??
    process.env["KODELA_REPO"] ??
    (repoId ? undefined : (await resolveRepoIdentity(repoRoot))?.repoFullName);

  const missing: string[] = [];
  if (!serverUrl) missing.push("server URL (--server / storage.server.url)");
  if (!apiKey) missing.push(`API key (--api-key / $${apiKeyEnv})`);
  if (!orgId) missing.push("org id (--org-id / $KODELA_ORG_ID / license)");
  if (!repoId && !repoFullName)
    missing.push("repo (--repo / a git remote / --repo-id)");

  if (missing.length > 0) {
    process.stderr.write(
      `Warning: readMode="${requested}" requested but ${missing.join(", ")} ` +
        `not resolved; reading local only.\n`,
    );
    return { readMode: "local" };
  }

  return {
    readMode: requested,
    config: {
      serverUrl: serverUrl!,
      apiKey: apiKey!,
      orgId: orgId!,
      repoFullName,
      repoId,
    },
  };
}

program
  .command("context")
  .description(
    "Gap 114: Query ranked project context from the local SQLite index.\n\n" +
    "  kodela context                               — all context (default token budget)\n" +
    "  kodela context --file src/auth/session.ts    — context relevant to a file\n" +
    "  kodela context --intent bugfix               — context filtered by intent\n" +
    "  kodela context --file src/auth/session.ts --intent bugfix --debug\n" +
    "  kodela context --file src/auth/session.ts --budget 8000",
  )
  .option("--file <path>", "Repo-relative file path to query context for")
  .option("--intent <string>", "Intent hint — e.g. bugfix, refactor, new-file, addition")
  .option("--budget <tokens>", "Token budget (default: 4000)", (v) => parseInt(v, 10))
  .option("--debug", "Show full scoring breakdown, cluster selection rationale, and timing")
  .option("--output <format>", "Output format: json (default) or pretty", "json")
  .option(
    "--read-mode <mode>",
    "Shared-memory read: local | remote | merge (default: storage.readMode or local)",
  )
  .option("--server <url>", "Server URL for remote/merge read (overrides storage.server.url)")
  .option("--api-key <key>", "API key for remote/merge read (overrides KODELA_API_KEY)")
  .option("--org-id <id>", "Organization id (overrides KODELA_ORG_ID / license)")
  .option("--repo <owner/name>", "Repo full name for shared-memory scope (default: auto from git remote)")
  .option("--repo-id <id>", "Raw repo_links id (overrides KODELA_REPO_ID / --repo)")
  .action(
    async (opts: {
      file?: string;
      intent?: string;
      budget?: number;
      debug?: boolean;
      output?: string;
      readMode?: string;
      server?: string;
      apiKey?: string;
      orgId?: string;
      repo?: string;
      repoId?: string;
    }) => {
      const repoRoot = await findRepoRoot(process.cwd());
      try {
        const remote = await resolveContextRemote(repoRoot, opts);
        const result = await runContext({
          repoRoot,
          filePath: opts.file,
          intent: opts.intent,
          budget: opts.budget,
          debug: opts.debug === true,
          readMode: remote.readMode,
          remote: remote.config,
          onWarn: (m) => process.stderr.write(`Warning: ${m}\n`),
        });
        const pretty = opts.output === "pretty";
        const text = pretty
          ? formatContextResultPretty(result, opts.debug === true)
          : formatContextResult(result, opts.debug === true);
        process.stdout.write(text + "\n");
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    },
  );

program
  .command("handoff")
  .description(
    "Gap 123: Export a structured AI-transferable context handoff for a session.\n" +
    "  --session <id>   Session UUID or prefix (required).\n" +
    "  --markdown       Output only the markdown summary (for clipboard/pipe).\n" +
    "  (no flags)       Print usage.",
  )
  .option("--session <id>", "Session UUID or prefix to export")
  .option("--markdown", "Output only the markdown summary (no JSON envelope)", false)
  .action(async (opts: { session?: string; markdown: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runHandoff({
        repoRoot,
        sessionId: opts.session,
        markdownOnly: opts.markdown,
      });
      process.stdout.write(result + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command("upgrade")
  .description(
    "Start a self-serve paid-tier checkout (BR-MON-1). Opens a Stripe Checkout " +
    "session (or the pricing page) in your browser with your org pre-filled.\n" +
    "  --plan <pro|team>   Tier to purchase (default: pro).\n" +
    "  --email <addr>      Pre-fill the billing email.\n" +
    "  --print             Print the URL instead of opening a browser.",
  )
  .option("--plan <plan>", "Tier to purchase (pro | team)", "pro")
  .option("--email <email>", "Billing email to pre-fill")
  .option("--billing-url <url>", "Kodela billing service base URL (default: $KODELA_BILLING_URL)")
  .option("--print", "Print the checkout URL instead of opening a browser", false)
  .action(async (opts: { plan: string; email?: string; billingUrl?: string; print: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const r = await runUpgrade({
        repoRoot,
        plan: opts.plan,
        email: opts.email,
        billingUrl: opts.billingUrl,
        print: opts.print,
      });
      if (r.note) process.stderr.write(`note: ${r.note}\n`);
      process.stdout.write(
        `Upgrade to ${r.plan} for org ${r.orgId}:\n  ${r.url}\n` +
          (r.opened ? "Opened in your browser.\n" : "Open the URL above to complete checkout.\n"),
      );
      process.exit(0);
    } catch (err) {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command("activate")
  .description(
    "Install a paid license after checkout (BR-MON-6). Exchanges the activation\n" +
    "  token from your purchase for the org's signed license and writes it to\n" +
    "  kodela.license.json. The signature is verified offline before install.\n" +
    "  --billing-url <url>   Kodela billing service base URL (default: $KODELA_BILLING_URL).\n" +
    "  --print               Show what would be installed without writing the file.",
  )
  .argument("<token>", "Activation token from your purchase (kdl_act_…)")
  .option("--billing-url <url>", "Kodela billing service base URL (default: $KODELA_BILLING_URL)")
  .option("--print", "Print the resolved license without writing it to disk", false)
  .action(async (token: string, opts: { billingUrl?: string; print: boolean }) => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const result = await runActivate({
        repoRoot,
        token,
        billingUrl: opts.billingUrl,
        print: opts.print,
      });
      process.stdout.write(formatActivateResult(result) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command("license")
  .description(
    "Show the current license — plan, features, expiry, and signature trust.\n" +
    "  Read-only and offline: no network call, no billing secrets. Run after\n" +
    "  `kodela activate` to confirm the license is installed and effective.",
  )
  .action(async () => {
    const repoRoot = await findRepoRoot(process.cwd());
    try {
      const status = await runLicenseStatus({ repoRoot });
      process.stdout.write(formatLicenseStatus(status) + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
