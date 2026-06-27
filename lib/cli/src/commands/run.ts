// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  writeContextEntry,
  hashTokenStream,
  SCHEMA_VERSION,
  readOriginSidecar,
  runAttributionPipeline,
  isMeaningfulChange,
  AnnotationDeduplicator,
} from "@kodela/core";
import type { ContextEntry, Origin } from "@kodela/core";
import { computeDiff } from "@kodela/diff";
import { isSensitivePath } from "../security/sensitive-paths.js";
import type { KodelaConfig } from "../config/schema.js";

const execFileAsync = promisify(execFile);

export type RunOptions = {
  repoRoot: string;
  command: string[];
  config: KodelaConfig;
  autoAnnotate?: boolean;
  note?: string;
};

export type ChangedFile = {
  filePath: string;
  linesAdded: number;
  linesDeleted: number;
  securityFlagged: boolean;
  entryId?: string;
};

export type RunResult = {
  command: string;
  exitCode: number;
  changedFiles: ChangedFile[];
  annotationsCreated: number;
};

type FileSnapshot = Map<string, { hash: string; lineCount: number }>;

async function snapshotDir(repoRoot: string): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = new Map();
  const queue: string[] = [repoRoot];

  const SKIP = new Set([
    ".kodela",
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "coverage",
  ]);

  while (queue.length > 0) {
    const dir = queue.shift()!;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (SKIP.has(name)) continue;
      const full = path.join(dir, name);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        queue.push(full);
      } else if (stat.isFile()) {
        try {
          const content = await fs.readFile(full, "utf-8");
          const lineCount = content.split("\n").length;
          snapshot.set(full, {
            hash: hashTokenStream(content),
            lineCount,
          });
        } catch {
          // binary files — skip
        }
      }
    }
  }

  return snapshot;
}

function diffSnapshots(
  before: FileSnapshot,
  after: FileSnapshot,
  repoRoot: string,
): Array<{ filePath: string; linesAdded: number; linesDeleted: number }> {
  const changed: Array<{
    filePath: string;
    linesAdded: number;
    linesDeleted: number;
  }> = [];

  for (const [absPath, afterInfo] of after) {
    const beforeInfo = before.get(absPath);
    if (!beforeInfo) {
      const relPath = path.relative(repoRoot, absPath).replace(/\\/g, "/");
      changed.push({
        filePath: relPath,
        linesAdded: afterInfo.lineCount,
        linesDeleted: 0,
      });
    } else if (beforeInfo.hash !== afterInfo.hash) {
      const relPath = path.relative(repoRoot, absPath).replace(/\\/g, "/");
      const diff = afterInfo.lineCount - beforeInfo.lineCount;
      changed.push({
        filePath: relPath,
        linesAdded: Math.max(0, diff),
        linesDeleted: Math.max(0, -diff),
      });
    }
  }

  for (const absPath of before.keys()) {
    if (!after.has(absPath)) {
      const relPath = path.relative(repoRoot, absPath).replace(/\\/g, "/");
      const beforeInfo = before.get(absPath)!;
      changed.push({
        filePath: relPath,
        linesAdded: 0,
        linesDeleted: beforeInfo.lineCount,
      });
    }
  }

  return changed;
}

function runProcess(
  command: string[],
  cwd: string,
): Promise<{ exitCode: number }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = command;
    if (!cmd) {
      resolve({ exitCode: 1 });
      return;
    }
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 0 });
    });
    child.on("error", () => {
      resolve({ exitCode: 1 });
    });
  });
}

