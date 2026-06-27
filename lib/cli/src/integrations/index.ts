// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 50 — Integration hub for external "why" stores.
 *
 * Provides two public functions:
 *
 *   parseExternalRef(url) → ExternalRef (no network call)
 *     Detects the provider from the URL and extracts the native ID.
 *
 *   fetchExternalRefTitle(ref) → Promise<string | null>  (network call)
 *     Uses the appropriate connector + env API key to fetch the issue/page
 *     title.  Returns null when the key is absent or the request fails so
 *     callers can always store the URL even without a title.
 */

import type { ExternalRef } from "@kodela/core";
import { extractLinearIssueId, fetchLinearTitle } from "./linear.js";
import { extractJiraIssueKey, fetchJiraTitle } from "./jira.js";
import { extractNotionPageId, fetchNotionTitle } from "./notion.js";

/**
 * Parse a URL into an `ExternalRef` object.
 *
 * Provider detection rules:
 *   - linear.app                  → "linear"
 *   - *.atlassian.net or /browse/ → "jira"
 *   - notion.so                   → "notion"
 *   - confluence (atlassian.net/wiki or /confluence/ path) → "confluence"
 *   - any other URL               → "url"
 *
 * Throws when `url` is not a valid URL string.
 */
export function parseExternalRef(url: string): ExternalRef {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const { hostname, pathname } = parsed;

  if (hostname.includes("linear.app")) {
    const id = extractLinearIssueId(url) ?? url;
    return { type: "linear", id, url };
  }

  if (
    hostname.includes("atlassian.net") &&
    (pathname.includes("/wiki") || pathname.includes("/confluence"))
  ) {
    const segments = pathname.split("/").filter(Boolean);
    const id = segments[segments.length - 1] || url;
    return { type: "confluence", id, url };
  }

  if (
    hostname.includes("atlassian.net") ||
    pathname.includes("/browse/") ||
    pathname.includes("/jira/")
  ) {
    const id = extractJiraIssueKey(url) ?? url;
    return { type: "jira", id, url };
  }

  if (hostname.includes("notion.so")) {
    const id = extractNotionPageId(url) ?? url;
    return { type: "notion", id, url };
  }

  return { type: "url", id: url, url };
}

/**
 * Attempt to fetch the human-readable title for an `ExternalRef`.
 *
 * Reads API credentials from environment variables — no key means no
 * network call; the function returns null immediately without throwing.
 *
 * Environment variables used:
 *   KODELA_LINEAR_API_KEY           — Linear personal API key
 *   KODELA_JIRA_API_KEY             — Jira Cloud API token or Server PAT
 *   KODELA_JIRA_BASE_URL            — Base URL of your Jira instance
 *   KODELA_JIRA_EMAIL               — Jira Cloud account email (for Basic auth)
 *   KODELA_NOTION_API_KEY           — Notion integration secret
 */
export async function fetchExternalRefTitle(
  ref: ExternalRef,
): Promise<string | null> {
  switch (ref.type) {
    case "linear": {
      const key = process.env["KODELA_LINEAR_API_KEY"];
      if (!key) return null;
      return fetchLinearTitle(ref.id, key);
    }

    case "jira": {
      const key = process.env["KODELA_JIRA_API_KEY"];
      const baseUrl = process.env["KODELA_JIRA_BASE_URL"];
      if (!key || !baseUrl) return null;
      const email = process.env["KODELA_JIRA_EMAIL"];
      return fetchJiraTitle(ref.id, baseUrl, key, email);
    }

    case "notion": {
      const key = process.env["KODELA_NOTION_API_KEY"];
      if (!key) return null;
      return fetchNotionTitle(ref.id, key);
    }

    case "confluence":
    case "url":
      return null;
  }
}
