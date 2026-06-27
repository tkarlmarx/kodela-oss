// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { fileExists } from "../utils/repo.js";
import {
  CI_PLATFORMS,
  CI_PLATFORM_LABELS,
  CI_OUTPUT_PATHS,
  githubActionsTemplate,
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
};

export type InstallCiResult = {
  platform: CiPlatform;
  outputPath: string;
  installed: boolean;
  skipped: boolean;
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
  const { repoRoot, platform, config, force = false } = opts;

  const relOutputPath = CI_OUTPUT_PATHS[platform];
  const absOutputPath = path.join(repoRoot, relOutputPath);

  const already = await fileExists(absOutputPath);
  if (already && !force) {
    return {
      platform,
      outputPath: relOutputPath,
      installed: false,
      skipped: true,
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
