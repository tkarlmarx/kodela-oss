// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 50 — Notion integration connector.
 *
 * Fetches the title of a Notion page given its ID and an integration token
 * stored in KODELA_NOTION_API_KEY.
 *
 * If the key is absent or the request fails the function returns null so the
 * caller can still store the URL without a title.
 */

const NOTION_API_VERSION = "2022-06-28";

/**
 * Extract the Notion page ID from a notion.so URL.
 *
 * Handles the canonical form:
 *   https://www.notion.so/<workspace>/<page-title>-<id32hex>
 *   https://notion.so/<id32hex>
 *   https://www.notion.so/<id32hex>
 *
 * The page ID in the Notion API is the 32-char hex string at the end of the URL
 * (possibly hyphenated as a UUID in the API path).
 *
 * Returns null when the URL cannot be parsed.
 */
export function extractNotionPageId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("notion.so")) return null;

    const pathname = parsed.pathname;
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;

    const last = segments[segments.length - 1];
    const hexMatch = last.match(/([0-9a-f]{32})$/i);
    if (hexMatch) {
      const raw = hexMatch[1];
      return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
    }

    const uuidMatch = last.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
    if (uuidMatch) return uuidMatch[1];

    return null;
  } catch {
    return null;
  }
}

type NotionRichText = { plain_text?: string };
type NotionProperty = {
  type: string;
  title?: NotionRichText[];
};

/**
 * Fetch the title of a Notion page from the API.
 *
 * @param pageId   The Notion page UUID.
 * @param apiKey   Integration token (KODELA_NOTION_API_KEY).
 * @returns        Page title string, or null on failure / missing key.
 */
export async function fetchNotionTitle(
  pageId: string,
  apiKey: string,
): Promise<string | null> {
  const url = `https://api.notion.com/v1/pages/${pageId}`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Notion-Version": NOTION_API_VERSION,
        Accept: "application/json",
      },
    });

    if (!res.ok) return null;

    const json = (await res.json()) as {
      properties?: Record<string, NotionProperty>;
    };

    const props = json.properties ?? {};
    for (const prop of Object.values(props)) {
      if (prop.type === "title" && prop.title && prop.title.length > 0) {
        const text = prop.title.map((t) => t.plain_text ?? "").join("");
        return text.trim() || null;
      }
    }

    return null;
  } catch {
    return null;
  }
}
