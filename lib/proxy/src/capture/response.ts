// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
export function extractResponse(body: Record<string, unknown>): string {
  const choices = body["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const message = first["message"] as Record<string, unknown> | undefined;
    if (typeof message?.["content"] === "string") return message["content"];
    if (typeof first["text"] === "string") return first["text"];
  }

  const content = body["content"];
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as Record<string, unknown>;
    if (typeof first["text"] === "string") return first["text"];
  }

  return "";
}

export function assembleStreamChunks(chunks: string[], isAnthropic: boolean): string {
  if (isAnthropic) {
    return chunks.join("");
  }
  return chunks.join("");
}

export function extractChunkDelta(data: string, isAnthropic: boolean): string {
  try {
    const json = JSON.parse(data) as Record<string, unknown>;
    if (isAnthropic) {
      const delta = json["delta"] as Record<string, unknown> | undefined;
      if (typeof delta?.["text"] === "string") return delta["text"];
    } else {
      const choices = json["choices"];
      if (Array.isArray(choices) && choices.length > 0) {
        const first = choices[0] as Record<string, unknown>;
        const delta = first["delta"] as Record<string, unknown> | undefined;
        if (typeof delta?.["content"] === "string") return delta["content"];
      }
    }
  } catch {
  }
  return "";
}
