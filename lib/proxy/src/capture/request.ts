// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { IncomingMessage } from "node:http";

export function extractModel(body: Record<string, unknown>): string {
  if (typeof body["model"] === "string") return body["model"];
  return "";
}

export function extractPrompt(body: Record<string, unknown>): string {
  const messages = body["messages"];
  if (Array.isArray(messages)) {
    const userMessages = messages
      .filter((m: unknown) => (m as Record<string, unknown>)["role"] === "user")
      .map((m: unknown) => {
        const msg = m as Record<string, unknown>;
        const content = msg["content"];
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content
            .filter((c: unknown) => (c as Record<string, unknown>)["type"] === "text")
            .map((c: unknown) => (c as Record<string, unknown>)["text"] as string)
            .join(" ");
        }
        return "";
      });
    return userMessages[userMessages.length - 1] ?? "";
  }
  if (typeof body["prompt"] === "string") return body["prompt"];
  return "";
}

export function extractToolSignature(
  req: IncomingMessage,
  body: Record<string, unknown>,
  model: string,
): { tool: string; model: string } {
  const ua = (req.headers["user-agent"] ?? "").toLowerCase();
  const explicitTool = req.headers["x-kodela-tool"];
  const reqPath = req.url ?? "";

  if (typeof explicitTool === "string" && explicitTool) {
    return { tool: explicitTool, model };
  }

  if (ua.includes("cursor")) return { tool: "cursor", model };
  if (ua.includes("claude-code") || ua.includes("claude_code")) return { tool: "claude-code", model };
  if (ua.includes("windsurf")) return { tool: "windsurf", model };
  if (ua.includes("vscode") || ua.includes("copilot")) return { tool: "vscode", model };

  if (reqPath.startsWith("/v1/messages")) return { tool: "anthropic-sdk", model };
  if (reqPath.startsWith("/v1/chat/completions")) return { tool: "openai-sdk", model };

  if (model.startsWith("claude-")) return { tool: "claude-code", model };
  if (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-")) {
    return { tool: "openai-sdk", model };
  }

  const replId = process.env["REPL_ID"];
  if (replId) return { tool: "replit", model };

  return { tool: "unknown", model };
}

export function isStreaming(body: Record<string, unknown>): boolean {
  return body["stream"] === true;
}
