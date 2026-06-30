// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import type { Response } from "express";
import type { IncomingMessage } from "node:http";
import { extractChunkDelta } from "../capture/response.js";

export interface StreamResult {
  fullResponse: string;
  durationMs: number;
}

export async function handleStream(
  upstreamRes: IncomingMessage,
  clientRes: Response,
  isAnthropic: boolean,
  startTime: number,
): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let buffer = "";

    clientRes.setHeader("Content-Type", "text/event-stream");
    clientRes.setHeader("Cache-Control", "no-cache");
    clientRes.setHeader("Connection", "keep-alive");

    upstreamRes.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      clientRes.write(text);

      buffer += text;

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        if (!data) continue;

        const delta = extractChunkDelta(data, isAnthropic);
        if (delta) chunks.push(delta);
      }
    });

    upstreamRes.on("end", () => {
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data:")) {
          const data = trimmed.slice(5).trim();
          if (data && data !== "[DONE]") {
            const delta = extractChunkDelta(data, isAnthropic);
            if (delta) chunks.push(delta);
          }
        }
      }

      clientRes.end();
      resolve({
        fullResponse: chunks.join(""),
        durationMs: Date.now() - startTime,
      });
    });

    upstreamRes.on("error", (err) => {
      reject(err);
    });
  });
}
