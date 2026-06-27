// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectSupervisorPlatform,
  formatInstallSupervisorResult,
  formatRemoveSupervisorResult,
  formatSupervisorStatus,
  installSupervisor,
  removeSupervisor,
  renderSupervisorFile,
  repoHash,
  supervisorLabel,
  supervisorServicePath,
  supervisorStatus,
  SUPERVISOR_LABEL_PREFIX,
  type SupervisorEnv,
  type SupervisorPlatform,
} from "./watch-supervisor.js";
import { deactivateSupervisorOnly } from "./watch-supervisor.js";

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kodela-supervisor-"));
  await fs.mkdir(path.join(dir, ".kodela"), { recursive: true });
  return dir;
}

async function makeHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "kodela-supervisor-home-"));
}

const TEST_BIN = "/usr/local/bin/kodela";

function envFor(
  platform: NodeJS.Platform,
  home: string,
): SupervisorEnv {
  return { platform, home, skipActivate: true };
}

describe("detectSupervisorPlatform", () => {
  test("maps darwin → launchd", () => {
    assert.equal(detectSupervisorPlatform("darwin"), "launchd");
  });
  test("maps linux → systemd", () => {
    assert.equal(detectSupervisorPlatform("linux"), "systemd");
  });
  test("maps win32 → schtasks", () => {
    assert.equal(detectSupervisorPlatform("win32"), "schtasks");
  });
  test("returns null for unsupported platforms", () => {
    assert.equal(detectSupervisorPlatform("freebsd"), null);
    assert.equal(detectSupervisorPlatform("aix"), null);
  });
});

describe("repoHash + supervisorLabel", () => {
  test("repoHash is stable for the same path", () => {
    const a = repoHash("/tmp/some/repo");
    const b = repoHash("/tmp/some/repo");
    assert.equal(a, b);
    assert.equal(a.length, 12);
  });
  test("repoHash differs for different paths", () => {
    assert.notEqual(repoHash("/tmp/a"), repoHash("/tmp/b"));
  });
  test("supervisorLabel uses prefix + hash", () => {
    const label = supervisorLabel("/tmp/x");
    assert.ok(label.startsWith(`${SUPERVISOR_LABEL_PREFIX}.`));
    assert.equal(label.split(".").length, 4); // dev.kodela.watcher.<hash>
  });
});

describe("supervisorServicePath", () => {
  test("launchd → ~/Library/LaunchAgents/<label>.plist", () => {
    const home = "/Users/dev";
    const repo = "/Users/dev/work/repo";
    const p = supervisorServicePath(repo, "launchd", { home });
    assert.equal(
      p,
      path.join(home, "Library", "LaunchAgents", `${supervisorLabel(repo)}.plist`),
    );
  });
  test("systemd → ~/.config/systemd/user/<label>.service", () => {
    const home = "/home/dev";
    const repo = "/home/dev/work/repo";
    const p = supervisorServicePath(repo, "systemd", { home });
    assert.equal(
      p,
      path.join(
        home,
        ".config",
        "systemd",
        "user",
        `${supervisorLabel(repo)}.service`,
      ),
    );
  });
  test("schtasks → <repo>/.kodela/supervisor-<label>.xml", () => {
    const repo = "/c/work/repo";
    const p = supervisorServicePath(repo, "schtasks", {});
    assert.equal(
      p,
      path.join(repo, ".kodela", `supervisor-${supervisorLabel(repo)}.xml`),
    );
  });
});

