// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
export function buildkiteTemplate(): string {
  return `# Kodela context-coverage check — Buildkite
# Save as .buildkite/pipeline.yml (merge into an existing file or use as-is).
#
# ADVISORY vs ENFORCEMENT
# ─────────────────────────────────────────────────────────────────────────────
# Advisory mode (default): soft_fail: true keeps the step green on breaches.
# Enforcement mode: remove soft_fail and set kodela.config.json
#   "ci": { "enforcement": "enforcement" }
# ─────────────────────────────────────────────────────────────────────────────

steps:
  - label: ":kodela: Context Coverage Check"
    key: kodela-check
    command:
      - npm install -g @kodela/cli
      # Advisory mode — remove \`|| true\` for enforcement
      - kodela status --ci --output json | tee kodela-output.json || true
      - cat kodela-output.json
    artifact_paths:
      - kodela-output.json
    # Advisory mode — remove the next line to switch to enforcement
    soft_fail: true
    plugins:
      - docker#v5.0.0:
          image: "node:20"
`;
}
