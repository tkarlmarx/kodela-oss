// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
/**
 * Gap 50 — Integration connectors: unit tests.
 *
 * All tests exercise the URL-parsing / ID-extraction helpers only —
 * no network calls are made.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseExternalRef } from "./index.js";
import { extractLinearIssueId } from "./linear.js";
import { extractJiraIssueKey } from "./jira.js";
import { extractNotionPageId } from "./notion.js";

// ---------------------------------------------------------------------------
// parseExternalRef — provider detection
// ---------------------------------------------------------------------------

describe("parseExternalRef", () => {
  it("detects linear.app URLs", () => {
    const ref = parseExternalRef(
      "https://linear.app/myteam/issue/ENG-1234/add-retry-logic",
    );
    assert.equal(ref.type, "linear");
    assert.equal(ref.id, "ENG-1234");
    assert.equal(
      ref.url,
      "https://linear.app/myteam/issue/ENG-1234/add-retry-logic",
    );
  });

  it("detects jira atlassian.net browse URLs", () => {
    const ref = parseExternalRef(
      "https://mycompany.atlassian.net/browse/PROJ-42",
    );
    assert.equal(ref.type, "jira");
    assert.equal(ref.id, "PROJ-42");
  });

  it("detects jira software project issue URLs", () => {
    const ref = parseExternalRef(
      "https://mycompany.atlassian.net/jira/software/projects/ABC/issues/ABC-99",
    );
    assert.equal(ref.type, "jira");
    assert.equal(ref.id, "ABC-99");
  });

  it("detects notion.so URLs (32-char hex ID)", () => {
    const ref = parseExternalRef(
      "https://www.notion.so/My-Page-aabbccddeeff00112233445566778899",
    );
    assert.equal(ref.type, "notion");
    assert.equal(ref.id, "aabbccdd-eeff-0011-2233-445566778899");
  });

  it("detects notion.so URLs (UUID in path)", () => {
    const ref = parseExternalRef(
      "https://notion.so/aabbccdd-eeff-0011-2233-445566778899",
    );
    assert.equal(ref.type, "notion");
    assert.equal(ref.id, "aabbccdd-eeff-0011-2233-445566778899");
  });

  it("detects confluence URLs", () => {
    const ref = parseExternalRef(
      "https://mycompany.atlassian.net/wiki/spaces/TEAM/pages/123456/My+Page",
    );
    assert.equal(ref.type, "confluence");
    assert.ok(ref.url.includes("atlassian.net"));
  });

  it("falls back to 'url' for arbitrary HTTPS URLs", () => {
    const ref = parseExternalRef("https://example.com/some/path");
    assert.equal(ref.type, "url");
    assert.equal(ref.id, "https://example.com/some/path");
    assert.equal(ref.url, "https://example.com/some/path");
  });

  it("throws on an invalid URL string", () => {
    assert.throws(
      () => parseExternalRef("not a url"),
      /Invalid URL/,
    );
  });

  it("does not set title initially (no API call)", () => {
    const ref = parseExternalRef("https://linear.app/team/issue/ENG-1/x");
    assert.equal(ref.title, undefined);
  });
});

// ---------------------------------------------------------------------------
// extractLinearIssueId
// ---------------------------------------------------------------------------

describe("extractLinearIssueId", () => {
  it("extracts from canonical issue URL", () => {
    assert.equal(
      extractLinearIssueId(
        "https://linear.app/myteam/issue/ENG-1234/fix-payments",
      ),
      "ENG-1234",
    );
  });

  it("extracts bare identifier from URL with no slug", () => {
    assert.equal(
      extractLinearIssueId("https://linear.app/myteam/issue/BACK-7"),
      "BACK-7",
    );
  });

  it("returns null for non-linear URL", () => {
    assert.equal(
      extractLinearIssueId("https://github.com/owner/repo"),
      null,
    );
  });

  it("returns null when there is no issue segment", () => {
    assert.equal(
      extractLinearIssueId("https://linear.app/myteam"),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// extractJiraIssueKey
// ---------------------------------------------------------------------------

describe("extractJiraIssueKey", () => {
  it("extracts from /browse/ URL", () => {
    assert.equal(
      extractJiraIssueKey("https://myco.atlassian.net/browse/PROJ-123"),
      "PROJ-123",
    );
  });

  it("extracts from /issues/ URL", () => {
    assert.equal(
      extractJiraIssueKey(
        "https://myco.atlassian.net/jira/software/projects/MYPROJ/issues/MYPROJ-456",
      ),
      "MYPROJ-456",
    );
  });

  it("returns null for non-Jira URL", () => {
    assert.equal(
      extractJiraIssueKey("https://github.com/org/repo"),
      null,
    );
  });

  it("normalizes to uppercase", () => {
    assert.equal(
      extractJiraIssueKey("https://myco.atlassian.net/browse/proj-7"),
      "PROJ-7",
    );
  });
});

// ---------------------------------------------------------------------------
// extractNotionPageId
// ---------------------------------------------------------------------------

describe("extractNotionPageId", () => {
  it("extracts 32-char hex ID from page slug URL", () => {
    const id = extractNotionPageId(
      "https://www.notion.so/My-Document-aabbccddeeff00112233445566778899",
    );
    assert.equal(id, "aabbccdd-eeff-0011-2233-445566778899");
  });

  it("extracts UUID from direct UUID URL", () => {
    const id = extractNotionPageId(
      "https://notion.so/aabbccdd-eeff-0011-2233-445566778899",
    );
    assert.equal(id, "aabbccdd-eeff-0011-2233-445566778899");
  });

  it("returns null for non-notion URL", () => {
    assert.equal(
      extractNotionPageId("https://docs.google.com/page"),
      null,
    );
  });

  it("returns null for notion URL with no recognizable ID", () => {
    assert.equal(extractNotionPageId("https://notion.so/"), null);
  });
});