describe("renderSupervisorFile", () => {
  const baseOpts = {
    label: "dev.kodela.watcher.abcdef012345",
    binPath: "/usr/local/bin/kodela",
    args: ["--auto-annotate"],
    repoRoot: "/work/myrepo",
    logFile: "/work/myrepo/.kodela/watcher.log",
  };

  test("launchd plist contains label, binPath, repo, log, supervised env vars", () => {
    const out = renderSupervisorFile({ ...baseOpts, platform: "launchd" });
    assert.ok(out.startsWith("<?xml"));
    assert.ok(out.includes("<plist"));
    assert.ok(out.includes(`<string>${baseOpts.label}</string>`));
    assert.ok(out.includes(`<string>${baseOpts.binPath}</string>`));
    assert.ok(out.includes("<string>watch</string>"));
    assert.ok(out.includes("<string>--auto-annotate</string>"));
    assert.ok(out.includes(`<string>${baseOpts.repoRoot}</string>`));
    assert.ok(out.includes(`<string>${baseOpts.logFile}</string>`));
    // KeepAlive is what makes it auto-restart.
    assert.ok(/KeepAlive/.test(out));
    // Supervised marker env var must be set so the child knows.
    assert.ok(/KODELA_WATCHER_SUPERVISED/.test(out));
  });

  test("systemd unit contains [Service], ExecStart, Restart=always", () => {
    const out = renderSupervisorFile({ ...baseOpts, platform: "systemd" });
    assert.ok(out.includes("[Unit]"));
    assert.ok(out.includes("[Service]"));
    assert.ok(out.includes("[Install]"));
    assert.ok(out.includes(`ExecStart=${baseOpts.binPath} watch --auto-annotate`));
    assert.ok(/Restart=always/.test(out));
    assert.ok(out.includes(`WorkingDirectory=${baseOpts.repoRoot}`));
    assert.ok(/Environment=KODELA_WATCHER_SUPERVISED=1/.test(out));
    assert.ok(out.includes(`Environment=KODELA_WATCHER_REPO_ROOT=${baseOpts.repoRoot}`));
  });

  test("propagates custom env overrides to supervisor templates", () => {
    const out = renderSupervisorFile({
      ...baseOpts,
      platform: "systemd",
      envOverrides: {
        KODELA_AGENT: "continue",
        KODELA_GOAL: "stabilize attribution",
      },
    });

    assert.ok(out.includes("Environment=KODELA_AGENT=continue"));
    assert.ok(out.includes(`Environment="KODELA_GOAL=stabilize attribution"`));
  });

  test("systemd unit double-quotes paths that contain spaces", () => {
    const out = renderSupervisorFile({
      ...baseOpts,
      repoRoot: "/Users/Some User/my repo",
      logFile: "/Users/Some User/my repo/.kodela/watcher.log",
      platform: "systemd",
    });
    // WorkingDirectory must be quoted so systemd doesn't truncate at the space.
    assert.ok(out.includes(`WorkingDirectory="/Users/Some User/my repo"`));
    // Environment= must use the K=V-inside-quotes form, not bare K=V with a
    // space, because a bare value would silently terminate at whitespace.
    assert.ok(
      out.includes(
        `Environment="KODELA_WATCHER_REPO_ROOT=/Users/Some User/my repo"`,
      ),
    );
    // append: log paths with spaces must also be quoted.
    assert.ok(
      out.includes(
        `StandardOutput=append:"/Users/Some User/my repo/.kodela/watcher.log"`,
      ),
    );
  });

  test("schtasks XML contains Task root, Command, working directory", () => {
    const out = renderSupervisorFile({ ...baseOpts, platform: "schtasks" });
    assert.ok(out.startsWith("<?xml"));
    assert.ok(out.includes("<Task "));
    assert.ok(out.includes("<Exec>"));
    assert.ok(out.includes("<Command>") && out.includes(baseOpts.binPath));
    assert.ok(out.includes("<Arguments>"));
    assert.ok(out.includes("<WorkingDirectory>") && out.includes(baseOpts.repoRoot));
  });

  test("XML escaping is applied to args and paths in launchd output", () => {
    const out = renderSupervisorFile({
      ...baseOpts,
      platform: "launchd",
      args: ["--filter", "a&b<c>"],
    });
    assert.ok(out.includes("a&amp;b&lt;c&gt;"));
    assert.ok(!out.includes("a&b<c>"));
  });

  test("schtasks XML launches via cmd.exe and embeds KODELA_WATCHER_SUPERVISED env", () => {
    const out = renderSupervisorFile({ ...baseOpts, platform: "schtasks" });
    // Task Scheduler XML has no Environment field, so we must wrap in cmd /c.
    assert.ok(
      out.includes("<Command>cmd.exe</Command>"),
      "expected <Command>cmd.exe</Command> wrapper",
    );
    // The supervised-mode markers must appear inside <Arguments>, properly
    // XML-escaped.  Without these, runWatch() would not self-register PID/meta
    // when the supervisor launches it on Windows.
    assert.ok(
      /<Arguments>\/c set &quot;KODELA_WATCHER_SUPERVISED=1&quot;/.test(out),
      `expected /c set "KODELA_WATCHER_SUPERVISED=1" in <Arguments>; got: ${out}`,
    );
    assert.ok(
      out.includes(`set &quot;KODELA_WATCHER_REPO_ROOT=${baseOpts.repoRoot}&quot;`),
      "expected KODELA_WATCHER_REPO_ROOT setter in <Arguments>",
    );
    // The actual kodela invocation still appears, chained after the env
    // setters with `&&` (XML-escaped to &amp;&amp;).
    assert.ok(out.includes(`&amp;&amp; ${baseOpts.binPath} watch --auto-annotate`));
  });

  test("schtasks XML cmd /c wraps binPath with spaces in double quotes", () => {
    const out = renderSupervisorFile({
      ...baseOpts,
      platform: "schtasks",
      binPath: `C:\\Program Files\\kodela\\kodela.exe`,
    });
    // Inside <Arguments>, the bin path with spaces must be quoted so cmd.exe
    // doesn't split the executable from its args at the space.  The quotes
    // are XML-escaped to &quot; in the rendered output.
    assert.ok(
      out.includes(`&quot;C:\\Program Files\\kodela\\kodela.exe&quot; watch`),
      `expected quoted bin path in cmd /c args; got: ${out}`,
    );
  });
});

