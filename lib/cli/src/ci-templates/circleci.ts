// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export function circleciTemplate(): string {
  return `# Kodela context-coverage check — CircleCI
# Save as .circleci/config.yml (merge into an existing file or use as-is).
#
# ADVISORY vs ENFORCEMENT
# ─────────────────────────────────────────────────────────────────────────────
# Advisory mode (default): the \`|| true\` keeps the job green on breaches.
# Enforcement mode: remove \`|| true\` and set kodela.config.json
#   "ci": { "enforcement": "enforcement" }
# ─────────────────────────────────────────────────────────────────────────────

version: 2.1

jobs:
  kodela-check:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
      - run:
          name: Install Kodela CLI
          command: npm install -g @kodela/cli
      - run:
          name: Run Kodela status check
          # Advisory mode — remove \`|| true\` for enforcement
          command: kodela status --ci --output json | tee kodela-output.json || true
      - store_artifacts:
          path: kodela-output.json

workflows:
  version: 2
  ci:
    jobs:
      - kodela-check
`;
}
