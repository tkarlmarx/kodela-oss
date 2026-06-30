// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export function jenkinsTemplate(): string {
  return `// Kodela context-coverage check — Jenkins Declarative Pipeline
// Add this as a Jenkinsfile or merge into your existing one.
//
// ADVISORY vs ENFORCEMENT
// ─────────────────────────────────────────────────────────────────────────────
// Advisory mode (default): \`|| true\` keeps the stage green on breaches.
// Enforcement mode: remove \`|| true\` and set kodela.config.json
//   "ci": { "enforcement": "enforcement" }
// ─────────────────────────────────────────────────────────────────────────────

pipeline {
    agent {
        docker { image 'node:20' }
    }

    stages {
        stage('Kodela Context Check') {
            steps {
                sh 'npm install -g @kodela/cli'
                // Advisory mode — remove \`|| true\` for enforcement
                sh 'kodela status --ci --output json | tee kodela-output.json || true'
            }
            post {
                always {
                    archiveArtifacts artifacts: 'kodela-output.json', allowEmptyArchive: true
                }
            }
        }
    }
}
`;
}
