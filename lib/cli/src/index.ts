// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export type { KodelaConfig, CiEnforcement, CiThresholds, HooksConfig } from "./config/schema.js";
export { KodelaConfigSchema, HooksConfigSchema, DEFAULT_CONFIG } from "./config/schema.js";
export {
	findConfigFile,
	loadConfig,
	writeDefaultConfig,
	CONFIG_FILE_NAME,
	CLI_VERSION,
} from "./config/loader.js";

export type { StatusResult, ThresholdBreach } from "./status/metrics.js";
export { computeMetrics, checkCiThresholds, buildStatusResult } from "./status/metrics.js";

export type { OutputMode, WatchBatchResult } from "./output/formatters.js";
export { OUTPUT_MODES, formatStatus, formatEntry, formatEntries, formatWatchBatchResult } from "./output/formatters.js";

export type { InitOptions, InitResult } from "./commands/init.js";
export { runInit, formatInitResult } from "./commands/init.js";

export type { StatusOptions } from "./commands/status.js";
export { runStatus, readAllEntries } from "./commands/status.js";

export type { AddOptions, AddResult } from "./commands/add.js";
export { runAdd } from "./commands/add.js";

export type { ExplainOptions, ExplainResult } from "./commands/explain.js";
export { runExplain, formatExplainResult, formatExplainShare } from "./commands/explain.js";

export type { HealOptions, HealResult, HealEntry } from "./commands/heal.js";
export { runHeal, formatHealResult } from "./commands/heal.js";

export type { HealEngineOptions, HealResult as HealEngineResult, MappingDecision } from "./commands/heal-engine.js";
export { heal } from "./commands/heal-engine.js";

export type { ArchiveOptions, ArchiveResult } from "./commands/archive.js";
export { runArchive, formatArchiveResult } from "./commands/archive.js";

export type { DiffOptions, DiffResult, DiffEntry, FileAnalysisOptions, FileAnalysisResult, FileAnalysisStats } from "./commands/diff.js";
export { runDiff, formatDiffResult, runFileAnalysis, formatFileAnalysisResult } from "./commands/diff.js";

export type { BlameOptions, BlameResult, BlameLine } from "./commands/blame.js";
export { runBlame, formatBlameResult } from "./commands/blame.js";

export type { SearchOptions, SearchResult, SearchHit } from "./commands/search.js";
export { runSearch, formatSearchResult } from "./commands/search.js";

export type { RecallOptions, RecallResult } from "./commands/recall.js";
export { runRecall } from "./commands/recall.js";

export type { HygieneOptions, HygieneRunResult } from "./commands/hygiene.js";
export { runHygiene, formatHygieneResult } from "./commands/hygiene.js";

export type { ComprehendOptions, ComprehendResult } from "./commands/comprehend.js";
export { runComprehend, formatComprehendResult } from "./commands/comprehend.js";

export type { TourOptions, TourResult } from "./commands/tour.js";
export { runTour, formatTourResult } from "./commands/tour.js";

export type { ImpactOptions, ImpactRunResult } from "./commands/impact.js";
export { runImpact, formatImpactResult } from "./commands/impact.js";

export type { ArchitectureCliOptions, ArchitectureRunResult } from "./commands/architecture.js";
export { runArchitecture, formatArchitectureResult } from "./commands/architecture.js";

export type { AnnotateOptions, AnnotateResult, AnnotateLine } from "./commands/annotate.js";
export { runAnnotate, formatAnnotateResult } from "./commands/annotate.js";

export type { AiDetectionResult, CommitAiSignal, NewFileStat } from "./ai-detection/detect.js";
export { detectAiCommits, formatAiDetectionResult } from "./ai-detection/detect.js";

export type { RunOptions, RunResult, ChangedFile } from "./commands/run.js";
export { runRun, formatRunResult } from "./commands/run.js";

export { isSensitivePath, matchingSensitivePaths } from "./security/sensitive-paths.js";

