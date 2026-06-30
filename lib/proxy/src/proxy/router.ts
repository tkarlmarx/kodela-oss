// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { ProxyConfig, ProviderConfig } from "../config/loader.js";
import { DEFAULT_PROVIDERS } from "../config/defaults.js";

export function resolveProvider(model: string, config: ProxyConfig): ProviderConfig {
  const providers = config.providers.length > 0 ? config.providers : DEFAULT_PROVIDERS;

  for (const provider of providers) {
    if (provider.models.some((prefix) => model.startsWith(prefix))) {
      return provider;
    }
  }

  return providers[0]!;
}

export function resolveApiKey(provider: ProviderConfig): string {
  return process.env[provider.apiKeyEnvVar] ?? "";
}
