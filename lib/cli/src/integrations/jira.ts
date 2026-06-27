// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 50 — Jira integration connector.
 *
 * Fetches the summary (title) of a Jira issue given its key (e.g. "PROJ-123")
 * and credentials stored in KODELA_JIRA_API_KEY + KODELA_JIRA_BASE_URL.
 *
 * KODELA_JIRA_BASE_URL should be the base URL of your Jira instance, e.g.
 *   https://mycompany.atlassian.net
 *
 * The API key must be a Jira Cloud API token.  For server/DC, set it to a
 * Personal Access Token and the function falls back to Bearer auth.
 *
 * If any credential is absent or the request fails, the function returns null
 * so the caller can still store the URL without a title.
 */

/**
 * Extract the Jira issue key from an Atlassian URL.
 *
 * Handles:
 *   https://mycompany.atlassian.net/browse/PROJ-123
 *   https://jira.mycompany.com/browse/PROJ-123
 *   https://mycompany.atlassian.net/jira/software/projects/PROJ/issues/PROJ-123
 *
 * Also handles bare identifiers already in "PROJ-1234" form.
 *
 * Returns null when the URL cannot be parsed.
 */
export function extractJiraIssueKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;

    const browseMatch = pathname.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/i);
    if (browseMatch) return browseMatch[1].toUpperCase();

    const issuesMatch = pathname.match(/\/issues\/([A-Z][A-Z0-9_]+-\d+)/i);
    if (issuesMatch) return issuesMatch[1].toUpperCase();

    return null;
  } catch {
    const match = url.match(/\b([A-Z][A-Z0-9_]+-\d+)\b/);
    return match ? match[1].toUpperCase() : null;
  }
}

/**
 * Fetch the summary of a Jira issue via the REST API.
 *
 * @param issueKey   The Jira issue key, e.g. "PROJ-123".
 * @param baseUrl    Base URL of the Jira instance, e.g. "https://co.atlassian.net".
 * @param apiKey     Jira Cloud API token or Server PAT (KODELA_JIRA_API_KEY).
 * @param email      Jira Cloud account email (required for cloud Basic auth).
 *                   Omit for Server/DC Bearer auth.
 * @returns          "KEY: Summary text", or null on failure / missing creds.
 */
export async function fetchJiraTitle(
  issueKey: string,
  baseUrl: string,
  apiKey: string,
  email?: string,
): Promise<string | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${issueKey}?fields=summary`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (email) {
    headers["Authorization"] =
      "Basic " + Buffer.from(`${email}:${apiKey}`).toString("base64");
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      key?: string;
      fields?: { summary?: string };
    };

    const summary = json.fields?.summary;
    if (!summary) return null;

    const key = json.key ?? issueKey;
    return `${key}: ${summary}`;
  } catch {
    return null;
  }
}