export type { InstallHooksOptions, InstallHooksResult } from "./commands/install-hooks.js";
export { runInstallHooks, formatInstallHooksResult } from "./commands/install-hooks.js";

export type { InstallCiOptions, InstallCiResult } from "./commands/install-ci.js";
export { runInstallCi, formatInstallCiResult, CI_PLATFORMS } from "./commands/install-ci.js";
export type { CiPlatform } from "./ci-templates/index.js";

export type { ExportOptions, ExportResult } from "./commands/export.js";
export { runExport, formatExportResult } from "./commands/export.js";

export type {
  MemoryBankOptions,
  MemoryBankResult,
  MemoryFileResult,
  MemoryFileAction,
} from "./commands/memory-bank.js";
export { runMemoryBank, renderMemoryBank, formatMemoryBankResult } from "./commands/memory-bank.js";

export type { PackOptions, PackResult } from "./commands/pack.js";
export { runPack, formatPackResult } from "./commands/pack.js";

export type { ViewOptions, ViewResult } from "./commands/view.js";
export { runView, serveView, buildViewHtml, formatViewResult, DEFAULT_VIEW_PORT } from "./commands/view.js";

export type { UiOptions, UiData, UiFile, UiEntry } from "./commands/ui.js";
export { runUi, serveUi, buildUiHtml, loadUiData, openBrowser, DEFAULT_UI_PORT } from "./commands/ui.js";

export type { MetricsOptions, MetricsResult, WeeklyPoint } from "./commands/metrics.js";
export { runMetrics, formatMetricsResult, isoWeek } from "./commands/metrics.js";

export type { AiProvider, AiProviderName, AiLayerConfig, AiLayerOptions } from "./commands/ai-layer.js";
export { resolveProvider, runAiLayer } from "./commands/ai-layer.js";

export type { ReportOptions, ReportResult, DebtEntry } from "./commands/report.js";
export { runReport, formatReportResult, debtScore, isEntrySnoozed } from "./commands/report.js";

export type { SnoozeOptions, SnoozeResult } from "./commands/snooze.js";
export { runSnooze, formatSnoozeResult } from "./commands/snooze.js";

export type { NudgeOptions, NudgeResult } from "./commands/nudge.js";
export { runNudge, formatNudgeResult } from "./commands/nudge.js";

export type { HealthOptions, HealthResult, KillSwitchSignal } from "./commands/health.js";
export { runHealth, formatHealthResult } from "./commands/health.js";

export type { EnrichOptions, EnrichResult, EnrichProgressEvent } from "./commands/enrich.js";
export { runEnrich, formatEnrichResult } from "./commands/enrich.js";

export type { SetupOptions, SetupResult, SetupAction } from "./commands/setup.js";
export { runSetup, formatSetupResult } from "./commands/setup.js";

export type { WatchOptions } from "./commands/watch.js";
export { runWatch } from "./commands/watch.js";

export type {
	WatchDetachOptions,
	WatchDetachResult,
	WatchStopResult,
	WatcherStatus,
} from "./commands/watch-daemon.js";
export {
	runWatchDetach,
	runWatchStop,
	runWatchStatus,
	installSupervisor,
	supervisorStatus,
	formatWatchDetachResult,
	formatWatchStopResult,
	formatWatchStatus,
	formatInstallSupervisorResult,
	formatSupervisorStatus,
} from "./commands/watch-daemon.js";

export type {
	McpStartOptions,
	McpStartResult,
	McpStatusOptions,
	McpStatusResult,
} from "./commands/mcp.js";
export { runMcpStart, runMcpStatus, formatMcpStart, formatMcpStatus } from "./commands/mcp.js";

export type { LinkOptions, LinkResult } from "./commands/link.js";
export { runLink, formatLinkResult } from "./commands/link.js";

export type { ContextOptions, ContextResult } from "./commands/context.js";
export { runContext, formatContextResultPretty } from "./commands/context.js";
