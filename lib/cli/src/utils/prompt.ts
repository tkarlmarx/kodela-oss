// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export type PromptInterface = {
  question(prompt: string): Promise<string>;
  close(): void;
};

export function createPrompt(): PromptInterface {
  const rl = readline.createInterface({ input, output });
  return {
    question: (prompt: string) => rl.question(prompt),
    close: () => rl.close(),
  };
}

export async function promptRequired(
  prompt: PromptInterface,
  message: string,
): Promise<string> {
  let value = "";
  while (!value.trim()) {
    value = await prompt.question(`${message}: `);
    if (!value.trim()) {
      process.stdout.write("  (required — cannot be empty)\n");
    }
  }
  return value.trim();
}

export async function promptOptional(
  prompt: PromptInterface,
  message: string,
  defaultValue: string,
): Promise<string> {
  const value = await prompt.question(`${message} [${defaultValue}]: `);
  return value.trim() || defaultValue;
}
