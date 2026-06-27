// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import type { Router, Request, Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { getActiveSession, closeSession } from "../session/writer.js";
import type { ProxyConfig } from "../config/loader.js";
import type { ProxySessionRecord } from "../session/schema.js";

const START_TIME = Date.now();
const VERSION = "1.0.0";

export function registerHealthRoutes(router: Router, config: ProxyConfig, boundPort: number): void {
  router.get("/health", (_req: Request, res: Response) => {
    const now = Date.now();
    const uptime = Math.floor((now - START_TIME) / 1000);
    res.json({
      status: "ok",
      version: VERSION,
      uptime,
      port: boundPort,
    });
  });

  router.get("/status", (_req: Request, res: Response) => {
    const session = getActiveSession();
    res.json({
      activeSession: session?.id ?? null,
      exchangeCount: session?.exchangeCount ?? 0,
    });
  });

  router.post("/kodela/session/end", async (_req: Request, res: Response) => {
    await closeSession(config);
    res.json({ ok: true });
  });

  router.get("/kodela/sessions", async (_req: Request, res: Response) => {
    const sessions = await listRecentSessions(config, 10);
    res.json({ sessions });
  });
}

async function listRecentSessions(config: ProxyConfig, limit: number): Promise<Partial<ProxySessionRecord>[]> {
  try {
    const dir = config.kodela.sessionsDir;
    const files = await fs.readdir(dir);
    const jsonFiles = files.filter((f) => f.endsWith(".json") && !f.includes(".mcp."));

    const sessions: Partial<ProxySessionRecord>[] = [];
    for (const file of jsonFiles.slice(-limit)) {
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf-8");
        const rec = JSON.parse(raw) as ProxySessionRecord;
        sessions.push({
          id: rec.id,
          startedAt: rec.startedAt,
          endedAt: rec.endedAt,
          exchangeCount: rec.exchangeCount,
          confidence: rec.confidence,
          actor: rec.actor,
          intent: {
            source: rec.intent.source,
            confidence: rec.intent.confidence,
            branchContext: rec.intent.branchContext,
          },
        });
      } catch {
      }
    }
    return sessions.reverse();
  } catch {
    return [];
  }
}
