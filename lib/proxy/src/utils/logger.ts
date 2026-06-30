// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import pino from "pino";

const isProduction = process.env["NODE_ENV"] === "production";

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  redact: [
    "*.apiKey",
    "*.api_key",
    "*.authorization",
    "req.headers.authorization",
    "req.headers.cookie",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
