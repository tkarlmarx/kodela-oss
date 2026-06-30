// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_CONFIG } from "./defaults.js";

export type ProviderName = "openai" | "anthropic" | "azure-openai" | "openrouter" | "custom";

export interface ProviderConfig {
  name: ProviderName;
  baseUrl: string;
  apiKeyEnvVar: string;
  models: string[];
}

export interface ProxyConfig {
  port: number;
  host: string;
  sessionTimeoutMs: number;
  providers: ProviderConfig[];
  logLevel: "debug" | "info" | "warn" | "error";
  kodela: {
    sessionsDir: string;
    projectId?: string;
  };
}

const CONFIG_PATH = ".kodela/proxy.config.yaml";

const DEFAULT_YAML = `port: 4200
host: "127.0.0.1"
sessionTimeoutMs: 300000

providers:
  - name: openai
    baseUrl: "https://api.openai.com"
    apiKeyEnvVar: "OPENAI_API_KEY"
    models: ["gpt-", "o1-", "o3-", "text-embedding-"]
  - name: anthropic
    baseUrl: "https://api.anthropic.com"
    apiKeyEnvVar: "ANTHROPIC_API_KEY"
    models: ["claude-"]

kodela:
  sessionsDir: ".kodela/sessions"

logLevel: "info"
`;

export async function loadConfig(): Promise<ProxyConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    const parsed = parseYaml(raw) as Partial<ProxyConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      kodela: { ...DEFAULT_CONFIG.kodela, ...(parsed.kodela ?? {}) },
      providers: parsed.providers ?? DEFAULT_CONFIG.providers,
    };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      await writeDefaultConfig();
    }
    return { ...DEFAULT_CONFIG };
  }
}

async function writeDefaultConfig(): Promise<void> {
  try {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, DEFAULT_YAML, "utf-8");
  } catch {
  }
}
