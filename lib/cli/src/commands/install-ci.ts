// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { fileExists } from "../utils/repo.js";
import {
  CI_PLATFORMS,
  CI_PLATFORM_LABELS,
  CI_OUTPUT_PATHS,
  githubActionsTemplate,
  githubActionsSyncTemplate,
  gitlabCiTemplate,
  bitbucketPipelinesTemplate,
  circleciTemplate,
  jenkinsTemplate,
  azureDevOpsTemplate,
  travisCiTemplate,
  buildkiteTemplate,
  teamcityTemplate,
  type CiPlatform,
} from "../ci-templates/index.js";
import type { KodelaConfig } from "../config/schema.js";

export { CI_PLATFORMS, type CiPlatform };

export type InstallCiOptions = {
  repoRoot: string;
  platform: CiPlatform;
  config: KodelaConfig;
  force?: boolean;
  /**
   * Emit the central-sync workflow (push .kodela/ to the server on push to the
   * default branch) instead of the advisory coverage-check workflow. Currently
   * GitHub Actions only; other platforms should adapt the one-liner from
   * docs/enterprise-deployment.md.
   */
  sync?: boolean;
};

export type InstallCiResult = {
  platform: CiPlatform;
  outputPath: string;
  installed: boolean;
  skipped: boolean;
  /** True when this run emitted the central-sync workflow (via --sync). */
  sync: boolean;
};

/** Where the central-sync workflow lands (separate from the coverage check). */
const SYNC_OUTPUT_PATHS: Partial<Record<CiPlatform, string>> = {
  github: ".github/workflows/kodela-sync.yml",
};

function getTemplate(platform: CiPlatform, config: KodelaConfig): string {
  const enforcement = config.ci.enforcement;
  switch (platform) {
    case "github":
      return githubActionsTemplate(enforcement);
    case "gitlab":
      return gitlabCiTemplate();
    case "bitbucket":
      return bitbucketPipelinesTemplate();
    case "circleci":
      return circleciTemplate();
    case "jenkins":
      return jenkinsTemplate();
    case "azure-devops":
      return azureDevOpsTemplate();
    case "travis":
      return travisCiTemplate();
    case "buildkite":
      return buildkiteTemplate();
    case "teamcity":
      return teamcityTemplate();
  }
}

export async function runInstallCi(
  opts: InstallCiOptions,
): Promise<InstallCiResult> {
  const { repoRoot, platform, config, force = false, sync = false } = opts;

  if (sync) {
    const syncPath = SYNC_OUTPUT_PATHS[platform];
    if (!syncPath) {
      throw new Error(
        `--sync currently supports GitHub Actions only. For ${CI_PLATFORM_LABELS[platform]}, ` +
          `add a job that runs \`kodela sync\` on push to your default branch — see docs/enterprise-deployment.md.`,
      );
    }
    const absSyncPath = path.join(repoRoot, syncPath);
    if ((await fileExists(absSyncPath)) && !force) {
      return { platform, outputPath: syncPath, installed: false, skipped: true, sync: true };
    }
    await fs.mkdir(path.dirname(absSyncPath), { recursive: true });
    await fs.writeFile(absSyncPath, githubActionsSyncTemplate(), "utf-8");
    return { platform, outputPath: syncPath, installed: true, skipped: false, sync: true };
  }

  const relOutputPath = CI_OUTPUT_PATHS[platform];
  const absOutputPath = path.join(repoRoot, relOutputPath);

  const already = await fileExists(absOutputPath);
  if (already && !force) {
    return {
      platform,
      outputPath: relOutputPath,
      installed: false,
      skipped: true,
      sync: false,
    };
  }

  await fs.mkdir(path.dirname(absOutputPath), { recursive: true });
  const content = getTemplate(platform, config);
  await fs.writeFile(absOutputPath, content, "utf-8");

  return {
    platform,
    outputPath: relOutputPath,
    installed: true,
    skipped: false,
    sync: false,
  };
}

export function formatInstallCiResult(result: InstallCiResult): string {
  const label = CI_PLATFORM_LABELS[result.platform];

  if (result.skipped) {
    return [
      `⚠ Skipped — ${result.outputPath} already exists.`,
      `  Use --force to overwrite.`,
    ].join("\n");
  }

  if (result.sync) {
    return [
      `✓ Created ${result.outputPath}`,
      ``,
      `  Central-sync workflow — pushes .kodela/ to your server on push to main.`,
      ``,
      `  Next steps:`,
      `    1. Add repo secrets: KODELA_API_KEY (required), KODELA_ORG_ID`,
      `       (unless the org license is committed).`,
      `    2. Ensure kodela.config.json has storage.server.url (or set the`,
      `       KODELA_SERVER_URL repo variable).`,
      `    3. Commit ${result.outputPath}.`,
    ].join("\n");
  }

  const lines = [
    `✓ Created ${result.outputPath}`,
    ``,
    `  Platform : ${label}`,
    `  Mode     : advisory (warns on breaches, never fails the build)`,
    ``,
    `  To switch to enforcement mode:`,
    `    1. Set "ci": { "enforcement": "enforcement" } in kodela.config.json`,
    `    2. Follow the inline comment in ${result.outputPath} to remove the`,
    `       \`|| true\` / \`soft_fail\` / \`continueOnError\` escape hatches.`,
    ``,
    `  Commit ${result.outputPath} to your repository to activate the check.`,
  ];

  return lines.join("\n");
}