describe("installSupervisor", () => {
  let repo: string;
  let home: string;

  beforeEach(async () => {
    repo = await makeRepo();
    home = await makeHome();
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  test("returns 'unsupported' on platforms without a supervisor", async () => {
    const result = await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      env: { platform: "freebsd", home, skipActivate: true },
    });
    assert.equal(result.installed, false);
    assert.equal(result.platform, null);
    assert.match(result.reason, /not supported/i);
  });

  test("writes the launchd plist to the expected path on darwin", async () => {
    const result = await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      env: envFor("darwin", home),
    });
    assert.equal(result.installed, true);
    assert.equal(result.alreadyInstalled, false);
    assert.equal(result.platform, "launchd");
    const expectedPath = supervisorServicePath(repo, "launchd", { home });
    assert.equal(result.servicePath, expectedPath);
    const onDisk = await fs.readFile(expectedPath, "utf-8");
    assert.ok(onDisk.includes("<plist"));
    assert.ok(onDisk.includes(supervisorLabel(repo)));
  });

  test("writes the systemd unit to the expected path on linux", async () => {
    const result = await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      env: envFor("linux", home),
    });
    assert.equal(result.installed, true);
    assert.equal(result.platform, "systemd");
    const expectedPath = supervisorServicePath(repo, "systemd", { home });
    assert.equal(result.servicePath, expectedPath);
    const onDisk = await fs.readFile(expectedPath, "utf-8");
    assert.ok(onDisk.includes("[Service]"));
    assert.ok(/Restart=always/.test(onDisk));
  });

  test("writes the schtasks XML to <repo>/.kodela/ on win32", async () => {
    const result = await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      env: envFor("win32", home),
    });
    assert.equal(result.installed, true);
    assert.equal(result.platform, "schtasks");
    assert.ok(result.servicePath.startsWith(repo));
    const raw = await fs.readFile(result.servicePath);
    // schtasks expects UTF-16 LE with a BOM matching the XML declaration.
    assert.equal(raw[0], 0xff);
    assert.equal(raw[1], 0xfe);
    const onDisk = raw.subarray(2).toString("utf16le");
    assert.ok(onDisk.startsWith(`<?xml version="1.0" encoding="UTF-16"?>`));
    assert.ok(onDisk.includes("<Task "));
  });

  test("schtasks XML on-disk encoding declaration matches its byte encoding (UTF-16 LE + BOM)", async () => {
    const result = await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      env: envFor("win32", home),
    });
    const raw = await fs.readFile(result.servicePath);
    // Reading as utf-8 would mangle UTF-16 bytes, so the legacy utf-8 read
    // path must NOT recognize the XML declaration. This guards against a
    // regression where someone changes the writer back to utf-8 without
    // also updating the rendered declaration.
    const asUtf8 = raw.toString("utf-8");
    assert.ok(!asUtf8.startsWith(`<?xml`));
    // Reading as utf-16 LE (skipping BOM) DOES recognize it.
    const asUtf16 = raw.subarray(2).toString("utf16le");
    assert.match(asUtf16, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
    // And the body still parses out the expected schtasks elements.
    assert.ok(asUtf16.includes("<RegistrationInfo>"));
    assert.ok(asUtf16.includes("<LogonTrigger>"));
    assert.ok(asUtf16.includes("<Command>"));
  });

  test("re-running without --force returns alreadyInstalled and does not overwrite", async () => {
    const env = envFor("linux", home);
    await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      env,
    });
    const servicePath = supervisorServicePath(repo, "systemd", { home });
    const stat1 = await fs.stat(servicePath);

    // Touch ctime by waiting a hair, then re-run.
    await new Promise((r) => setTimeout(r, 10));
    const result2 = await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      env,
    });
    assert.equal(result2.installed, false);
    assert.equal(result2.alreadyInstalled, true);
    assert.match(result2.reason, /already installed/i);

    const stat2 = await fs.stat(servicePath);
    // mtimeMs must be unchanged because we did not rewrite the file.
    assert.equal(stat2.mtimeMs, stat1.mtimeMs);
  });

  test("re-running install on an existing supervisor reports alreadyInstalled (re-enable path)", async () => {
    // This guards the documented UX: after `kodela watch stop`, the unit
    // file remains on disk (deactivated), and re-running `kodela watch
    // --supervise` should re-enable it without --force.  Under the test
    // harness `skipActivate: true` is used, so we can't drive the real
    // service manager — but we do verify the API contract: file is
    // preserved, no rewrite happens, and the result clearly signals the
    // already-installed branch was taken.
    const env = envFor("darwin", home);
    const first = await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      env,
    });
    assert.equal(first.installed, true);
    assert.equal(first.alreadyInstalled, false);

    const servicePath = first.servicePath;
    const stat1 = await fs.stat(servicePath);
    await new Promise((r) => setTimeout(r, 10));

    const second = await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      env,
    });
    assert.equal(second.installed, false);
    assert.equal(second.alreadyInstalled, true);
    // The result must list a note that explicitly mentions activation
    // handling so operators know what happened on the re-supervise call.
    assert.ok(
      second.notes.some(
        (n) => /already exists/i.test(n) || /already active/i.test(n),
      ),
      `expected an "already exists/active" note; got ${JSON.stringify(second.notes)}`,
    );
    // mtime must NOT change — re-supervise must never silently rewrite the
    // file (that's the --force path).
    const stat2 = await fs.stat(servicePath);
    assert.equal(stat2.mtimeMs, stat1.mtimeMs);
  });

  test("re-running with --force overwrites the file", async () => {
    const env = envFor("linux", home);
    await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      env,
    });
    const servicePath = supervisorServicePath(repo, "systemd", { home });
    // Mutate the file so we can detect a rewrite.
    await fs.writeFile(servicePath, "GARBAGE\n", "utf-8");

    const result2 = await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      force: true,
      env,
    });
    assert.equal(result2.installed, true);
    assert.equal(result2.alreadyInstalled, false);

    const onDisk = await fs.readFile(servicePath, "utf-8");
    assert.ok(!onDisk.includes("GARBAGE"));
    assert.ok(onDisk.includes("[Service]"));
  });

  test("forwards extra args into the rendered file", async () => {
    const result = await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      extraArgs: ["--auto-annotate", "--debounce", "750"],
      env: envFor("linux", home),
    });
    const onDisk = await fs.readFile(result.servicePath, "utf-8");
    assert.ok(onDisk.includes("--auto-annotate"));
    assert.ok(onDisk.includes("--debounce"));
    assert.ok(onDisk.includes(" 750"));
  });
});

