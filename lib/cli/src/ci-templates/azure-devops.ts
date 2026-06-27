// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
export function azureDevOpsTemplate(): string {
  return `# Kodela context-coverage check — Azure DevOps Pipelines
# Save as azure-pipelines.yml (merge into an existing file or use as-is).
#
# ADVISORY vs ENFORCEMENT
# ─────────────────────────────────────────────────────────────────────────────
# Advisory mode (default): continueOnError: true keeps the step green.
# Enforcement mode: set continueOnError: false and set kodela.config.json
#   "ci": { "enforcement": "enforcement" }
# ─────────────────────────────────────────────────────────────────────────────

trigger:
  branches:
    include:
      - main
      - master

pr:
  branches:
    include:
      - main
      - master

pool:
  vmImage: 'ubuntu-latest'

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '20.x'
    displayName: 'Install Node.js'

  - script: npm install -g @kodela/cli
    displayName: 'Install Kodela CLI'

  - script: kodela status --ci --output json | tee kodela-output.json
    displayName: 'Run Kodela status check'
    # Advisory mode — set to false for enforcement
    continueOnError: true

  - task: PublishBuildArtifacts@1
    inputs:
      pathToPublish: 'kodela-output.json'
      artifactName: 'kodela-report'
    displayName: 'Publish Kodela report'
    condition: always()
`;
}
