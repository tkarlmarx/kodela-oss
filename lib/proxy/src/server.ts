// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import express from "express";
import cors from "cors";
import http from "node:http";
import { loadConfig } from "./config/loader.js";
import { createProxyHandler } from "./proxy/handler.js";
import { registerHealthRoutes } from "./utils/health.js";
import { logger } from "./utils/logger.js";
import { closeSession } from "./session/writer.js";
import fs from "node:fs/promises";
import path from "node:path";

const PORT_CANDIDATES = [4200, 4201, 4202, 4203];
const WIZARD_PATH = new URL("../setup/wizard.html", import.meta.url).pathname;

async function tryBind(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(port, host, () => {
      probe.close(() => resolve());
    });
    probe.on("error", reject);
  });
}

async function findPort(): Promise<number> {
  for (const port of PORT_CANDIDATES) {
    try {
      await tryBind("127.0.0.1", port);
      return port;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      logger.warn(`[kodela] port ${port} in use, trying next`);
    }
  }
  throw new Error(
    `No available port in range ${PORT_CANDIDATES[0]}–${PORT_CANDIDATES[PORT_CANDIDATES.length - 1]}. ` +
    `Stop other services using those ports or configure a different range.`,
  );
}

async function main(): Promise<void> {
  const config = await loadConfig();

  for (const p of config.providers) {
    const present = !!process.env[p.apiKeyEnvVar];
    logger.info(`[kodela] ${p.name} key: ${present ? "present" : "NOT FOUND"} (${p.apiKeyEnvVar})`);
  }

  const app = express();

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        try {
          const { hostname } = new URL(origin);
          const allowed = /^(localhost|127\.0\.0\.1|::1)$/.test(hostname);
          cb(null, allowed);
        } catch {
          cb(null, false);
        }
      },
    }),
  );

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true }));

  const boundPort = await findPort();

  const healthRouter = express.Router();
  registerHealthRoutes(healthRouter, config, boundPort);
  app.use("/", healthRouter);

  try {
    const wizardHtml = await fs.readFile(WIZARD_PATH, "utf-8");
    app.get("/setup", (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(wizardHtml);
    });
  } catch {
    app.get("/setup", (_req, res) => {
      res.send("<h1>Setup wizard not found</h1>");
    });
  }

  app.get("/setup/api/detect", (_req, res) => {
    res.json(detectTools(boundPort));
  });

  app.post("/setup/api/patch", async (req, res) => {
    const { tools } = req.body as { tools: string[] };
    const results = await patchTools(tools ?? [], boundPort);
    res.json({ results });
  });

  const proxyHandler = createProxyHandler(config);
  app.use(proxyHandler);

  const server = http.createServer(app);

  server.listen(boundPort, "127.0.0.1", () => {
    logger.info(`[kodela] proxy bound to localhost:${boundPort}`);
  });

  async function gracefulShutdown(signal: string): Promise<void> {
    logger.info(`[kodela] received ${signal}, shutting down`);
    await closeSession(config);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  }

  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
}

interface ToolDetectResult {
  name: string;
  detected: boolean;
  path: string;
  patch?: string;
}

function detectTools(boundPort: number): { tools: ToolDetectResult[]; boundPort: number; isReplit: boolean } {
  const isReplit = !!process.env["REPL_ID"];
  const home = process.env["HOME"] ?? "";

  const tools: ToolDetectResult[] = [
    {
      name: "Cursor",
      detected: !isReplit,
      path: path.join(home, ".cursor", "settings.json"),
      patch: `http://localhost:${boundPort}/v1`,
    },
    {
      name: "VS Code + Copilot",
      detected: !isReplit,
      path: path.join(home, ".vscode", "settings.json"),
      patch: `http://localhost:${boundPort}/v1`,
    },
    {
      name: "Claude Code",
      detected: !isReplit,
      path: path.join(home, ".claude", "settings.json"),
      patch: `http://localhost:${boundPort}`,
    },
    {
      name: "Replit",
      detected: isReplit,
      path: "REPL_ID detected",
    },
    {
      name: "Windsurf",
      detected: !isReplit,
      path: path.join(home, ".windsurf", "settings.json"),
      patch: `http://localhost:${boundPort}/v1`,
    },
  ];

  return { tools, boundPort, isReplit };
}

async function patchTools(
  toolNames: string[],
  boundPort: number,
): Promise<Record<string, "patched" | "skipped" | "no-op">> {
  const results: Record<string, "patched" | "skipped" | "no-op"> = {};
  const isReplit = !!process.env["REPL_ID"];

  for (const name of toolNames) {
    if (isReplit) {
      results[name] = "no-op";
      continue;
    }
    void boundPort;
    results[name] = "skipped";
  }

  return results;
}

main().catch((err: unknown) => {
  console.error("[kodela] fatal startup error:", err);
  process.exit(1);
});
