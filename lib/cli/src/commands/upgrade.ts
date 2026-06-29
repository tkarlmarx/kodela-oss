// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * `kodela upgrade` — start a self-serve paid-tier checkout (BR-MON-1).
 *
 * Community-side only: this contains NO billing secrets and makes NO Stripe
 * calls. It resolves the local org id, asks the Kodela billing service to open a
 * Stripe Checkout Session (`POST $KODELA_BILLING_URL/checkout`), and opens the
 * returned URL in the browser. If no billing service is configured (or it's
 * unreachable), it falls back to the public pricing page with the org pre-filled.
 *
 * The org id is persisted locally so the same org is used across upgrades and
 * matches the license issued by the webhook after payment.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadLicense } from "@kodela/core";

export interface UpgradeOptions {
  repoRoot: string;
  plan?: string;
  email?: string;
  billingUrl?: string;
  /** Print the URL but do not launch a browser. */
  print?: boolean;
  /** Test injection. */
  deps?: Partial<UpgradeDeps>;
}

export interface UpgradeDeps {
  fetchImpl: typeof fetch;
  openImpl: (url: string) => boolean;
  loadLicenseImpl: () => Promise<{ orgId?: string } | null>;
  resolveOrgId: (repoRoot: string) => string;
}

export interface UpgradeResult {
  orgId: string;
  plan: string;
  url: string;
  source: "checkout-session" | "pricing-page";
  opened: boolean;
  note?: string;
}

/** Resolve a stable org id: license → env → persisted local file → generate+persist. */
export function defaultResolveOrgId(repoRoot: string): string {
  if (process.env["KODELA_ORG_ID"]) return process.env["KODELA_ORG_ID"]!;
  const file = path.join(repoRoot, ".kodela", "billing.json");
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, "utf8")) as { orgId?: string };
      if (j.orgId) return j.orgId;
    }
  } catch {
    /* fall through to generate */
  }
  const orgId = `org_${randomUUID()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ orgId }, null, 2) + "\n");
  } catch {
    /* best effort */
  }
  return orgId;
}

function defaultOpen(url: string): boolean {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

export async function runUpgrade(opts: UpgradeOptions): Promise<UpgradeResult> {
  const deps: UpgradeDeps = {
    fetchImpl: opts.deps?.fetchImpl ?? (fetch as typeof fetch),
    openImpl: opts.deps?.openImpl ?? defaultOpen,
    loadLicenseImpl: opts.deps?.loadLicenseImpl ?? (loadLicense as () => Promise<{ orgId?: string } | null>),
    resolveOrgId: opts.deps?.resolveOrgId ?? defaultResolveOrgId,
  };
  const plan = opts.plan ?? "pro";
  const license = await deps.loadLicenseImpl().catch(() => null);
  const orgId = license?.orgId || deps.resolveOrgId(opts.repoRoot);
  const billingUrl = (opts.billingUrl ?? process.env["KODELA_BILLING_URL"] ?? "").replace(/\/$/, "");

  let url = "";
  let source: UpgradeResult["source"] = "pricing-page";
  let note: string | undefined;

  if (billingUrl) {
    try {
      const res = await deps.fetchImpl(`${billingUrl}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, plan, email: opts.email }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (res.ok && data.url) {
        url = data.url;
        source = "checkout-session";
      } else {
        note = `billing service declined (${res.status}): ${data.error ?? "no url"} — falling back to pricing page`;
      }
    } catch (err) {
      note = `billing service unreachable (${err instanceof Error ? err.message : String(err)}) — falling back to pricing page`;
    }
  }

  if (!url) {
    const base = (process.env["KODELA_UPGRADE_URL"] ?? "https://kodela.dev/pricing").replace(/\/$/, "");
    url = `${base}?org=${encodeURIComponent(orgId)}&plan=${encodeURIComponent(plan)}`;
  }

  const opened = opts.print ? false : deps.openImpl(url);
  return { orgId, plan, url, source, opened, note };
}