describe("removeSupervisor", () => {
  let repo: string;
  let home: string;
  beforeEach(async () => {
    repo = await makeRepo();
    home = await makeHome();
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  test("is a no-op when no supervisor file exists", async () => {
    const result = await removeSupervisor({
      repoRoot: repo,
      env: envFor("linux", home),
    });
    assert.equal(result.removed, false);
    assert.equal(result.alreadyRemoved, true);
    assert.match(result.reason, /not installed/i);
  });

  test("deletes an installed supervisor file", async () => {
    const env = envFor("linux", home);
    await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      env,
    });
    const servicePath = supervisorServicePath(repo, "systemd", { home });
    assert.equal(await pathExists(servicePath), true);

    const result = await removeSupervisor({ repoRoot: repo, env });
    assert.equal(result.removed, true);
    assert.equal(result.alreadyRemoved, false);
    assert.equal(await pathExists(servicePath), false);
  });
});

describe("supervisorStatus", () => {
  let repo: string;
  let home: string;
  beforeEach(async () => {
    repo = await makeRepo();
    home = await makeHome();
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  test("returns 'unsupported' on freebsd", async () => {
    const status = await supervisorStatus({
      repoRoot: repo,
      env: { platform: "freebsd", home, skipActivate: true },
    });
    assert.equal(status.state, "unsupported");
  });

  test("returns 'not-installed' when no file exists", async () => {
    const status = await supervisorStatus({
      repoRoot: repo,
      env: envFor("linux", home),
    });
    assert.equal(status.state, "not-installed");
  });

  test("returns 'installed-inactive' when file exists and probe is skipped", async () => {
    const env = envFor("darwin", home);
    await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      env,
    });
    const status = await supervisorStatus({ repoRoot: repo, env });
    assert.equal(status.state, "installed-inactive");
    if (status.state === "installed-inactive") {
      assert.equal(status.platform, "launchd");
      assert.ok(status.servicePath.includes("LaunchAgents"));
    }
  });
});

