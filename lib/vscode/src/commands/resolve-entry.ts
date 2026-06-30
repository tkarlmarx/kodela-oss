// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { ContextEntry } from "@kodela/core";

export function resolveEntry(arg: unknown): ContextEntry | undefined {
  if (!arg || typeof arg !== "object") return undefined;
  const obj = arg as Record<string, unknown>;
  if ("entry" in obj && obj["entry"] && typeof obj["entry"] === "object") {
    const inner = obj["entry"] as Record<string, unknown>;
    if ("id" in inner && "note" in inner && "filePath" in inner) {
      return inner as unknown as ContextEntry;
    }
  }
  if ("id" in obj && "note" in obj && "filePath" in obj) {
    return obj as unknown as ContextEntry;
  }
  return undefined;
}
