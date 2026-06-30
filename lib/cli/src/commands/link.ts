// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 50 — `kodela link` command.
 *
 * `kodela link <entryId> --ref <url>` adds or updates the `externalRef` on an
 * existing context entry.  Optionally fetches the issue/page title from the
 * provider API (Linear, Jira, Notion) using the relevant KODELA_*_API_KEY
 * environment variable.
 *
 * Usage:
 *   kodela link abc123 --ref https://linear.app/team/issue/ENG-1234
 *   kodela link abc123 --ref https://myco.atlassian.net/browse/PROJ-42
 *   kodela link abc123 --ref https://notion.so/page-title-aabbcc...
 */

import { readContextEntry, writeContextEntry } from "@kodela/core";
import type { ExternalRef } from "@kodela/core";
import { parseExternalRef, fetchExternalRefTitle } from "../integrations/index.js";

export type LinkOptions = {
  repoRoot: string;
  entryId: string;
  ref: string;
};

export type LinkResult = {
  entryId: string;
  filePath: string;
  externalRef: ExternalRef;
  titleFetched: boolean;
};

export async function runLink(opts: LinkOptions): Promise<LinkResult> {
  const { repoRoot, entryId, ref } = opts;

  const entry = await readContextEntry(repoRoot, entryId);

  const externalRef = parseExternalRef(ref);

  const title = await fetchExternalRefTitle(externalRef);
  if (title) {
    externalRef.title = title;
  }

  const updated = {
    ...entry,
    externalRef,
    updatedAt: new Date().toISOString(),
  };

  await writeContextEntry(repoRoot, updated);

  return {
    entryId: entry.id,
    filePath: entry.filePath,
    externalRef,
    titleFetched: Boolean(title),
  };
}

export function formatLinkResult(result: LinkResult): string {
  const ref = result.externalRef;
  const titleLine = ref.title ? `\n  Title:    ${ref.title}` : "";
  const keyFetched = result.titleFetched ? " (fetched from API)" : " (no API key — stored URL only)";
  return (
    `✓ Linked entry ${result.entryId}\n` +
    `  File:     ${result.filePath}\n` +
    `  Provider: ${ref.type}\n` +
    `  ID:       ${ref.id}\n` +
    `  URL:      ${ref.url}` +
    titleLine +
    (result.titleFetched ? `\n  Title${keyFetched}` : keyFetched.replace(" (", "\n  Note: ("))
  );
}
