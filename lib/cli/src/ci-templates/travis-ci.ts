// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export function travisCiTemplate(): string {
  return `# Kodela context-coverage check — Travis CI
# Save as .travis.yml (merge into an existing file or use as-is).
#
# ADVISORY vs ENFORCEMENT
# ─────────────────────────────────────────────────────────────────────────────
# Advisory mode (default): the trailing \`|| true\` keeps the job green.
# Enforcement mode: remove \`|| true\` and set kodela.config.json
#   "ci": { "enforcement": "enforcement" }
# ─────────────────────────────────────────────────────────────────────────────

language: node_js
node_js:
  - '20'

jobs:
  include:
    - name: Kodela Context Check
      install:
        - npm install -g @kodela/cli
      script:
        # Advisory mode — remove \`|| true\` for enforcement
        - kodela status --ci --output json | tee kodela-output.json || true
      after_success:
        - cat kodela-output.json
`;
}