/** Fetch the pre-command content of a file from git HEAD (for hunk diffing). */
async function getBeforeContent(
  repoRoot: string,
  relPath: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["show", `HEAD:${relPath}`], {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

/** Module-level deduplicator (persists across calls within the same process). */
const _runDedup = new AnnotationDeduplicator(30_000);

export async function runRun(opts: RunOptions): Promise<RunResult> {
  const { repoRoot, command, config, autoAnnotate = false, note } = opts;
  const sensitivePatterns = config.security.sensitive_paths;
  const captureReasoning = config.origin.capture_reasoning;

  const before = await snapshotDir(repoRoot);
  const { exitCode } = await runProcess(command, repoRoot);
  const after = await snapshotDir(repoRoot);

  // Read sidecar ONCE after the command exits (Gap 13).
  // Also feed it into the attribution pipeline (Gap 15b).
  const sidecar = autoAnnotate ? await readOriginSidecar(repoRoot) : null;

  // Run attribution pipeline once for the whole batch (Gap 15b).
  const attribution = autoAnnotate
    ? await runAttributionPipeline({
        repoRoot,
        sidecar,
        totalAddedLines: 0,
        batchSize: 0,
        skipGitTrailer: false,
      })
    : null;

  const diffs = diffSnapshots(before, after, repoRoot);

  const changedFiles: ChangedFile[] = [];
  let annotationsCreated = 0;

  for (const diff of diffs) {
    const securityFlagged = isSensitivePath(diff.filePath, sensitivePatterns);
    const changedFile: ChangedFile = {
      ...diff,
      securityFlagged,
    };

    if (autoAnnotate && diff.linesAdded > 0) {
      // Intent filter (Gap 15b) — skip lock files, generated files, etc.
      if (!isMeaningfulChange(diff.filePath, diff.linesAdded, diff.linesDeleted, 0.5)) {
        changedFiles.push(changedFile);
        continue;
      }

      const absPath = path.join(repoRoot, diff.filePath);
      let afterContent: string;
      let lineCount = 1;
      try {
        afterContent = await fs.readFile(absPath, "utf-8");
        lineCount = afterContent.split("\n").length;
      } catch {
        changedFiles.push(changedFile);
        continue;
      }

      const contentHash = hashTokenStream(afterContent);

      // Deduplication check (Gap 15b) — skip if we annotated this content recently.
      if (_runDedup.isDuplicate(diff.filePath, contentHash)) {
        changedFiles.push(changedFile);
        continue;
      }

      // Hunk-level diffing (Gap 15b).
      const beforeContent = await getBeforeContent(repoRoot, diff.filePath);
      const diffResult = computeDiff({
        oldContent: beforeContent,
        newContent: afterContent,
      });

      // Collect hunks to annotate (added + modified only).
      const annotationHunks = [
        ...diffResult.added.map((h) => ({
          range: h.newRange ?? ([1, lineCount] as [number, number]),
          hash: h.contentHash ?? contentHash,
        })),
        ...diffResult.modified.map((h) => ({
          range: h.newRange ?? ([1, lineCount] as [number, number]),
          hash: h.contentHash ?? contentHash,
        })),
      ];

      // Fall back to a whole-file entry when no hunks were parsed.
      const hunks =
        annotationHunks.length > 0
          ? annotationHunks
          : [{ range: [1, lineCount] as [number, number], hash: contentHash }];

      const aiTool = attribution?.aiTool ?? undefined;
      const attributionConfidence = attribution?.attributionConfidence ?? undefined;
      const canUpgradeAttribution = attribution?.canUpgradeAttribution ?? true;

      // Build origin block from attribution + sidecar.
      // SidecarData has typed fields: aiTool, tool, model, sessionId, summary, reasoning.
      const origin: Origin | undefined =
        aiTool != null || sidecar != null
          ? {
              type: "ai",
              tool: aiTool ?? sidecar?.aiTool ?? sidecar?.tool,
              model: sidecar?.model,
              sessionId: attribution?.sessionId ?? sidecar?.sessionId,
              summary: sidecar?.summary,
              reasoning: captureReasoning ? sidecar?.reasoning : undefined,
            }
          : undefined;

      const now = new Date().toISOString();
      let firstEntryId: string | undefined;

      for (const hunk of hunks) {
        const [hunkStart, hunkEnd] = hunk.range;
        const entryId = crypto.randomUUID();
        const entry: ContextEntry = {
          schemaVersion: SCHEMA_VERSION,
          id: entryId,
          filePath: diff.filePath,
          astAnchor: null,
          contentHash: hunk.hash,
          lineRange: { start: hunkStart, end: Math.max(hunkStart, hunkEnd) },
          note: note ?? `Modified by: ${command.join(" ")}`,
          author:
            process.env["KODELA_AUTHOR"] ??
            process.env["GIT_AUTHOR_NAME"] ??
            "unknown",
          createdAt: now,
          updatedAt: now,
          severity: securityFlagged ? "high" : "low",
          tags: securityFlagged ? ["ai", "security-sensitive"] : ["ai"],
          source: "ai",
          confidence: 1.0,
          ...(attributionConfidence !== undefined ? { attributionConfidence } : {}),
          ...(canUpgradeAttribution !== true ? { canUpgradeAttribution } : {}),
          ...(aiTool ? { aiTool } : {}),
          status: "mapped",
          reviewRequired: true,
          ...(origin ? { origin } : {}),
        };

        try {
          await writeContextEntry(repoRoot, entry);
          firstEntryId ??= entryId;
          annotationsCreated++;
        } catch {
          // best-effort
        }
      }

      _runDedup.record(diff.filePath, contentHash);
      changedFile.entryId = firstEntryId;
    }

    changedFiles.push(changedFile);
  }

  return {
    command: command.join(" "),
    exitCode,
    changedFiles,
    annotationsCreated,
  };
}

export function formatRunResult(result: RunResult): string {
  const lines: string[] = [
    `Command: ${result.command}`,
    `Exit code: ${result.exitCode}`,
    `Changed files: ${result.changedFiles.length}`,
  ];

  if (result.annotationsCreated > 0) {
    lines.push(`Annotations created: ${result.annotationsCreated}`);
  }

  if (result.changedFiles.length > 0) {
    lines.push("");
    for (const f of result.changedFiles) {
      const security = f.securityFlagged ? " [⚠ security-sensitive]" : "";
      const annotated = f.entryId ? " ✓ annotated" : "";
      lines.push(
        `  ${f.filePath}  +${f.linesAdded}/-${f.linesDeleted}${security}${annotated}`,
      );
    }
  }

  return lines.join("\n");
}
