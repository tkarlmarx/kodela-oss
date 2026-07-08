// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export { githubActionsTemplate } from "./github-actions.js";
export { githubActionsSyncTemplate } from "./github-actions-sync.js";
export { gitlabCiTemplate } from "./gitlab-ci.js";
export { bitbucketPipelinesTemplate } from "./bitbucket-pipelines.js";
export { circleciTemplate } from "./circleci.js";
export { jenkinsTemplate } from "./jenkins.js";
export { azureDevOpsTemplate } from "./azure-devops.js";
export { travisCiTemplate } from "./travis-ci.js";
export { buildkiteTemplate } from "./buildkite.js";
export { teamcityTemplate } from "./teamcity.js";

export type CiPlatform =
  | "github"
  | "gitlab"
  | "bitbucket"
  | "circleci"
  | "jenkins"
  | "azure-devops"
  | "travis"
  | "buildkite"
  | "teamcity";

export const CI_PLATFORMS: CiPlatform[] = [
  "github",
  "gitlab",
  "bitbucket",
  "circleci",
  "jenkins",
  "azure-devops",
  "travis",
  "buildkite",
  "teamcity",
];

export const CI_PLATFORM_LABELS: Record<CiPlatform, string> = {
  github: "GitHub Actions",
  gitlab: "GitLab CI",
  bitbucket: "Bitbucket Pipelines",
  circleci: "CircleCI",
  jenkins: "Jenkins",
  "azure-devops": "Azure DevOps",
  travis: "Travis CI",
  buildkite: "Buildkite",
  teamcity: "TeamCity",
};

export const CI_OUTPUT_PATHS: Record<CiPlatform, string> = {
  github: ".github/workflows/kodela.yml",
  gitlab: ".gitlab-ci-kodela.yml",
  bitbucket: "bitbucket-pipelines.yml",
  circleci: ".circleci/config.yml",
  jenkins: "Jenkinsfile",
  "azure-devops": "azure-pipelines.yml",
  travis: ".travis.yml",
  buildkite: ".buildkite/pipeline.yml",
  teamcity: ".teamcity/KodelaContextCheck.kts",
};
