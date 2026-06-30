// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export function gitlabCiTemplate(): string {
  return `# Kodela context-coverage check — GitLab CI snippet
# Add this to your .gitlab-ci.yml (merge into an existing file or use as-is).
#
# ADVISORY vs ENFORCEMENT
# ─────────────────────────────────────────────────────────────────────────────
# Advisory mode (default): the job always exits 0 — it posts an MR note but
# never fails the pipeline.
#
# Enforcement mode: change "enforcement" in kodela.config.json to "enforcement".
# In that mode, \`kodela status --ci\` exits 1 on threshold breaches, which
# fails this job and can be set as a required check for protected branches.
# ─────────────────────────────────────────────────────────────────────────────

stages:
  - test
  - kodela

variables:
  KODELA_VERSION: "latest"

kodela-check:
  stage: kodela
  image: node:20-slim
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH == "main" || $CI_COMMIT_BRANCH == "master"'
  before_script:
    - npm install -g @kodela/cli@\${KODELA_VERSION}
  script:
    # Run status check — exit code drives advisory vs enforcement behaviour.
    # In advisory mode the \`|| true\` keeps the job green even on breaches.
    # Remove \`|| true\` to switch to enforcement.
    - kodela status --ci --output json > kodela-output.json || true
    - cat kodela-output.json
    - |
      # Post MR comment via GitLab API if we are in an MR pipeline
      if [ -n "\${CI_MERGE_REQUEST_IID}" ] && [ -n "\${GITLAB_TOKEN}" ]; then
        REPORT=\$(cat kodela-output.json)
        TOTAL=\$(echo "\${REPORT}" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(String(d.total||0))")
        MAPPED=\$(echo "\${REPORT}" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(String(d.mapped||0))")
        SCORE=\$(echo "\${REPORT}" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write(((d.confidence_score||0)*100).toFixed(1)+'%')")
        ORPHANED=\$(echo "\${REPORT}" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));process.stdout.write((d.orphaned_pct||0).toFixed(1)+'%')")

        BODY="## Kodela Context Coverage\\n\\n| Metric | Value |\\n|--------|-------|\\n| Total entries | \${TOTAL} |\\n| Mapped | \${MAPPED} |\\n| Confidence score | \${SCORE} |\\n| Orphaned | \${ORPHANED} |"

        curl --silent --request POST \\
          --header "PRIVATE-TOKEN: \${GITLAB_TOKEN}" \\
          --header "Content-Type: application/json" \\
          --data "{\\"body\\": \\"\${BODY}\\"}" \\
          "\${CI_API_V4_URL}/projects/\${CI_PROJECT_ID}/merge_requests/\${CI_MERGE_REQUEST_IID}/notes"
      fi
  artifacts:
    paths:
      - kodela-output.json
    expire_in: 7 days
  allow_failure: true   # ← remove this line to switch to enforcement mode
`;
}