describe("deactivateSupervisorOnly", () => {
  let repo: string;
  let home: string;
  beforeEach(async () => {
    repo = await makeRepo();
    home = await makeHome();
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  test("returns alreadyInactive when no unit file exists", async () => {
    const r = await deactivateSupervisorOnly({
      repoRoot: repo,
      env: envFor("linux", home),
    });
    assert.equal(r.alreadyInactive, true);
    assert.equal(r.deactivated, false);
  });

  test("does not delete the unit file (deactivate-only)", async () => {
    const env = envFor("linux", home);
    await installSupervisor({
      repoRoot: repo,
      cliVersion: "0.1.0-test",
      binPath: TEST_BIN,
      env,
    });
    const servicePath = supervisorServicePath(repo, "systemd", { home });
    assert.equal(await pathExists(servicePath), true);

    const r = await deactivateSupervisorOnly({ repoRoot: repo, env });
    // skipActivate=true short-circuits the actual systemctl call.
    assert.equal(r.alreadyInactive, false);
    assert.equal(r.platform, "systemd");
    // Unit file must still be on disk.
    assert.equal(await pathExists(servicePath), true);
  });
});

describe("formatters", () => {
  test("formatSupervisorStatus surfaces each state cleanly", () => {
    for (const platform of ["launchd", "systemd", "schtasks"] as SupervisorPlatform[]) {
      const installed = formatSupervisorStatus({
        state: "installed-active",
        platform,
        servicePath: "/x/y/z",
        label: "lbl",
        detail: "loaded",
      });
      assert.match(installed, /Supervisor/);
      assert.match(installed, new RegExp(platform));
    }
    const none = formatSupervisorStatus({
      state: "not-installed",
      platform: "systemd",
      servicePath: "/x",
      label: "lbl",
    });
    assert.match(none, /not installed|Not installed/);
  });

  test("formatInstallSupervisorResult shows ✔ when installed AND activated", () => {
    const out = formatInstallSupervisorResult({
      installed: true,
      alreadyInstalled: false,
      activated: true,
      servicePath: "/x/y",
      label: "lbl",
      platform: "systemd",
      notes: ["Wrote /x/y", "systemctl --user enable --now succeeded"],
      reason: "Supervisor installed and activated (systemd).",
    });
    assert.match(out, /^✔/);
    assert.match(out, /Wrote \/x\/y/);
  });

  test("formatInstallSupervisorResult shows ⚠ when installed but activation deferred", () => {
    const out = formatInstallSupervisorResult({
      installed: true,
      alreadyInstalled: false,
      activated: false,
      servicePath: "/x/y",
      label: "lbl",
      platform: "systemd",
      notes: ["Wrote /x/y", "manual hint"],
      reason: "Supervisor file written (systemd); activation deferred — see notes.",
    });
    assert.match(out, /^⚠/);
    assert.match(out, /Wrote \/x\/y/);
  });

  test("formatRemoveSupervisorResult shows ● when nothing to remove", () => {
    const out = formatRemoveSupervisorResult({
      removed: false,
      alreadyRemoved: true,
      deactivated: false,
      servicePath: "/x",
      label: "lbl",
      platform: "systemd",
      notes: ["No supervisor file at /x"],
      reason: "Supervisor was not installed",
    });
    assert.match(out, /not installed|already/i);
  });
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
