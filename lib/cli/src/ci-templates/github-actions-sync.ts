// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors

/**
 * `kodela sync` GitHub Actions workflow — the authoritative central-sync job.
 *
 * Runs on every push to the default branch and pushes the repo's captured
 * context (`.kodela/`) to the central Kodela server. This is the deterministic
 * path that guarantees the org's shared memory reflects the merged state, even
 * when an individual developer's post-merge hook didn't fire.
 *
 * Requires two repository secrets:
 *   - KODELA_API_KEY  — the org API key (Bearer token).
 * And one of: the org license installed in the repo (kodela.license.json) OR
 *   - KODELA_ORG_ID   — the organization id sent as X-Kodela-Org-Id.
 * Plus `storage.server.url` in kodela.config.json (or set KODELA_SERVER_URL).
 */
export function githubActionsSyncTemplate(): string {
  return `# Kodela central sync
# Drop this file in .github/workflows/kodela-sync.yml
#
# Pushes this repo's captured context (.kodela/) to your central Kodela server
# on every push to the default branch, so the org dashboard + shared memory stay
# authoritative. Complements the local post-merge hook (\`kodela install-hooks --sync\`).
#
# SETUP (once):
#   1. Repo → Settings → Secrets and variables → Actions → add:
#        KODELA_API_KEY   (required) — your org API key
#        KODELA_ORG_ID    (unless the org license is committed) — your org id
#   2. Ensure kodela.config.json has storage.server.url (or set KODELA_SERVER_URL
#      as a repo variable below).

name: Kodela Sync

on:
  push:
    branches: [main, master]

# Never let two syncs race; the server upsert is idempotent so cancelling is safe.
concurrency:
  group: kodela-sync-\${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  sync:
    name: Push context to Kodela
    runs-on: ubuntu-latest
    # Skip on forks / PRs from forks where secrets aren't available.
    if: \${{ github.event_name == 'push' }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # full history so .kodela/ is complete

      - uses: actions/setup-node@v4
        with:
          node-version: '24'

      - name: Sync captured context to the central server
        env:
          KODELA_API_KEY: \${{ secrets.KODELA_API_KEY }}
          KODELA_ORG_ID: \${{ secrets.KODELA_ORG_ID }}
          KODELA_SERVER_URL: \${{ vars.KODELA_SERVER_URL }}
        run: |
          if [ -z "$KODELA_API_KEY" ]; then
            echo "::warning::KODELA_API_KEY secret not set — skipping Kodela sync."
            exit 0
          fi
          # --server falls back to storage.server.url in kodela.config.json when
          # KODELA_SERVER_URL is unset.
          npx -y @kodela/cli sync \${KODELA_SERVER_URL:+--server "$KODELA_SERVER_URL"}
`;
}
