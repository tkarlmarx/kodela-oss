// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 50 — Linear integration connector.
 *
 * Fetches the title (and optionally status) of a Linear issue given its
 * identifier (e.g. "ENG-1234") and a personal API key stored in the
 * KODELA_LINEAR_API_KEY environment variable.
 *
 * If the key is absent or the request fails the function returns null so the
 * caller can still store the URL without a title.
 */

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/**
 * Extract the Linear issue identifier from a linear.app URL.
 *
 * Handles both the modern short-form URL
 *   https://linear.app/<team>/issue/<TEAM>-<NUMBER>[/<slug>]
 * and bare identifiers (already in "ENG-1234" form).
 *
 * Returns null when the URL cannot be parsed.
 */
export function extractLinearIssueId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("linear.app")) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    const issueIdx = parts.findIndex((p) => p === "issue");
    if (issueIdx === -1) return null;
    const id = parts[issueIdx + 1];
    if (!id) return null;
    return id.toUpperCase();
  } catch {
    const match = url.match(/\b([A-Z]+-\d+)\b/);
    return match ? match[1] : null;
  }
}

/**
 * Fetch the title of a Linear issue from the GraphQL API.
 *
 * @param issueId   The Linear identifier, e.g. "ENG-1234".
 * @param apiKey    Personal API key (KODELA_LINEAR_API_KEY).
 * @returns         The issue title, or null on failure / missing key.
 */
export async function fetchLinearTitle(
  issueId: string,
  apiKey: string,
): Promise<string | null> {
  const query = `
    query IssueByIdentifier($id: String!) {
      issue(id: $id) {
        title
        identifier
      }
    }
  `;

  try {
    const res = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query, variables: { id: issueId } }),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      data?: { issue?: { title?: string; identifier?: string } };
    };

    const issue = json.data?.issue;
    if (!issue) return null;

    const prefix = issue.identifier ? `${issue.identifier}: ` : "";
    return issue.title ? `${prefix}${issue.title}` : null;
  } catch {
    return null;
  }
}
