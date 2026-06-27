// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
export function githubActionsTemplate(enforcement: "advisory" | "enforcement"): string {
  const failOnWarnings = enforcement === "enforcement";
  return `# Kodela context-coverage check
# Drop this file in .github/workflows/kodela.yml
#
# ADVISORY vs ENFORCEMENT
# ─────────────────────────────────────────────────────────────────────────────
# By default this workflow runs in advisory mode: it posts a PR summary comment
# showing context health but never fails the build.
#
# To switch to enforcement mode, change the "enforcement" value in your
# kodela.config.json:
#
#   {
#     "ci": {
#       "enforcement": "enforcement"   ← change "advisory" to "enforcement"
#     }
#   }
#
# In enforcement mode \`kodela status --ci\` exits 1 when thresholds are breached,
# which causes the workflow step — and the required check — to fail.
# ─────────────────────────────────────────────────────────────────────────────

name: Kodela Context Check

on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches: [main, master]

permissions:
  contents: read
  pull-requests: write

jobs:
  kodela-check:
    name: Context Coverage
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm install -g @kodela/cli

      - name: Run Kodela status
        id: kodela
        # \`|| true\` keeps the step green in advisory mode when thresholds are
        # breached.  In enforcement mode, remove \`|| true\` so the step fails.
        run: |
          kodela status --ci --output json > kodela-output.json${failOnWarnings ? "" : " || true"}
          cat kodela-output.json

      - name: Post PR comment
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            let report;
            try {
              report = JSON.parse(fs.readFileSync('kodela-output.json', 'utf8'));
            } catch {
              report = null;
            }

            const icon = (report && report.ci_pass !== false) ? '✅' : '⚠️';
            const lines = [
              \`## \${icon} Kodela Context Coverage\`,
              '',
              '| Metric | Value |',
              '|--------|-------|',
            ];

            if (report) {
              lines.push(\`| Total entries | \${report.total} |\`);
              lines.push(\`| Mapped | \${report.mapped} |\`);
              lines.push(\`| Uncertain | \${report.uncertain} |\`);
              lines.push(\`| Orphaned | \${report.orphaned} (\${report.orphaned_pct?.toFixed(1)}%) |\`);
              lines.push(\`| Confidence score | \${(report.confidence_score * 100).toFixed(1)}% |\`);
              lines.push(\`| Unresolved critical | \${report.unresolved_critical_pct?.toFixed(1)}% |\`);

              if (report._breachedThresholds && report._breachedThresholds.length > 0) {
                lines.push('');
                lines.push('**Threshold breaches:**');
                for (const breach of report._breachedThresholds) {
                  lines.push(\`- ⚠️ \${breach.message}\`);
                }
              }
            } else {
              lines.push('| Status | Could not parse output |');
            }

            const body = lines.join('\\n');
            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
            });

            const existing = comments.find(c =>
              c.user.login === 'github-actions[bot]' &&
              c.body.includes('Kodela Context Coverage')
            );

            if (existing) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                comment_id: existing.id,
                body,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                body,
              });
            }
`;
}
