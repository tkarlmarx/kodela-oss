// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { ProxyConfig, ProviderConfig } from "./loader.js";

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    name: "openai",
    baseUrl: "https://api.openai.com",
    apiKeyEnvVar: "OPENAI_API_KEY",
    models: ["gpt-", "o1-", "o3-", "text-embedding-"],
  },
  {
    name: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    models: ["claude-"],
  },
];

export const DEFAULT_CONFIG: ProxyConfig = {
  port: 4200,
  host: "127.0.0.1",
  sessionTimeoutMs: 300_000,
  providers: DEFAULT_PROVIDERS,
  logLevel: "info",
  kodela: {
    sessionsDir: ".kodela/sessions",
  },
};
