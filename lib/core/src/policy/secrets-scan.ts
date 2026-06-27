// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
/**
 * Pre-egress secrets scan — Phase 5 of doc 23.
 *
 * Single function: `scanForSecrets(payload) -> { matches }`. Called at every
 * point where capture data is about to leave the host process (annotate,
 * record_decision, session_end, synthesis write).
 *
 * Approach:
 *   1. **Vendor-pattern regex.** Tight regex with provider prefixes — `sk-ant-`,
 *      `AKIA`, `ghp_`, etc.  Very low false-positive rate; these prefixes are
 *      reserved per the vendor's public spec.
 *   2. **Generic-pattern + entropy filter.**  Detect any high-entropy
 *      base64-ish string that isn't already a known vendor key.  Entropy
 *      threshold avoids flagging UUIDs, hex hashes, and ordinary words.
 *
 * We deliberately do NOT use machine learning here (doc 23 §5.1 mentions an
 * ML classifier — that's a Phase 5.x follow-up). The regex+entropy combo
 * catches the 6 vendor prefixes in doc 23 §5.3 plus a generic floor.
 *
 * No external deps — the secrets scanner runs on every capture call so it
 * must be cheap and bundle-friendly.
 */

export type SecretMatchKind =
  | "aws_access_key_id"
  | "aws_secret_access_key"
  | "anthropic_api_key"
  | "openai_api_key"
  | "github_pat"
  | "github_oauth"
  | "stripe_live_key"
  | "stripe_test_key"
  | "jwt"
  | "generic_high_entropy";

export interface SecretMatch {
  kind: SecretMatchKind;
  /** The matched substring (truncated to 6 chars + "..." for the report). */
  fingerprint: string;
  /** Field name where the secret was found (if scanning a structured payload). */
  field?: string;
}

interface VendorPattern {
  kind: SecretMatchKind;
  // Tight regex anchored at the vendor prefix; deliberately avoids word
  // boundaries so JSON-embedded strings still match.
  pattern: RegExp;
}

const VENDOR_PATTERNS: VendorPattern[] = [
  // AWS — `AKIA` (long-term) or `ASIA` (session). 16 chars + base32-ish.
  { kind: "aws_access_key_id", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // AWS secret keys — 40-char base64-ish. Match only with the `AWS_SECRET_ACCESS_KEY` context to keep FP low.
  { kind: "aws_secret_access_key", pattern: /AWS_SECRET_ACCESS_KEY\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/g },
  // Anthropic — public `sk-ant-` prefix, very long body.
  { kind: "anthropic_api_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // OpenAI — `sk-` followed by ≥40 chars of base62. Avoid colliding with `sk-ant-` (matched first).
  { kind: "openai_api_key", pattern: /\bsk-(?!ant-)[A-Za-z0-9]{40,}\b/g },
  // GitHub fine-grained PAT — `github_pat_` + 82 chars.
  { kind: "github_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  // GitHub OAuth — `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` + 36+ chars.
  { kind: "github_oauth", pattern: /\bgh[posur]_[A-Za-z0-9]{36,255}\b/g },
  // Stripe — live (sk_live_) and test (sk_test_) keys.
  { kind: "stripe_live_key", pattern: /\bsk_live_[A-Za-z0-9]{24,}\b/g },
  { kind: "stripe_test_key", pattern: /\bsk_test_[A-Za-z0-9]{24,}\b/g },
  // JWT — three base64url segments separated by dots, the first starting `eyJ`.
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

/**
 * Shannon entropy in bits-per-character. Used to flag generic high-entropy
 * strings that escaped the vendor-prefix patterns. A typical English word
 * scores ~3 bits/char; a base64-encoded random 32-byte secret scores ~5.5+.
 */
function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const GENERIC_ENTROPY_THRESHOLD = 4.5;
const GENERIC_MIN_LENGTH = 30;

// Token-like substrings we'll consider for generic-entropy check. Skips
// runs that look like sentences (have spaces) or are too short to be a
// realistic secret.
const TOKEN_CANDIDATE = /[A-Za-z0-9+/=_-]{30,}/g;

function fingerprintOf(secret: string): string {
  if (secret.length <= 8) return `${secret[0]}…${secret[secret.length - 1]}`;
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

/** Scan a single string for secrets. Returns every matched span. */
export function scanString(value: string, field?: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const seen = new Set<string>(); // dedup by (kind, fingerprint, field)

  // Pass 1: vendor patterns (high precision).
  const vendorHits = new Set<string>(); // ranges already flagged, used to skip generic pass
  for (const { kind, pattern } of VENDOR_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of value.matchAll(pattern)) {
      const fingerprint = fingerprintOf(m[0]);
      const key = `${kind}|${fingerprint}|${field ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ kind, fingerprint, field });
      vendorHits.add(m[0]);
    }
  }

  // Pass 2: generic high-entropy.
  for (const m of value.matchAll(TOKEN_CANDIDATE)) {
    const candidate = m[0];
    if (vendorHits.has(candidate)) continue;
    // Skip very low-entropy tokens (UUIDs are ~3.4 bits/char even though they're 30+ chars).
    if (shannonEntropy(candidate) < GENERIC_ENTROPY_THRESHOLD) continue;
    if (candidate.length < GENERIC_MIN_LENGTH) continue;
    const fingerprint = fingerprintOf(candidate);
    const key = `generic_high_entropy|${fingerprint}|${field ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ kind: "generic_high_entropy", fingerprint, field });
  }

  return matches;
}

/**
 * Scan a structured payload — every string-valued field is scanned, including
 * nested objects. Arrays are scanned element-wise. Non-string leaves are
 * ignored. Returns the union of matches across all fields.
 */
export function scanForSecrets(payload: unknown, fieldPath = ""): SecretMatch[] {
  if (typeof payload === "string") return scanString(payload, fieldPath || undefined);
  if (Array.isArray(payload)) {
    const out: SecretMatch[] = [];
    payload.forEach((item, i) => {
      out.push(...scanForSecrets(item, fieldPath ? `${fieldPath}[${i}]` : `[${i}]`));
    });
    return out;
  }
  if (payload !== null && typeof payload === "object") {
    const out: SecretMatch[] = [];
    for (const [k, v] of Object.entries(payload)) {
      out.push(...scanForSecrets(v, fieldPath ? `${fieldPath}.${k}` : k));
    }
    return out;
  }
  return [];
}

/** True when the payload contains at least one secret match. Convenience wrapper. */
export function containsSecrets(payload: unknown): boolean {
  return scanForSecrets(payload).length > 0;
}
