// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The Kodela Authors
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseRepoIdentity } from "./repoIdentity.js";

describe("parseRepoIdentity", () => {
  test("github.com HTTPS + SSH", () => {
    assert.deepEqual(parseRepoIdentity("https://github.com/acme/widgets.git"), {
      repoFullName: "acme/widgets",
      provider: "github",
    });
    assert.deepEqual(parseRepoIdentity("git@github.com:acme/widgets.git"), {
      repoFullName: "acme/widgets",
      provider: "github",
    });
    // no .git suffix
    assert.deepEqual(parseRepoIdentity("https://github.com/acme/widgets"), {
      repoFullName: "acme/widgets",
      provider: "github",
    });
  });

  test("gitlab.com", () => {
    assert.deepEqual(parseRepoIdentity("git@gitlab.com:team/app.git"), {
      repoFullName: "team/app",
      provider: "gitlab",
    });
  });

  test("self-hosted GitHub Enterprise / GitLab (host-agnostic)", () => {
    assert.deepEqual(parseRepoIdentity("https://github.mycorp.com/org/service.git"), {
      repoFullName: "org/service",
      provider: "github",
    });
    assert.deepEqual(parseRepoIdentity("git@gitlab.internal:group/proj.git"), {
      repoFullName: "group/proj",
      provider: "gitlab",
    });
    // ssh:// with a port, non-github/gitlab host → provider "local"
    assert.deepEqual(parseRepoIdentity("ssh://git@git.corp.example:2222/team/repo.git"), {
      repoFullName: "team/repo",
      provider: "local",
    });
  });

  test("proxied remote keeps the last two path segments", () => {
    assert.deepEqual(
      parseRepoIdentity("http://local_proxy@127.0.0.1:41729/git/acme/service"),
      { repoFullName: "acme/service", provider: "local" },
    );
  });

  test("returns null when owner/repo can't be recovered", () => {
    assert.equal(parseRepoIdentity(""), null);
    assert.equal(parseRepoIdentity("origin"), null);
    assert.equal(parseRepoIdentity("https://github.com/onlyowner"), null);
  });
});
