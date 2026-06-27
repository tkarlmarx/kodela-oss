// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import fs from "node:fs";
import path from "node:path";
import type { ScoringWeights, ExpansionConfig } from "./types.js";
import { DEFAULT_WEIGHTS, DEFAULT_EXPANSION_CONFIG } from "./types.js";

export type ContextConfig = {
  scoring: ScoringWeights;
  expansion: ExpansionConfig;
};

type RawConfig = {
  scoring?: Partial<ScoringWeights>;
  expansion?: Partial<Omit<ExpansionConfig, "expansionDepth"> & { expansionDepth?: number }>;
};

function validateWeights(weights: ScoringWeights, configPath: string): void {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1.0) > 0.001) {
    throw new Error(
      `[kodela] context.config.json scoring weights must sum to 1.0 (got ${sum.toFixed(4)}) in ${configPath}`,
    );
  }
}

export function loadContextConfig(repoRoot: string): ContextConfig {
  const configPath = path.join(repoRoot, ".kodela", "context.config.json");
  if (!fs.existsSync(configPath)) {
    return { scoring: DEFAULT_WEIGHTS, expansion: DEFAULT_EXPANSION_CONFIG };
  }

  let raw: RawConfig;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as RawConfig;
  } catch {
    throw new Error(`[kodela] Failed to parse context.config.json at ${configPath}`);
  }

  const scoring: ScoringWeights = {
    ...DEFAULT_WEIGHTS,
    ...(raw.scoring ?? {}),
  };
  validateWeights(scoring, configPath);

  const rawExp = raw.expansion ?? {};
  const depth = rawExp.expansionDepth;
  const expansion: ExpansionConfig = {
    ...DEFAULT_EXPANSION_CONFIG,
    ...rawExp,
    expansionDepth: depth === 1 || depth === 2 ? depth : DEFAULT_EXPANSION_CONFIG.expansionDepth,
  };

  return { scoring, expansion };
}
