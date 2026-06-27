// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
export function teamcityTemplate(): string {
  return `// Kodela context-coverage check — TeamCity Kotlin DSL
// Add this build step to your existing .teamcity/settings.kts or create a new one.
//
// ADVISORY vs ENFORCEMENT
// ─────────────────────────────────────────────────────────────────────────────
// Advisory mode (default): failureConditions block is commented out.
// Enforcement mode: uncomment the failureConditions block below and set
//   "ci": { "enforcement": "enforcement" } in kodela.config.json
// ─────────────────────────────────────────────────────────────────────────────

import jetbrains.buildServer.configs.kotlin.*
import jetbrains.buildServer.configs.kotlin.buildSteps.script

object KodelaContextCheck : BuildType({
    name = "Kodela Context Check"

    vcs {
        root(DslContext.settingsRoot)
    }

    steps {
        script {
            name = "Install Kodela CLI"
            scriptContent = "npm install -g @kodela/cli"
        }
        script {
            name = "Run Kodela status"
            // Advisory mode — remove \`|| true\` for enforcement
            scriptContent = "kodela status --ci --output json | tee kodela-output.json || true"
        }
    }

    // Enforcement mode: uncomment the following to fail on threshold breaches
    // failureConditions {
    //     nonZeroExitCode = true
    // }

    artifactRules = "kodela-output.json"
})
`;
}
