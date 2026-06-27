// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
export function bitbucketPipelinesTemplate(): string {
  return `# Kodela context-coverage check — Bitbucket Pipelines
# Save as bitbucket-pipelines.yml (merge into an existing file or use as-is).
#
# ADVISORY vs ENFORCEMENT
# ─────────────────────────────────────────────────────────────────────────────
# Advisory mode (default): \`|| true\` keeps the step green even on breaches.
# Enforcement mode: remove \`|| true\` and set your kodela.config.json
#   "ci": { "enforcement": "enforcement" }
# ─────────────────────────────────────────────────────────────────────────────

image: node:20

pipelines:
  default:
    - step:
        name: Kodela Context Check
        script:
          - npm install -g @kodela/cli
          # Advisory mode — remove \`|| true\` for enforcement
          - kodela status --ci --output json | tee kodela-output.json || true
        artifacts:
          - kodela-output.json

  pull-requests:
    '**':
      - step:
          name: Kodela Context Check (PR)
          script:
            - npm install -g @kodela/cli
            - kodela status --ci --output json | tee kodela-output.json || true
          artifacts:
            - kodela-output.json
`;
}
