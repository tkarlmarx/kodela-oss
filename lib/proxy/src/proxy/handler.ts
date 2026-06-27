// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import type { Request, Response, NextFunction } from "express";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { extractModel, extractPrompt, extractToolSignature, isStreaming } from "../capture/request.js";
import { extractResponse } from "../capture/response.js";
import { captureGitContext } from "../capture/git.js";
import { resolveProvider, resolveApiKey } from "./router.js";
import { handleStream } from "./stream.js";
import { getOrCreateSession, appendExchange } from "../session/writer.js";
import type { ProxyConfig } from "../config/loader.js";
import { logger } from "../utils/logger.js";

const ALLOWED_ORIGINS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function validateOrigin(req: Request): boolean {
  const host = req.headers["host"] ?? "";
  const origin = req.headers["origin"] ?? "";

  if (!origin) return true;

  try {
    const parsed = new URL(origin);
    return ALLOWED_ORIGINS.test(parsed.host);
  } catch {
    return ALLOWED_ORIGINS.test(host);
  }
}

export function createProxyHandler(config: ProxyConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!validateOrigin(req)) {
      res.status(403).json({ error: "Forbidden: non-localhost origin" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const model = extractModel(body);

    if (!model) {
      next();
      return;
    }

    const provider = resolveProvider(model, config);
    const apiKey = resolveApiKey(provider);
    const { tool } = extractToolSignature(req, body, model);
    const prompt = extractPrompt(body);
    const streaming = isStreaming(body);

    const gitContext = await captureGitContext(process.cwd()).catch(() => ({
      branch: "unknown",
      commitSha: "unknown",
      commitMessage: "",
      author: "unknown",
      email: "",
      repoRoot: process.cwd(),
      isDirty: false,
      workingDir: process.cwd(),
      projectId: "",
    }));

    const session = await getOrCreateSession(gitContext, prompt, tool, model, config);

    const requestBodyStr = JSON.stringify(body);

    logger.info(
      `[kodela] → ${model} | ${prompt.length} chars prompt | ${provider.name}${streaming ? " | streaming" : ""}`,
    );

    const startTime = Date.now();

    const upstreamUrl = new URL(req.path, provider.baseUrl);
    upstreamUrl.search = new URL(req.url, "http://localhost").search;

    const reqHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (!key || key.toLowerCase() === "host") continue;
      if (Array.isArray(val)) {
        reqHeaders[key] = val.join(", ");
      } else if (val) {
        reqHeaders[key] = val;
      }
    }

    if (apiKey) {
      reqHeaders["Authorization"] = `Bearer ${apiKey}`;
    }

    reqHeaders["Content-Length"] = Buffer.byteLength(requestBodyStr).toString();
    reqHeaders["Content-Type"] = "application/json";
    reqHeaders["Accept"] = "application/json, text/event-stream";

    const transport = upstreamUrl.protocol === "https:" ? https : http;

    const upstreamReq = transport.request(
      {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
        path: upstreamUrl.pathname + (upstreamUrl.search || ""),
        method: req.method,
        headers: reqHeaders,
      },
      async (upstreamRes) => {
        const statusCode = upstreamRes.statusCode ?? 502;

        if (streaming && statusCode >= 200 && statusCode < 300) {
          const isAnthropic = provider.name === "anthropic";
          try {
            const { fullResponse, durationMs } = await handleStream(
              upstreamRes,
              res,
              isAnthropic,
              startTime,
            );

            setImmediate(() => {
              appendExchange(prompt, fullResponse, model, true, durationMs, requestBodyStr, fullResponse);
              logger.info(
                `[kodela] ← ${fullResponse.length} chars response | ${(durationMs / 1000).toFixed(1)}s | session ${session.id} | exchange ${session.exchangeCount + 1}`,
              );
            });
          } catch (err) {
            logger.error({ err }, "[kodela] stream error");
          }
          return;
        }

        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          const buf = Buffer.concat(chunks);
          const responseBodyStr = buf.toString("utf-8");

          res.status(statusCode);
          const ct = upstreamRes.headers["content-type"] ?? "application/json";
          res.setHeader("Content-Type", ct);
          for (const [k, v] of Object.entries(upstreamRes.headers)) {
            if (k.toLowerCase() === "content-encoding") continue;
            if (k.toLowerCase() === "transfer-encoding") continue;
            if (v !== undefined) res.setHeader(k, v);
          }
          res.send(buf);

          const durationMs = Date.now() - startTime;

          setImmediate(() => {
            try {
              const parsedResponse = JSON.parse(responseBodyStr) as Record<string, unknown>;
              const aiResponse = extractResponse(parsedResponse);
              appendExchange(prompt, aiResponse, model, false, durationMs, requestBodyStr, responseBodyStr);
              logger.info(
                `[kodela] ← ${aiResponse.length} chars response | ${(durationMs / 1000).toFixed(1)}s | session ${session.id} | exchange ${session.exchangeCount}`,
              );
            } catch {
              appendExchange(prompt, "", model, false, durationMs, requestBodyStr, responseBodyStr);
            }
          });
        });
        upstreamRes.on("error", (err) => {
          logger.error({ err }, "[kodela] upstream response error");
          if (!res.headersSent) res.status(502).json({ error: "Upstream error" });
        });
      },
    );

    upstreamReq.on("error", (err: NodeJS.ErrnoException) => {
      logger.error({ err }, "[kodela] upstream request error");
      if (!res.headersSent) res.status(502).json({ error: "Bad Gateway" });
    });

    upstreamReq.write(requestBodyStr);
    upstreamReq.end();
  };
}
